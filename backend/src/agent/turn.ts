// backend/src/agent/turn.ts
// AR-TURN — 에이전트 턴 오케스트레이션(TRD §6.1 step3).
//
// runAgentTurn(post, session, humanMessage, lang):
//   1) AGENT_REPLY Message(authorId=null, status PENDING, seq, replyToId=humanMessage.id) 생성
//      → message.created publish.
//   2) 세션 RUNNING 전이 → session.status publish.
//   3) runtime.send(session, input, lang, onToken): 토큰 delta 마다 reply body 누적 +
//      agent.token{messageId, seq, delta} publish.
//   4) 완료 시 status COMPLETE(에러 시 FAILED) + 최종 body 영속화 → message.updated publish.
//      에러면 SYSTEM 버블(TRD §11)도 추가 — 키는 절대 노출하지 않는다.
//   5) 세션 IDLE 복귀 → session.status publish.
//
// 보안(CLAUDE.md/TRD §8): agent.token delta 는 에이전트 텍스트만. apiKey/baseURL 절대 미포함.
//   런타임 에러 메시지는 일반 문구만 SYSTEM 버블에 담는다(원문/키 미노출).

import type { Post, AgentSession, Message } from '@prisma/client';
import { prisma } from '../db.js';
import { nextSeq } from '../domain/seq.js';
import { getAgentRuntime } from './runtime.js';
import { runToolIntent } from './toolBridge.js';
import { withSandboxLock } from './sandboxLock.js';
import { resolveSandboxDir, getSandboxConcurrent } from '../sandbox/service.js';
import { publishToPost } from '../realtime/publish.js';
import {
  makeMessageCreatedEvent,
  makeAgentTokenEvent,
  makeMessageUpdatedEvent,
  makeSessionStatusEvent,
} from '../realtime/events.js';

/** AGENT_REPLY 생성 시 사용할 입력 시드(사람 메시지 본문). */
export interface RunAgentTurnArgs {
  post: Pick<Post, 'id'>;
  session: Pick<AgentSession, 'id' | 'sandboxId'>;
  humanMessage?: Pick<Message, 'id' | 'body'>;
  /** humanMessage 가 없는 자동 인트로 턴에서 런타임에 먹일 입력 텍스트. */
  prompt?: string;
  lang: string;
  /**
   * Feature A(비전): 사람 메시지에 첨부된 이미지의 해석된 호스트 절대경로 + MIME.
   * 있으면 런타임 send 에 동봉되어 워커가 OpenAI multimodal content 로 이미지를 본다.
   * absPath 는 호출부(messages.ts/imageRef)가 업로드 디렉토리 내부로 검증한 경로다.
   */
  image?: { absPath: string; mime: string };
  /** Feature B: per-message reasoning_effort('low'|'medium'|'high'). 값 있을 때만 전달. */
  reasoningEffort?: string;
}

/**
 * 한 에이전트 턴을 실행한다(스트리밍). HTTP 응답을 막지 않도록 호출부에서 await 없이 띄운다.
 * 예외는 내부에서 흡수해 AGENT_REPLY=FAILED + SYSTEM 버블로 표면화한다(throw 하지 않음).
 */
