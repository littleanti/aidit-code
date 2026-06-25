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
import {
  makeMessageCreatedEvent,
  makeSessionStatusEvent,
  type AgentSessionStatusValue,
} from '../realtime/events.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { getLlmRuntimeConfig } from '../agent/config.js';
import { setSandboxStatus } from '../sandbox/service.js';
import { runAgentTurn, postSystemBubble } from '../agent/turn.js';

/** 활성(살아있는) 세션으로 간주하는 상태. */
const ACTIVE_STATUSES: AgentSessionStatusValue[] = ['STARTING', 'IDLE', 'RUNNING'];

/** 페이지 크기(TRD §4.1 권장값과 일관, 메시지 전용 50). */
const PAGE_SIZE = 50;

/** 응답/이벤트용 Message 직렬화(키 필드는 애초에 행에 없음). */
function serializeMessage(m: {
  id: string;
  postId: string;
  sessionId: string | null;
  authorId: string | null;
  type: string;
  status: string;
  body: string;
  replyToId: string | null;
  toolCallId: string | null;
  seq: number;
  clientId: string | null;
  createdAt: Date;
}) {
  return {
    id: m.id,
    postId: m.postId,
    sessionId: m.sessionId,
    authorId: m.authorId,
    type: m.type,
    status: m.status,
    body: m.body,
    replyToId: m.replyToId,
    toolCallId: m.toolCallId,
    seq: m.seq,
    clientId: m.clientId,
    createdAt: m.createdAt,
    // M5 가 채울 연결 도구 호출 요약(현재 null).
    toolCall: null,
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
    };

    const text = typeof body.body === 'string' ? body.body : '';
    const aiMode = body.aiMode === true;
    const clientId = typeof body.clientId === 'string' && body.clientId.length > 0 ? body.clientId : null;
    const lang = body.lang === 'ko' ? 'ko' : 'en';

    if (!text.trim()) {
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
          // 응답을 막지 않고 비동기로 턴 실행. 예외는 turn.ts 내부에서 흡수(FAILED+SYSTEM).
          void runAgentTurn({
            post: { id: postId },
            session: { id: session.id, sandboxId: sandbox.id },
            humanMessage: { id: human.id, body: human.body },
            lang,
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
 * aiMode 턴을 위한 활성 세션을 확보한다.
 *   - 이미 활성(STARTING/IDLE/RUNNING) 세션이 있으면 그 세션을 반환(attach 보장은 세션 라우트 책임).
 *   - 없고 샌드박스가 READY/SUSPENDED 면 새 spawn(STARTING→IDLE) 후 반환.
 *   - 그 외(CREATING/ERROR 등)면 null(호출부가 SYSTEM 버블로 안내).
 * 보안: model 만 저장(키 미저장). session.status 이벤트로 상태 표면화.
 */
async function ensureActiveSession(
  postId: string,
  sandboxId: string,
  sandboxPath: string,
  sandboxStatus: string,
): Promise<{ id: string } | null> {
  const existing = await prisma.agentSession.findFirst({
    where: { sandboxId, status: { in: ACTIVE_STATUSES } },
    orderBy: { startedAt: 'desc' },
  });
  if (existing) {
    const runtime = getAgentRuntime();
    try {
      await runtime.attach({ id: existing.id, sandboxId });
      return { id: existing.id };
    } catch {
      // 활성 행은 있으나 프로세스가 사라진 비정상 상태: 행을 닫고 fresh spawn 으로 진행.
      await prisma.agentSession.update({
        where: { id: existing.id },
        data: { status: 'STOPPED', endedAt: new Date() },
      });
    }
  }

  if (sandboxStatus !== 'READY' && sandboxStatus !== 'SUSPENDED') {
    return null; // 시작 불가 상태.
  }

  const runtime = getAgentRuntime();
  const rt = getLlmRuntimeConfig(); // 내부 전용 — 응답/로그/이벤트에 절대 미포함.
  const { pid } = await runtime.spawn({ id: sandboxId, path: sandboxPath });

  const session = await prisma.agentSession.create({
    data: { sandboxId, status: 'STARTING', model: rt.model, runtimePid: pid },
  });
  publishToPost(postId, makeSessionStatusEvent({ sessionId: session.id, status: 'STARTING' }));

  await setSandboxStatus(sandboxId, 'RUNNING');

  const idle = await prisma.agentSession.update({
    where: { id: session.id },
    data: { status: 'IDLE' },
  });
  publishToPost(postId, makeSessionStatusEvent({ sessionId: idle.id, status: 'IDLE' }));

  return { id: idle.id };
}
