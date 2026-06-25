// backend/src/domain/toolCall.ts
// BE-TOOL — ToolCall 라이프사이클 도메인(TRD §3·§7, PLAN §M5).
//
// 도구 1건은 다음 3개 행으로 표상된다:
//   1) ToolCall 행            — kind/name/args/result/exitCode/status(SoT). status RUNNING 시작.
//   2) TOOL_CALL 버블(Message) — '$ <cmd>' 풍 호출 표시. Message.toolCallId 로 ToolCall 과 1:1 연결.
//   3) TOOL_RESULT 버블(Message) — 터미널 출력 누적 버블. body 가 stdout/stderr 를 누적.
//
// 연결 스킴(중요): Prisma 의 Message.toolCallId 는 @unique 이므로 한 ToolCall 당 단 하나의 버블만
//   FK 로 연결할 수 있다(TRD §3). 따라서:
//     - TOOL_CALL 버블이 toolCallId 를 들고 ToolCall 과 1:1 로 연결된다(권위 링크).
//     - TOOL_RESULT 버블은 toolCallId 를 들 수 없으므로, replyToId 를 TOOL_CALL 버블 id 로 두어
//       결정적으로 역참조한다(같은 ToolCall 의 결과 버블 = replyTo == TOOL_CALL 버블).
//   이 스킴 덕에 두 버블 모두 seq 를 가져 SSE 재생(message.created 스냅샷)에 그대로 실린다.
//
// 라이프사이클 API:
//   createToolCall({sessionId,kind,name,args})
//     → ToolCall(RUNNING) + TOOL_CALL 버블(COMPLETE) + TOOL_RESULT 버블(STREAMING, body='') 생성.
//       message.created(x2) + tool.call 이벤트 publish. { toolCallId, callMessageId, resultMessageId } 반환.
//   appendToolOutput(toolCallId, chunk)
//     → ToolCall.result 및 TOOL_RESULT 버블 body 에 누적. tool.output 이벤트 publish.
//   finalizeToolCall(toolCallId, {status,exitCode,result})
//     → ToolCall 종료 상태 확정 + TOOL_RESULT 버블 status(COMPLETE/FAILED)/body 확정.
//       message.updated + tool.result 이벤트 publish.
//
// 보안(CLAUDE.md/TRD §8): args/name/result/chunk 어디에도 apiKey/baseURL 류를 담지 않는다.
//   호출부(toolExec/toolBridge)가 키 비포함을 보장하며, 이벤트 빌더는 명시 필드만 받는다.