export async function runAgentTurn(args: RunAgentTurnArgs): Promise<void> {
  // v2 AR-MUX(구현 완료): 샌드박스 meta 의 concurrentTurns(getSandboxConcurrent)가 true 면 send 에
  //   concurrent=true 를 넘겨 turnId 멀티플렉싱 병렬 경로(같은 샌드박스 N개 동시 inflight, 토큰 인터리브)로
  //   분기한다. false/미지정이면 오늘과 100% 동일한 FIFO 단일 활성 턴 직렬 경로. 부수효과(도구)는 두 경로
  //   모두 withSandboxLock 으로 직렬(XC-SERIAL) — 병렬화되는 것은 추론/토큰뿐. concurrent 판정은 아래에서.
  const { post, session, lang } = args;
  // 사람 메시지가 있으면 그 본문을, 없으면 prompt 를 입력으로 쓴다(자동 인트로 턴).
  const input = args.humanMessage?.body ?? args.prompt ?? '';
  const replyToId = args.humanMessage?.id ?? null;
  const runtime = getAgentRuntime();

  // ── 1) AGENT_REPLY(PENDING) 생성 + message.created ──
  const reply = await prisma.$transaction(async (tx) => {
    const seq = await nextSeq(tx, post.id);
    return tx.message.create({
      data: {
        postId: post.id,
        sessionId: session.id,
        authorId: null,
        type: 'AGENT_REPLY',
        status: 'PENDING',
        body: '',
        replyToId,
        seq,
      },
    });
  });

  publishToPost(
    post.id,
    makeMessageCreatedEvent({
      id: reply.id,
      type: 'AGENT_REPLY',
      status: 'PENDING',
      body: '',
      authorId: null,
      seq: reply.seq,
      replyToId: reply.replyToId,
      toolCallId: reply.toolCallId,
      createdAt: reply.createdAt,
    }),
  );

  // ── 2) 세션 RUNNING ──
  await prisma.agentSession.update({
    where: { id: session.id },
    data: { status: 'RUNNING' },
  });
  publishToPost(
    post.id,
    makeSessionStatusEvent({ sessionId: session.id, status: 'RUNNING' }),
  );

  // ── 3) 스트리밍: 토큰 delta 누적 + agent.token publish ──
  let accumulated = '';
  let firstToken = true;
  // 인터럽트(별도 요청)가 부분 본문을 보존할 수 있도록 누적 본문을 DB 에 점진 영속화한다.
  //   - onToken 은 동기 콜백이므로 fire-and-forget 으로 기록하되, 겹치는 쓰기를 막는 가드를 둔다.
  //   - 마지막 토큰까지 반영되도록, 진행 중 쓰기가 끝나면 더 새로운 본문이 있을 때 한 번 더 쓴다.
  //   - 최종 확정(status/본문)은 step4 에서 한 번 더 수행한다(이 점진 쓰기는 body 만 갱신).
  let persisting = false;
  let pendingPersist = false;
  const persistAccumulated = (): void => {
    if (persisting) {
      pendingPersist = true;
      return;
    }
    persisting = true;
    const snapshot = accumulated;
    void prisma.message
      .update({ where: { id: reply.id }, data: { body: snapshot } })
      .catch(() => {
        /* 점진 영속화 실패는 무해 — step4 최종 쓰기가 본문을 다시 확정한다. */
      })
      .finally(() => {
        persisting = false;
        if (pendingPersist) {
          pendingPersist = false;
          // 진행 중 더 들어온 토큰을 반영하기 위해 한 번 더 기록.
          persistAccumulated();
        }
      });
  };
  const onToken = (delta: string): void => {
    accumulated += delta;
    // 첫 토큰에서 PENDING→STREAMING 으로 표면화(클라 타이핑 시작).
    if (firstToken) {
      firstToken = false;
      // status 전이는 message.updated 로도 알리지만, 누적 본문 확정은 done 에서 한 번 더.
      publishToPost(
        post.id,
        makeMessageUpdatedEvent({ id: reply.id, body: accumulated, status: 'STREAMING' }),
      );
    }
    publishToPost(
      post.id,
      makeAgentTokenEvent({ messageId: reply.id, seq: reply.seq, delta }),
    );
    // 부분 본문을 DB 에 반영(인터럽트가 보존할 수 있도록).
    persistAccumulated();
  };

  // ── 도구 의도 처리(AR-TOOL): worker 가 방출한 도구를 toolBridge 로 실제 실행 + tool.* 표면화. ──
  //   샌드박스 루트(경로 가드/cwd 기준)를 조회. 없으면 도구를 건너뛴다(plain chat 만 진행).
  const sandbox = await prisma.sandbox.findUnique({
    where: { id: session.sandboxId },
    select: { postId: true, path: true, meta: true },
  });
  // 저장 절대경로를 그대로 믿지 않고 재계산(레포 이동/이름변경 self-heal). cwd·경로가드 기준 동일.
  const sandboxRoot = sandbox ? resolveSandboxDir(sandbox) : null;
  // AR-MUX opt-in 게이트: meta.concurrentTurns 가 true 일 때만 병렬 디스패치. meta null/손상 → false(레거시).
  //   기존 게시글(meta=null)·비-concurrent 게시글·테스트 샌드박스(meta 미설정)는 자동으로 FIFO 직렬 경로.
  const concurrent = sandbox ? getSandboxConcurrent(sandbox) : false;
  // 도구 처리를 직렬 큐로 잇는다(여러 의도가 순차 ack 되도록). onTool 은 동기 콜백.
  let toolChain: Promise<void> = Promise.resolve();
  const onTool = (intent: Parameters<NonNullable<Parameters<typeof runtime.send>[4]>>[0]): void => {
    toolChain = toolChain.then(async () => {
      // LLM function-calling 되먹임용 ack(ok/output/callId). 기본은 실패 문구.
      let ack: { ok: boolean; output: string; callId?: string } = {
        ok: false,
        output: sandboxRoot ? 'tool execution error' : 'no sandbox',
        callId: intent.callId,
      };
      try {
        if (sandboxRoot) {
          // XC-SERIAL(M8): 부수효과(파일 쓰기/쉘/도구 실행)를 샌드박스 단위 직렬 lock으로 감싼다.
          //   턴 내 직렬(toolChain) 위에 '턴 간' 직렬을 격상 — AR-PAR 동시 턴에서도 동시 파일 쓰기 진입 0.
          //   현재(단일 활성 턴)에는 경합이 없어 동작 불변(no-op).
          const outcome = await withSandboxLock(session.sandboxId, () =>
            runToolIntent({ postId: post.id, sessionId: session.id, sandboxRoot }, intent),
          );
          ack = { ok: outcome.ok, output: outcome.output, callId: intent.callId };
        }
      } catch {
        /* toolBridge 내부에서 FAILED 로 흡수 — 여기서는 기본 실패 ack 유지. */
      } finally {
        // worker 를 다음 의도/토큰으로 진행시킨다(턴 직렬화). 결과를 되먹여 LLM 루프 진행.
        // AR-MUX: concurrent 턴이면 intent.turnId 를 ackTool 에 실어 정확한 턴의 ackResolver 로 라우팅한다.
        //   (안 실으면 워커가 SINGLE 로 라우팅해 해당 턴을 못 찾고 hang.) 레거시는 turnId=undefined → 오늘과 동일.
        runtime.ackTool?.({ sandboxId: session.sandboxId }, ack, intent.turnId);
      }
    });
  };

  let finalStatus: 'COMPLETE' | 'FAILED' = 'COMPLETE';
  let errored = false;
  try {
    // PENDING→STREAMING(본문 누적 시작). 실제 전이는 첫 토큰에서 publish.
    await prisma.message.update({
      where: { id: reply.id },
      data: { status: 'STREAMING' },
    });
    // Feature A/B: 이미지/reasoning_effort 옵션을 런타임으로 전달(값 있을 때만 포함).
    // AR-MUX: concurrent(7번째 인자)로 디스패치 모드 전달 — true 면 turnId 병렬, false 면 FIFO 직렬.
    await runtime.send(
      session,
      input,
      lang,
      onToken,
      onTool,
      { image: args.image, reasoningEffort: args.reasoningEffort },
      concurrent,
    );
    // worker 의 done 이후에도 마지막 도구 체인이 남아있을 수 있으니 마저 기다린다.
    await toolChain;
  } catch {
    errored = true;
    finalStatus = 'FAILED';
  }

  // ── 4) 최종 본문/상태 영속화 + message.updated ──
  const finalized = await prisma.message.update({
    where: { id: reply.id },
    data: { body: accumulated, status: finalStatus },
  });
  publishToPost(
    post.id,
    makeMessageUpdatedEvent({
      id: finalized.id,
      body: finalized.body,
      status: finalStatus,
    }),
  );

  // AGENT_REPLY(AI 최종응답)가 COMPLETE 로 확정되면 댓글 수(commentCount)에 +1.
  // 정의(사용자 확정): 댓글 수 = HUMAN + AGENT_REPLY. 쉘/도구 출력(TOOL_CALL/
  // TOOL_RESULT)·SYSTEM·실패(FAILED) 는 카운트하지 않는다. HUMAN 경로(messages.ts)
  // 의 증가 패턴과 동일하게 hotScore 는 다음 vote 시 재계산된다.
  if (finalStatus === 'COMPLETE') {
    await prisma.post.update({
      where: { id: post.id },
      data: { commentCount: { increment: 1 } },
    });
  }

  // 에러 시 SYSTEM 버블(TRD §11) — 일반 문구만, 키/원문 미노출.
  if (errored) {
    await postSystemBubble(post.id, '에이전트 응답 실패 — 잠시 후 다시 시도하세요.', session.id);
  }

  // ── 5) 세션 IDLE 복귀 ──
  //   동시 질문은 런타임에서 FIFO 큐로 직렬화된다. 이 턴이 끝나도 같은 샌드박스에 아직
  //   진행/대기 중인 다른 턴이 있으면 IDLE 로 내리지 않는다(마지막 턴에서만 전이) — 중간
  //   IDLE 깜빡임 방지. isBusy 미구현 런타임은 false 로 보아 기존처럼 항상 IDLE 로 복귀.
  const stillBusy = runtime.isBusy?.({ sandboxId: session.sandboxId }) ?? false;
  if (!stillBusy) {
    await prisma.agentSession.update({
      where: { id: session.id },
      data: { status: 'IDLE' },
    });
    publishToPost(
      post.id,
      makeSessionStatusEvent({ sessionId: session.id, status: 'IDLE' }),
    );
  }
}

/**
 * SYSTEM 버블을 한 개 생성하고 message.created 를 publish 한다(TRD §11 안내/오류 표면화).
 * authorId=null, status COMPLETE. body 는 일반 문구만(키/원문 절대 미포함).
 */
export async function postSystemBubble(
  postId: string,
  body: string,
  sessionId: string | null = null,
): Promise<Message> {
  const msg = await prisma.$transaction(async (tx) => {
    const seq = await nextSeq(tx, postId);
    return tx.message.create({
      data: {
        postId,
        sessionId,
        authorId: null,
        type: 'SYSTEM',
        status: 'COMPLETE',
        body,
        seq,
      },
    });
  });

  publishToPost(
    postId,
    makeMessageCreatedEvent({
      id: msg.id,
      type: 'SYSTEM',
      status: 'COMPLETE',
      body: msg.body,
      authorId: null,
      seq: msg.seq,
      replyToId: msg.replyToId,
      toolCallId: msg.toolCallId,
      createdAt: msg.createdAt,
    }),
  );

  return msg;
}
