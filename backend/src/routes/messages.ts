// backend/src/routes/messages.ts
// BE-MSG + BE-MSGPAGE (TRD §4·§4.1·§6.1 step3):
//   POST /posts/:id/messages   사람 메시지 전송(requireAuth). {body, aiMode, clientId, lang?}
//   GET  /posts/:id/messages   버블 페이지네이션(optionalAuth). ?afterSeq= keyset 오름차순, page 50.
//
// 보안(CLAUDE.md/TRD §8): 응답/이벤트에 LLM 키 절대 미포함. SYSTEM/AGENT 버블 authorId=null.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { nextSeq } from '../domain/seq.js';
import { publishToPost } from '../realtime/publish.js';
import { makeMessageCreatedEvent } from '../realtime/events.js';
import { runAgentTurn, postSystemBubble } from '../agent/turn.js';
import { startOrAttach } from '../agent/sessionStart.js';
import { isOwnUploadUrl, resolveImageRef } from '../domain/imageRef.js';

/** 유효한 per-message reasoning_effort 값(Feature B). */
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

/** 페이지 크기(TRD §4.1 권장값과 일관, 메시지 전용 50). */
const PAGE_SIZE = 50;

/** 연결된 ToolCall 의 요약(키 필드 없음 — kind/name/status/exitCode 만). */
interface ToolCallSummary {
  id: string;
  kind: string;
  name: string;
  status: string;
  exitCode: number | null;
}

