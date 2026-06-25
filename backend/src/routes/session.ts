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
