// backend/src/routes/session.ts
// 에이전트 세션 라우트(TRD §5·§6·§7, PLAN BE-SESS/BE-SUSPEND):
//   POST /posts/:id/session         세션 시작/attach(requireAuth)
//   POST /posts/:id/session/suspend 세션 일시중단(requireAuth)
//
// 보안(CLAUDE.md/TRD §8): apiKey 는 어떤 응답/이벤트/AgentSession 행에도 들어가지 않는다.
//   AgentSession.model 은 모델명만 저장(키 절대 미저장). 응답에는 키 필드 없음.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { setSandboxStatus } from '../sandbox/service.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { publishToPost } from '../realtime/publish.js';
import {
  makeSessionStatusEvent,
  makeMessageUpdatedEvent,
  type AgentSessionStatusValue,
} from '../realtime/events.js';
import { startOrAttach, ACTIVE_STATUSES } from '../agent/sessionStart.js';

/** session.status 이벤트를 post 채널로 fan-out. 키 필드 없음. */
function publishSessionStatus(
  postId: string,
  sessionId: string,
  status: AgentSessionStatusValue,
): void {
  publishToPost(postId, makeSessionStatusEvent({ sessionId, status }));
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // ── 세션 시작/attach ──────────────────────────────────
  app.post('/posts/:id/session', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id: postId } = req.params as { id: string };

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { sandbox: true },
    });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }
    const sandbox = post.sandbox;
    if (!sandbox) {
      return reply.code(409).send({ error: 'sandbox not provisioned for this post' });
    }

    // 임계구역 전체(lookup→attach→정규화→spawn→create)를 공용 헬퍼로 위임한다.
    //   - per-sandbox mutex 로 동시 호출이 coalesce 되고, stale RUNNING 정규화(Race B 복구)도 헬퍼가 담당.
    //   - 응답코드 매핑: attached → 200, fresh → 201, NOT_READY → 409(기존 동작 보존).
    const result = await startOrAttach({
      postId,
      sandbox: { id: sandbox.id, path: sandbox.path, status: sandbox.status },
    });
    if (!result.ok) {
      // CREATING(준비 중) / RUNNING(활성 세션 없는 RUNNING 은 비정상) / ERROR → 409.
      return reply.code(409).send({
        error: `sandbox is ${result.sandboxStatus}; cannot start a session`,
      });
    }
    return reply
      .code(result.attached ? 200 : 201)
      .send({ session: serializeSession(result.session) });
  });

  // ── 세션 일시중단(suspend) ────────────────────────────
  app.post('/posts/:id/session/suspend', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id: postId } = req.params as { id: string };

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { sandbox: true },
    });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }
    const sandbox = post.sandbox;
    if (!sandbox) {
      return reply.code(409).send({ error: 'sandbox not provisioned for this post' });
    }

    const active = await prisma.agentSession.findFirst({
      where: { sandboxId: sandbox.id, status: { in: ACTIVE_STATUSES } },
      orderBy: { startedAt: 'desc' },
    });
    if (!active) {
      return reply.code(409).send({ error: 'no active session to suspend' });
    }

    const runtime = getAgentRuntime();
    // 프로세스 종료(SIGTERM). 디렉토리는 보존된다(삭제 금지).
    await runtime.suspend({ id: active.id, sandboxId: sandbox.id });

    // 세션 STOPPED + endedAt.
    const stopped = await prisma.agentSession.update({
      where: { id: active.id },
      data: { status: 'STOPPED', endedAt: new Date() },
    });
    publishSessionStatus(postId, stopped.id, 'STOPPED');

    // 샌드박스 SUSPENDED(publishes sandbox.status). 디렉토리 보존.
    await setSandboxStatus(sandbox.id, 'SUSPENDED');

    return reply.code(200).send({ session: serializeSession(stopped) });
  });

  // ── 인터럽트/스티어(BE-INT, TRD §6.1 step4·§11) ──────
  app.post('/posts/:id/interrupt', { preHandler: app.requireAuth }, async (req, reply) => {
    const { id: postId } = req.params as { id: string };
    const body = (req.body ?? {}) as { steer?: unknown };
    const steer = typeof body.steer === 'string' && body.steer.trim() ? body.steer : undefined;

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { sandbox: true },
    });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }
    const sandbox = post.sandbox;
    if (!sandbox) {
      return reply.code(409).send({ error: 'sandbox not provisioned for this post' });
    }

    const active = await prisma.agentSession.findFirst({
      where: { sandboxId: sandbox.id, status: { in: ACTIVE_STATUSES } },
      orderBy: { startedAt: 'desc' },
    });
    if (!active) {
      return reply.code(409).send({ error: 'no active session to interrupt' });
    }

    // 런타임에 인터럽트 전달(남은 토큰 방출 즉시 중단, 선택 steer 로 방향 전환).
    const runtime = getAgentRuntime();
    await runtime.interrupt({ id: active.id, sandboxId: sandbox.id }, steer);

    // 진행 중 STREAMING/PENDING AGENT_REPLY 를 COMPLETE(부분 본문 보존)로 확정 후 통지.
    const inflight = await prisma.message.findFirst({
      where: { postId, type: 'AGENT_REPLY', status: { in: ['PENDING', 'STREAMING'] } },
      orderBy: { seq: 'desc' },
    });
    let finalized: { id: string; body: string; status: string } | null = null;
    if (inflight) {
      const updated = await prisma.message.update({
        where: { id: inflight.id },
        data: { status: 'COMPLETE' }, // 부분 본문 보존(TRD §6.1 step4).
      });
      finalized = { id: updated.id, body: updated.body, status: 'COMPLETE' };
      publishToPost(
        postId,
        makeMessageUpdatedEvent({ id: updated.id, body: updated.body, status: 'COMPLETE' }),
      );
    }

    // 세션 INTERRUPTED 전이 + 통지.
    await prisma.agentSession.update({
      where: { id: active.id },
      data: { status: 'INTERRUPTED' },
    });
    publishSessionStatus(postId, active.id, 'INTERRUPTED');

    return reply.code(200).send({ interrupted: true, message: finalized });
  });
}

/** AgentSession 행을 응답용으로 직렬화. 키 필드는 애초에 행에 없다(model=모델명만). */
function serializeSession(s: {
  id: string;
  sandboxId: string;
  status: string;
  model: string;
  runtimePid: number | null;
  startedAt: Date;
  endedAt: Date | null;
}) {
  return {
    id: s.id,
    sandboxId: s.sandboxId,
    status: s.status,
    model: s.model,
    runtimePid: s.runtimePid,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}
