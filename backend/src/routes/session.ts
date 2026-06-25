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
import { getLlmRuntimeConfig } from '../agent/config.js';
import { publishToPost } from '../realtime/publish.js';
import {
  makeSessionStatusEvent,
  makeMessageUpdatedEvent,
  type AgentSessionStatusValue,
} from '../realtime/events.js';

/** attach 대상으로 간주하는 활성 세션 상태(이미 살아있는 세션). */
const ACTIVE_STATUSES: AgentSessionStatusValue[] = ['STARTING', 'IDLE', 'RUNNING'];

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

    // 이미 활성 세션이 있으면 attach(새 프로세스 spawn 없음 — 멀티 클라이언트 fan-out).
    const existing = await prisma.agentSession.findFirst({
      where: { sandboxId: sandbox.id, status: { in: ACTIVE_STATUSES } },
      orderBy: { startedAt: 'desc' },
    });
    if (existing) {
      const runtime = getAgentRuntime();
      try {
        await runtime.attach({ id: existing.id, sandboxId: sandbox.id });
      } catch {
        // 활성 행은 있으나 프로세스가 사라진 비정상 상태: 아래 spawn 경로로 떨어지도록 처리.
        // (PoC: 행을 STOPPED 로 닫고 fresh spawn 으로 진행)
        await prisma.agentSession.update({
          where: { id: existing.id },
          data: { status: 'STOPPED', endedAt: new Date() },
        });
        // stale RUNNING 정규화: 프로세스는 죽었지만(attach 실패) 샌드박스 디렉토리는 보존돼 있다 →
        // 의미상 이는 정확히 resume 케이스다. 그러나 sandbox.status 는 여전히 RUNNING 이라
        // startFreshSession 의 READY/SUSPENDED 가드에 걸려 409 가 난다(서버 재시작 후 전형적 증상).
        // 따라서 RUNNING 만 SUSPENDED 로 전이해 fresh-start 의 resume 경로가 이를 받아들이게 한다.
        // (CREATING/ERROR 는 진짜로 시작 불가 상태이므로 그대로 두어 정상적으로 409 가 나야 한다.)
        if (sandbox.status === 'RUNNING') {
          const updated = await setSandboxStatus(sandbox.id, 'SUSPENDED'); // sandbox.status 이벤트도 publish.
          // 로컬 sandbox 객체를 갱신해야 startFreshSession 이 stale RUNNING 이 아닌 SUSPENDED 를 본다.
          sandbox.status = updated.status;
        }
        return await startFreshSession(reply);
      }
      return reply.code(200).send({ session: serializeSession(existing) });
    }

    return await startFreshSession(reply);

    // ── helper: 새 세션 spawn(READY/SUSPENDED 만 허용) ──
    async function startFreshSession(rep: typeof reply) {
      // 활성 세션이 없으니 새로 띄우려면 샌드박스가 READY 또는 SUSPENDED(resume) 여야 한다.
      if (sandbox!.status !== 'READY' && sandbox!.status !== 'SUSPENDED') {
        // CREATING(준비 중) / RUNNING(활성 세션 없는 RUNNING 은 비정상) / ERROR → 409.
        return rep.code(409).send({
          error: `sandbox is ${sandbox!.status}; cannot start a session`,
        });
      }

      const runtime = getAgentRuntime();
      const rt = getLlmRuntimeConfig(); // 내부 전용 — 응답/로그에 절대 안 들어감.

      // spawn(STARTING). 디렉토리는 이미 존재(resume 도 동일 경로).
      const { pid } = await runtime.spawn({ id: sandbox!.id, path: sandbox!.path });

      // AgentSession 행 생성: model 은 모델명만, runtimePid = pid, status STARTING.
      const session = await prisma.agentSession.create({
        data: {
          sandboxId: sandbox!.id,
          status: 'STARTING',
          model: rt.model, // 모델명만. 키 절대 미저장.
          runtimePid: pid,
        },
      });
      publishSessionStatus(postId, session.id, 'STARTING');

      // 샌드박스 RUNNING(publishes sandbox.status).
      await setSandboxStatus(sandbox!.id, 'RUNNING');

      // ready 신호를 받았으므로 IDLE 로 전이.
      const idle = await prisma.agentSession.update({
        where: { id: session.id },
        data: { status: 'IDLE' },
      });
      publishSessionStatus(postId, idle.id, 'IDLE');

      return rep.code(201).send({ session: serializeSession(idle) });
    }
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