import type { ToolKind, ToolCallStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { nextSeq } from '../domain/seq.js';
import { publishToPost } from '../realtime/publish.js';
import {
  makeMessageCreatedEvent,
  makeMessageUpdatedEvent,
  makeToolCallEvent,
  makeToolOutputEvent,
  makeToolResultEvent,
  type ToolKindValue,
} from '../realtime/events.js';

/** createToolCall 입력. postId 는 이벤트 채널(=fan-out 대상) 결정에 필요. */
export interface CreateToolCallArgs {
  postId: string;
  sessionId: string;
  kind: ToolKindValue;
  name: string;
  /** JSON 직렬화된 인자 문자열(명령/경로 등). 키 절대 미포함. */
  args: string;
}

/** createToolCall 결과: 생성된 ToolCall + 두 버블 id. */
export interface CreatedToolCall {
  toolCallId: string;
  /** TOOL_CALL 버블 id(toolCallId 로 ToolCall 과 1:1 연결). */
  callMessageId: string;
  /** TOOL_RESULT 버블 id(출력 누적 대상). */
  resultMessageId: string;
}

/**
 * 새 ToolCall + TOOL_CALL/TOOL_RESULT 버블을 한 트랜잭션으로 생성하고
 * message.created(x2) + tool.call 이벤트를 publish 한다.
 */
export async function createToolCall(args: CreateToolCallArgs): Promise<CreatedToolCall> {
  const { postId, sessionId, kind, name, args: toolArgs } = args;

  const { toolCall, callBubble, resultBubble } = await prisma.$transaction(async (tx) => {
    // 1) ToolCall(RUNNING) SoT.
    const toolCall = await tx.toolCall.create({
      data: {
        sessionId,
        kind: kind as ToolKind,
        name,
        args: toolArgs,
        status: 'RUNNING',
      },
    });

    // 2) TOOL_CALL 버블 — toolCallId 로 1:1 연결. 호출 표시이므로 즉시 COMPLETE.
    const callSeq = await nextSeq(tx, postId);
    const callBubble = await tx.message.create({
      data: {
        postId,
        sessionId,
        authorId: null,
        type: 'TOOL_CALL',
        status: 'COMPLETE',
        body: name,
        toolCallId: toolCall.id,
        seq: callSeq,
      },
    });

    // 3) TOOL_RESULT 버블 — 출력 누적 대상(STREAMING). replyToId 로 TOOL_CALL 버블을 역참조.
    const resultSeq = await nextSeq(tx, postId);
    const resultBubble = await tx.message.create({
      data: {
        postId,
        sessionId,
        authorId: null,
        type: 'TOOL_RESULT',
        status: 'STREAMING',
        body: '',
        replyToId: callBubble.id,
        seq: resultSeq,
      },
    });

    return { toolCall, callBubble, resultBubble };
  });

  // message.created — TOOL_CALL 버블.
  publishToPost(
    postId,
    makeMessageCreatedEvent({
      id: callBubble.id,
      type: 'TOOL_CALL',
      status: 'COMPLETE',
      body: callBubble.body,
      authorId: null,
      seq: callBubble.seq,
      replyToId: callBubble.replyToId,
      toolCallId: callBubble.toolCallId,
      createdAt: callBubble.createdAt,
    }),
  );
  // message.created — TOOL_RESULT 버블(빈 본문, STREAMING).
  publishToPost(
    postId,
    makeMessageCreatedEvent({
      id: resultBubble.id,
      type: 'TOOL_RESULT',
      status: 'STREAMING',
      body: '',
      authorId: null,
      seq: resultBubble.seq,
      replyToId: resultBubble.replyToId,
      toolCallId: resultBubble.toolCallId,
      createdAt: resultBubble.createdAt,
    }),
  );
  // tool.call — RUNNING. messageId = TOOL_CALL 버블.
  publishToPost(
    postId,
    makeToolCallEvent({
      toolCallId: toolCall.id,
      messageId: callBubble.id,
      kind,
      name,
      args: toolArgs,
      startedAt: toolCall.startedAt,
    }),
  );

  return {
    toolCallId: toolCall.id,
    callMessageId: callBubble.id,
    resultMessageId: resultBubble.id,
  };
}

/**
 * 도구 출력 청크를 ToolCall.result 와 TOOL_RESULT 버블 body 에 누적하고
 * tool.output 이벤트를 publish 한다.
 * 빈 청크는 무시(불필요 이벤트 방지).
 */
export async function appendToolOutput(toolCallId: string, chunk: string): Promise<void> {
  if (!chunk) return;

  // 결과 버블(replyTo == TOOL_CALL 버블) 을 결정적으로 찾는다.
  const located = await locateResultBubble(toolCallId);
  if (!located) return;
  const { postId, resultBubble } = located;

  const newBody = resultBubble.body + chunk;
  await prisma.$transaction([
    prisma.toolCall.update({
      where: { id: toolCallId },
      data: { result: newBody },
    }),
    prisma.message.update({
      where: { id: resultBubble.id },
      data: { body: newBody },
    }),
  ]);

  publishToPost(
    postId,
    makeToolOutputEvent({
      toolCallId,
      messageId: resultBubble.id,
      chunk,
    }),
  );
}

/** finalizeToolCall 입력. result 가 주어지면 누적 본문을 이 값으로 확정(없으면 기존 누적 유지). */
export interface FinalizeToolCallArgs {
  status: 'SUCCEEDED' | 'FAILED';
  exitCode: number | null;
  /** 최종 결과 본문(미지정 시 누적된 result 유지). */
  result?: string;
}

/**
 * ToolCall 종료 상태를 확정하고 TOOL_RESULT 버블을 COMPLETE/FAILED 로 확정한다.
 * message.updated + tool.result 이벤트를 publish 한다.
 */
export async function finalizeToolCall(
  toolCallId: string,
  args: FinalizeToolCallArgs,
): Promise<void> {
  const { status, exitCode } = args;

  const located = await locateResultBubble(toolCallId);
  if (!located) return;
  const { postId, resultBubble } = located;

  const finalBody = args.result !== undefined ? args.result : resultBubble.body;
  const bubbleStatus = status === 'SUCCEEDED' ? 'COMPLETE' : 'FAILED';

  await prisma.$transaction([
    prisma.toolCall.update({
      where: { id: toolCallId },
      data: {
        status: status as ToolCallStatus,
        exitCode,
        result: finalBody,
        endedAt: new Date(),
      },
    }),
    prisma.message.update({
      where: { id: resultBubble.id },
      data: { body: finalBody, status: bubbleStatus },
    }),
  ]);

  publishToPost(
    postId,
    makeMessageUpdatedEvent({
      id: resultBubble.id,
      body: finalBody,
      status: bubbleStatus,
    }),
  );
  publishToPost(
    postId,
    makeToolResultEvent({
      toolCallId,
      messageId: resultBubble.id,
      status,
      exitCode,
      result: finalBody,
    }),
  );
}

/**
 * toolCallId 로부터 (postId, TOOL_RESULT 버블) 을 결정적으로 찾는다.
 * TOOL_CALL 버블은 toolCallId 로 1:1 연결, TOOL_RESULT 버블은 그 버블을 replyTo 로 가리킨다.
 */
async function locateResultBubble(
  toolCallId: string,
): Promise<{ postId: string; resultBubble: { id: string; body: string } } | null> {
  const callBubble = await prisma.message.findUnique({
    where: { toolCallId },
    select: { id: true, postId: true },
  });
  if (!callBubble) return null;

  const resultBubble = await prisma.message.findFirst({
    where: { replyToId: callBubble.id, type: 'TOOL_RESULT' },
    select: { id: true, body: true },
  });
  if (!resultBubble) return null;

  return { postId: callBubble.postId, resultBubble };
}
