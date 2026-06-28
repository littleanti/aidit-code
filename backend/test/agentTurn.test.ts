// backend/test/agentTurn.test.ts
// AR-TURN 검증: runAgentTurn 이 stub 런타임(실제 spawn 된 piWorker)에 대해
//   message.created(AGENT_REPLY/PENDING) -> agent.token(들) -> message.updated(COMPLETE)
//   순서의 이벤트를 publish 하고, 누적 본문이 delta 합과 일치하는지 확인한다.
//   in-process pubsub 구독으로 캡처. spawn 된 자식은 afterEach 에서 모두 종료.

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/db.js';
import { bus } from '../src/realtime/pubsub.js';
import type { RealtimeEvent } from '../src/realtime/events.js';
import { piRuntime } from '../src/agent/pi.js';
import { runAgentTurn } from '../src/agent/turn.js';

const spawnedSandboxIds: string[] = [];
const cleanup: Array<{ userId: string; postId: string; sandboxId: string; sessionId: string }> = [];

afterEach(async () => {
  for (const sid of spawnedSandboxIds) {
    try {
      await piRuntime.suspend({ id: 's', sandboxId: sid });
    } catch {
      /* noop */
    }
  }
  spawnedSandboxIds.length = 0;
});

afterAll(async () => {
  for (const c of cleanup) {
    await prisma.message.deleteMany({ where: { postId: c.postId } });
    await prisma.agentSession.deleteMany({ where: { id: c.sessionId } });
    await prisma.sandbox.deleteMany({ where: { id: c.sandboxId } });
    await prisma.post.deleteMany({ where: { id: c.postId } });
    await prisma.user.deleteMany({ where: { id: c.userId } });
  }
  await prisma.$disconnect();
});