/** 응답/이벤트용 Message 직렬화(키 필드는 애초에 행에 없음). */
function serializeMessage(m: {
  id: string;
  postId: string;
  sessionId: string | null;
  authorId: string | null;
  type: string;
  status: string;
  body: string;
  imageUrl?: string | null;
  replyToId: string | null;
  toolCallId: string | null;
  seq: number;
  clientId: string | null;
  createdAt: Date;
  toolCall?: {
    id: string;
    kind: string;
    name: string;
    status: string;
    exitCode: number | null;
  } | null;
}) {
  // M5(BE-MSGPAGE): 연결된 ToolCall 요약(kind/name/status/exitCode). 미연결이면 null.
  //   args/result 등 본문성 필드는 버블 body 가 담으므로 요약에는 넣지 않는다(키 누출 표면 최소화).
  const toolCall: ToolCallSummary | null = m.toolCall
    ? {
        id: m.toolCall.id,
        kind: m.toolCall.kind,
        name: m.toolCall.name,
        status: m.toolCall.status,
        exitCode: m.toolCall.exitCode,
      }
    : null;
  return {
    id: m.id,
    postId: m.postId,
    sessionId: m.sessionId,
    authorId: m.authorId,
    type: m.type,
    status: m.status,
    body: m.body,
    imageUrl: m.imageUrl ?? null,
    replyToId: m.replyToId,
    toolCallId: m.toolCallId,
    seq: m.seq,
    clientId: m.clientId,
    createdAt: m.createdAt,
    toolCall,
  };
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  // ── 사람 메시지 전송 ──────────────────────────────────
  app.post('/posts/:id/messages', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!;
    const { id: postId } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      body?: unknown;
      aiMode?: unknown;
      clientId?: unknown;
      lang?: unknown;
      imageUrl?: unknown;
      reasoningEffort?: unknown;
    };

    const text = typeof body.body === 'string' ? body.body : '';
    const aiMode = body.aiMode === true;
    const clientId = typeof body.clientId === 'string' && body.clientId.length > 0 ? body.clientId : null;
    const lang = body.lang === 'ko' ? 'ko' : 'en';

    // ── imageUrl(Feature A): 자기-소유 /uploads/<uuid>.<ext> 형태만 허용. ──
    //   주어졌는데 화이트리스트 불통과면 400(절대경로/외부URL/traversal/타 prefix 거부).
    let imageUrl: string | null = null;
    if (body.imageUrl !== undefined && body.imageUrl !== null && body.imageUrl !== '') {
      if (!isOwnUploadUrl(body.imageUrl)) {
        return reply.code(400).send({ error: 'invalid imageUrl' });
      }
      imageUrl = body.imageUrl;
    }

    // ── reasoningEffort(Feature B): 주어지면 low/medium/high 만 허용(그 외 400). ──
    //   aiMode 인데 미지정이면 기본 'medium'. aiMode 가 아니면 무시(에이전트 턴 없음).
    let reasoningEffort: string | undefined;
    if (body.reasoningEffort !== undefined && body.reasoningEffort !== null) {
      if (typeof body.reasoningEffort !== 'string' || !REASONING_EFFORTS.has(body.reasoningEffort)) {
        return reply.code(400).send({ error: 'invalid reasoningEffort' });
      }
      reasoningEffort = body.reasoningEffort;
    }
    if (aiMode && reasoningEffort === undefined) {
      reasoningEffort = 'medium'; // 기본값.
    }

    // body 는 imageUrl 이 있으면 비어 있어도 된다(이미지-only 메시지). 둘 다 없으면 400.
    if (!text.trim() && !imageUrl) {
      return reply.code(400).send({ error: 'body is required' });
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { sandbox: true },
    });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }

    // ── clientId 멱등: 동일 키면 기존 버블을 그대로 반환(중복 생성 금지). ──
    if (clientId) {
      const existing = await prisma.message.findFirst({
        where: { postId, clientId },
      });
      if (existing) {
        return reply.code(200).send({ message: serializeMessage(existing) });
      }
    }

    // ── HUMAN 버블 생성(seq via nextSeq) + commentCount 증가(같은 tx). ──
    let human;
    try {
      human = await prisma.$transaction(async (tx) => {
        const seq = await nextSeq(tx, postId);
        const created = await tx.message.create({
          data: {
            postId,
            authorId: authUser.userId,
            type: 'HUMAN',
            status: 'COMPLETE',
            body: text,
            imageUrl, // Feature A: 첨부 이미지 정적 경로(없으면 null).
            clientId,
            seq,
          },
        });
        await tx.post.update({
          where: { id: postId },
          data: { commentCount: { increment: 1 } },
        });
        return created;
      });
    } catch (err) {
      // @@unique([postId, clientId]) 경합으로 동시 중복이 들어온 경우 기존 버블을 반환(멱등).
      if (clientId) {
        const existing = await prisma.message.findFirst({ where: { postId, clientId } });
        if (existing) {
          return reply.code(200).send({ message: serializeMessage(existing) });
        }
      }
      throw err;
    }

    // message.created fan-out(전원 즉시 좌/우 버블).
    publishToPost(
      postId,
      makeMessageCreatedEvent({
        id: human.id,
        type: 'HUMAN',
        status: 'COMPLETE',
        body: human.body,
        authorId: human.authorId,
        seq: human.seq,
        replyToId: human.replyToId,
        toolCallId: human.toolCallId,
        createdAt: human.createdAt,
      }),
    );

    // ── aiMode=true: 활성 세션 확보 후 에이전트 턴 시작(HTTP 응답을 막지 않음). ──
    if (aiMode) {
      const sandbox = post.sandbox;
      if (!sandbox) {
        await postSystemBubble(postId, '샌드박스가 준비되지 않았습니다.');
      } else {
        const session = await ensureActiveSession(postId, sandbox.id, sandbox.path, sandbox.status);
        if (!session) {
          // 세션을 시작할 수 없는 상태(CREATING/ERROR 등): 안내 버블(TRD §4.1).
          await postSystemBubble(postId, '세션을 시작하세요');
        } else {
          // Feature A: 저장된 imageUrl 을 호스트 절대경로 + MIME 으로 해석(가드 통과 시에만 비전 동봉).
          const imageRef = imageUrl ? resolveImageRef(imageUrl) : null;
          // 응답을 막지 않고 비동기로 턴 실행. 예외는 turn.ts 내부에서 흡수(FAILED+SYSTEM).
          void runAgentTurn({
            post: { id: postId },
            session: { id: session.id, sandboxId: sandbox.id },
            humanMessage: { id: human.id, body: human.body },
            lang,
            image: imageRef ? { absPath: imageRef.absPath, mime: imageRef.mime } : undefined,
            reasoningEffort, // Feature B: aiMode 면 medium 기본, 또는 사용자 선택값.
          });
        }
      }
    }

    return reply.code(201).send({ message: serializeMessage(human) });
  });

  // ── 버블 페이지네이션(seq keyset 오름차순) ────────────
  app.get('/posts/:id/messages', { preHandler: app.optionalAuth }, async (req, reply) => {
    const { id: postId } = req.params as { id: string };
    const query = (req.query ?? {}) as { afterSeq?: unknown };

    const afterSeqRaw = typeof query.afterSeq === 'string' ? Number(query.afterSeq) : NaN;
    const afterSeq = Number.isFinite(afterSeqRaw) ? afterSeqRaw : 0;

    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }

    const rows = await prisma.message.findMany({
      where: { postId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: PAGE_SIZE + 1,
      // BE-MSGPAGE: 연결된 ToolCall 요약(kind/name/status/exitCode)을 함께 싣는다.
      include: {
        toolCall: { select: { id: true, kind: true, name: true, status: true, exitCode: true } },
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const items = page.map(serializeMessage);
    const last = page[page.length - 1];
    const nextAfterSeq = hasMore && last ? last.seq : null;

    return reply.code(200).send({ items, nextAfterSeq });
  });
}

/**
 * aiMode 턴을 위한 활성 세션을 확보한다(공용 헬퍼 startOrAttach 경유).
 *   - 이미 활성(STARTING/IDLE/RUNNING) live 세션이 있으면 attach 후 그 세션을 반환.
 *   - attach 실패(서버 재시작 후 stale RUNNING 등)면 헬퍼가 stale 행을 닫고 RUNNING→SUSPENDED
 *     정규화 후 fresh-start 한다(Race B 복구 — 과거엔 여기서 null 반환해 aiMode 가 조용히 실패했다).
 *   - 시작 불가(CREATING/ERROR 등)면 null(호출부가 SYSTEM 버블로 안내).
 * 동시성: per-sandbox mutex 로 같은 sandbox 의 동시 호출이 coalesce 된다(헬퍼 내부).
 * 보안: model 만 저장(키 미저장). session.status 이벤트는 헬퍼가 publish.
 */
export async function ensureActiveSession(
  postId: string,
  sandboxId: string,
  sandboxPath: string,
  sandboxStatus: string,
): Promise<{ id: string } | null> {
  const result = await startOrAttach({
    postId,
    sandbox: { id: sandboxId, path: sandboxPath, status: sandboxStatus },
  });
  if (!result.ok) {
    return null; // 시작 불가 상태(NOT_READY).
  }
  return { id: result.session.id };
}