async function setupSession(): Promise<{
  postId: string;
  sessionId: string;
  sandboxId: string;
  humanId: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'turn-'));
  const user = await prisma.user.create({
    data: { username: `turn-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  const post = await prisma.post.create({
    data: { authorId: user.id, title: 'turn test', body: '' },
  });
  const sandbox = await prisma.sandbox.create({
    data: { postId: post.id, path: dir, status: 'RUNNING', runtime: 'pi' },
  });
  // 실제 worker spawn(stdin/stdout 턴 프로토콜).
  const { pid } = await piRuntime.spawn({ id: sandbox.id, path: dir });
  spawnedSandboxIds.push(sandbox.id);
  const session = await prisma.agentSession.create({
    data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test-model', runtimePid: pid },
  });
  // 사람 메시지(seq=1).
  const human = await prisma.message.create({
    data: {
      postId: post.id,
      authorId: user.id,
      type: 'HUMAN',
      status: 'COMPLETE',
      body: 'hello world',
      seq: 1,
    },
  });

  cleanup.push({ userId: user.id, postId: post.id, sandboxId: sandbox.id, sessionId: session.id });
  return { postId: post.id, sessionId: session.id, sandboxId: sandbox.id, humanId: human.id };
}

describe('runAgentTurn', () => {
  it('publishes message.created(AGENT_REPLY/PENDING) -> agent.token(s) -> message.updated(COMPLETE)', async () => {
    const { postId, sessionId, sandboxId, humanId } = await setupSession();

    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(postId, (ev) => received.push(ev));

    try {
      await runAgentTurn({
        post: { id: postId },
        session: { id: sessionId, sandboxId },
        humanMessage: { id: humanId, body: 'hello world' },
        lang: 'ko',
      });

      // message.created(AGENT_REPLY/PENDING) 가 첫 메시지 이벤트.
      const created = received.find(
        (e) => e.type === 'message.created' && e.message.type === 'AGENT_REPLY',
      );
      expect(created).toBeDefined();
      if (created && created.type === 'message.created') {
        expect(created.message.status).toBe('PENDING');
        expect(created.message.authorId).toBeNull();
        expect(created.message.replyToId).toBe(humanId);
      }

      const tokens = received.filter((e) => e.type === 'agent.token');
      expect(tokens.length).toBeGreaterThan(0);

      const updated = received.filter((e) => e.type === 'message.updated');
      const completed = updated.find((e) => e.type === 'message.updated' && e.status === 'COMPLETE');
      expect(completed).toBeDefined();

      // 누적 본문 = delta 합.
      const concatenated = tokens
        .map((e) => (e.type === 'agent.token' ? e.delta : ''))
        .join('');
      if (completed && completed.type === 'message.updated') {
        expect(completed.body).toBe(concatenated);
      }

      // KO 힌트 프리픽스 + 에코 포함.
      expect(concatenated).toContain('[KO]');
      expect(concatenated).toContain('hello world');

      // DB 도 COMPLETE + 동일 본문.
      const replyRow = await prisma.message.findFirst({
        where: { postId, type: 'AGENT_REPLY' },
      });
      expect(replyRow!.status).toBe('COMPLETE');
      expect(replyRow!.body).toBe(concatenated);

      // 세션 IDLE 복귀.
      const sess = await prisma.agentSession.findUnique({ where: { id: sessionId } });
      expect(sess!.status).toBe('IDLE');

      // 키 누출 없음(전체 직렬화 검증).
      expect(JSON.stringify(received)).not.toMatch(/apiKey|API_KEY|baseURL|BASE_URL|sk-[A-Za-z0-9]/i);

      // 이벤트 순서: 첫 AGENT_REPLY message.created 가 모든 agent.token 보다 앞.
      const firstReplyIdx = received.findIndex(
        (e) => e.type === 'message.created' && e.message.type === 'AGENT_REPLY',
      );
      const firstTokenIdx = received.findIndex((e) => e.type === 'agent.token');
      const completeIdx = received.findIndex(
        (e) => e.type === 'message.updated' && e.status === 'COMPLETE',
      );
      expect(firstReplyIdx).toBeLessThan(firstTokenIdx);
      expect(firstTokenIdx).toBeLessThan(completeIdx);
    } finally {
      unsubscribe();
    }
  });

  it('concurrent turns on one session: no IDLE status until the last turn finishes', async () => {
    const { postId, sessionId, sandboxId } = await setupSession();

    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(postId, (ev) => received.push(ev));

    try {
      // 같은 세션/샌드박스에 두 질문을 동시에 던진다(런타임이 FIFO 큐로 직렬화).
      await Promise.all([
        runAgentTurn({
          post: { id: postId },
          session: { id: sessionId, sandboxId },
          prompt: 'first question here',
          lang: 'en',
        }),
        runAgentTurn({
          post: { id: postId },
          session: { id: sessionId, sandboxId },
          prompt: 'second question here',
          lang: 'en',
        }),
      ]);

      // 두 AGENT_REPLY 모두 COMPLETE.
      const completes = received.filter(
        (e) => e.type === 'message.updated' && e.status === 'COMPLETE',
      );
      expect(completes.length).toBe(2);

      // 핵심: 첫 session.status=IDLE 은 마지막 agent.token 이후에만 나와야 한다.
      //   (선점 시절/미수정 시 turn1 이 turn2 처리 중에 IDLE 를 쏴 깜빡임 → firstIdle < lastToken.)
      const lastTokenIdx = received.map((e) => e.type).lastIndexOf('agent.token');
      const firstIdleIdx = received.findIndex(
        (e) => e.type === 'session.status' && e.status === 'IDLE',
      );
      expect(lastTokenIdx).toBeGreaterThanOrEqual(0);
      expect(firstIdleIdx).toBeGreaterThan(lastTokenIdx);

      // 최종 DB 세션 IDLE.
      const sess = await prisma.agentSession.findUnique({ where: { id: sessionId } });
      expect(sess!.status).toBe('IDLE');
    } finally {
      unsubscribe();
    }
  });

  it('snapshot replay: GET-style afterSeq query returns prior messages', async () => {
    const { postId, sessionId, sandboxId, humanId } = await setupSession();
    await runAgentTurn({
      post: { id: postId },
      session: { id: sessionId, sandboxId },
      humanMessage: { id: humanId, body: 'replay me' },
      lang: 'en',
    });

    // afterSeq=0 스냅샷 = HUMAN(seq 1) + AGENT_REPLY(seq 2).
    const all = await prisma.message.findMany({
      where: { postId, seq: { gt: 0 } },
      orderBy: { seq: 'asc' },
    });
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].type).toBe('HUMAN');
    expect(all.some((m) => m.type === 'AGENT_REPLY')).toBe(true);

    // afterSeq=1 은 HUMAN 을 건너뛰고 AGENT_REPLY 부터.
    const afterHuman = await prisma.message.findMany({
      where: { postId, seq: { gt: 1 } },
      orderBy: { seq: 'asc' },
    });
    expect(afterHuman.every((m) => m.seq > 1)).toBe(true);
    expect(afterHuman[0].type).toBe('AGENT_REPLY');
  });
});
