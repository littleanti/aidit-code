// backend/test/rtMulti.test.ts
// M8 RT-MULTI 검증 — session.status 이벤트에 통합 활성 턴 수(activeTurns)를 표면화하는지.
//   PLAN 스펙: 단일 IDLE/RUNNING → 활성 턴 카운트(RUNNING=활성≥1, IDLE=활성0). 동시 다중 턴이
//   돌 때 "지금 몇 개의 턴이 활성인가"를 클라이언트가 알 수 있어야 한다.
//
// 검증 범위:
//   (A) activeTurnCount standalone export 단위 — 핸들 없음 0 / concurrent 1 inflight 1 / 2건 2 / ack 후 0.
//   (B) concurrent 2턴(다른 userId, turn.ts 경유) → session.status 의 activeTurns 최대값 2 도달,
//       둘 다 끝난 뒤 마지막 session.status 가 status===IDLE && activeTurns===0.
//   (C) 레거시 단일 턴(meta 미설정) → RUNNING 이벤트 activeTurns===1, IDLE 이벤트 activeTurns===0(오늘 동치).
//   (D) 기존 무영향 회귀는 agentTurn.test.ts("concurrent turns on one session")가 그대로 통과로 확인(여기 재단언 불필요).
//
// STUB 모드(VITEST env 자동) — 실 네트워크 없음. (A)는 xcCap 하버스(!write+ack 수명 제어 + introspection 폴링),
//   (B)(C)는 agentTurn 패턴(bus.subscribe 수집 + setupSession + runAgentTurn). afterEach 에서 piRuntime.suspend.

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/db.js';
import { bus } from '../src/realtime/pubsub.js';
import type { RealtimeEvent } from '../src/realtime/events.js';
import { piRuntime, inflightTurns, queuedConcurrent, activeTurnCount } from '../src/agent/pi.js';
import type { ToolIntent } from '../src/agent/pi.js';
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

/** 조건이 참이 될 때까지 폴링(고정 sleep 금지, 타임아웃 안전). */
async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** (A) 용: piRuntime.spawn 으로 worker(STUB)만 띄운다(DB row 불필요). */
async function spawnBare(suffix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rt-bare-'));
  const sandboxId = `sbx-${Date.now()}-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
  spawnedSandboxIds.push(sandboxId);
  await piRuntime.spawn({ id: sandboxId, path: dir });
  return sandboxId;
}

/** (A) 용: concurrent send 발사(8번째 userId, 7번째 concurrent=true). resolve/reject 흡수. */
function sendConcurrent(
  sandboxId: string,
  input: string,
  userId: string | null,
  onIntent: (i: ToolIntent) => void,
): Promise<void> {
  return piRuntime
    .send({ id: 'sess', sandboxId }, input, 'en', () => {}, (i) => onIntent(i), undefined, true, userId)
    .then(() => {}, () => {});
}

/**
 * (B)(C) 용: turn.ts 를 거치는 완전한 세션 구성. concurrent=true 면 sandbox.meta 에
 *   {"concurrentTurns":true} 를 심어 getSandboxConcurrent 가 true 를 반환하게 한다(xcCap 의 직접 send 와 달리 필요).
 */
async function setupSession(opts: { concurrent: boolean }): Promise<{
  postId: string;
  sessionId: string;
  sandboxId: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rt-turn-'));
  const user = await prisma.user.create({
    data: { username: `rt-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  const post = await prisma.post.create({
    data: { authorId: user.id, title: 'rt-multi test', body: '' },
  });
  const sandbox = await prisma.sandbox.create({
    data: {
      postId: post.id,
      path: dir,
      status: 'RUNNING',
      runtime: 'pi',
      // concurrent 경로는 turn.ts 의 getSandboxConcurrent 가 meta 로 판정한다.
      meta: opts.concurrent ? JSON.stringify({ concurrentTurns: true }) : null,
    },
  });
  const { pid } = await piRuntime.spawn({ id: sandbox.id, path: dir });
  spawnedSandboxIds.push(sandbox.id);
  const session = await prisma.agentSession.create({
    data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test-model', runtimePid: pid },
  });
  cleanup.push({ userId: user.id, postId: post.id, sandboxId: sandbox.id, sessionId: session.id });
  return { postId: post.id, sessionId: session.id, sandboxId: sandbox.id };
}

/** session.status 이벤트에서 activeTurns 만 안전 추출. */
function sessionStatusEvents(received: RealtimeEvent[]): Array<{ status: string; activeTurns?: number }> {
  return received
    .filter((e) => e.type === 'session.status')
    .map((e) => (e.type === 'session.status' ? { status: e.status, activeTurns: e.activeTurns } : { status: '' }));
}

describe('RT-MULTI session.status 활성 턴 수 표면화', () => {
  it('(A) activeTurnCount standalone: 핸들 없음 0 / concurrent 1 inflight 1 / 2건 2 / ack 후 0', async () => {
    // 핸들 없음 → 0.
    expect(activeTurnCount('no-such-sandbox')).toBe(0);

    const sid = await spawnBare('count');
    expect(activeTurnCount(sid)).toBe(0); // spawn 직후 활성 턴 없음.

    let intentA: ToolIntent | null = null;
    let intentB: ToolIntent | null = null;

    // concurrent 1건(!write + 미ack) → inflight 1 → activeTurnCount 1.
    void sendConcurrent(sid, '!write a.txt hi', 'u1', (i) => { intentA = i; });
    await waitFor(() => inflightTurns(sid) === 1);
    expect(activeTurnCount(sid)).toBe(1);

    // 다른 userId 2건째 → inflight 2 → activeTurnCount 2.
    void sendConcurrent(sid, '!write b.txt yo', 'u2', (i) => { intentB = i; });
    await waitFor(() => inflightTurns(sid) === 2);
    expect(activeTurnCount(sid)).toBe(2);
    await waitFor(() => intentA !== null && intentB !== null);

    // 둘 다 ack → 종료 → 0.
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (intentA as ToolIntent).turnId);
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (intentB as ToolIntent).turnId);
    await waitFor(() => inflightTurns(sid) === 0);
    expect(activeTurnCount(sid)).toBe(0);
  });

  it('(B) concurrent 2턴(다른 userId): session.status 의 activeTurns 가 2 도달, 종료 후 IDLE+0', async () => {
    const { postId, sessionId, sandboxId } = await setupSession({ concurrent: true });

    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(postId, (ev) => received.push(ev));

    try {
      // 결정성 확보: turn1 을 먼저 기동하고 실제 inflight(activeTurnCount===1)가 될 때까지 기다린 뒤
      //   turn2 를 기동한다. turn1 은 긴 프롬프트(많은 토큰 청크 × TOKEN_DELAY)로 스트리밍이 길어
      //   turn2 의 step2(RUNNING publish)가 turn1 inflight 중에 확실히 일어난다. → turn2 RUNNING 은
      //   (turn1 포함=1)+1 self 보정 = activeTurns:2 를 결정적으로 싣는다(병렬 디스패치 setup race 제거).
      const longPrompt = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
      const p1 = runAgentTurn({
        post: { id: postId },
        session: { id: sessionId, sandboxId },
        prompt: longPrompt,
        lang: 'en',
        userId: 'userA',
      });
      // turn1 이 런타임에 실제 등록(inflight)될 때까지 대기 — concurrent 경로라 activeTurns Map 에 들어간다.
      await waitFor(() => activeTurnCount(sandboxId) >= 1);
      const p2 = runAgentTurn({
        post: { id: postId },
        session: { id: sessionId, sandboxId },
        prompt: 'second parallel question please answer',
        lang: 'en',
        userId: 'userB',
      });
      await Promise.all([p1, p2]);

      const evs = sessionStatusEvents(received);
      // 활성 턴 수 2가 관측돼야 한다(동시 2턴 표면화). step2 +1 self 보정이 두 번째 턴 RUNNING 에서
      //   (turn1 포함=1)+1=2 를 보장.
      const maxActive = Math.max(...evs.map((e) => e.activeTurns ?? 0));
      expect(maxActive).toBe(2);

      // RUNNING 이벤트는 activeTurns≥1.
      for (const e of evs) {
        if (e.status === 'RUNNING') expect((e.activeTurns ?? 0)).toBeGreaterThanOrEqual(1);
      }

      // 마지막 session.status 는 IDLE + activeTurns 0(둘 다 끝나면 활성 0 수렴).
      const last = evs[evs.length - 1];
      expect(last.status).toBe('IDLE');
      expect(last.activeTurns).toBe(0);

      // 모든 IDLE 이벤트는 activeTurns 0 을 싣는다(isBusy 게이트 통과 = 잔여 활성 0).
      //   주의: concurrent 경로에선 두 턴이 거의 동시에 마감되면 각자 IDLE(0) 을 쏠 수 있다
      //   (둘 다 이미 de-count 된 뒤이므로 둘 다 게이트 통과 — 둘 다 0). 깜빡임 아님(상태 동일).
      //   "중간 IDLE 깜빡임 없음(IDLE 1회)" 불변식은 레거시 FIFO 경로(agentTurn.test) 가 검증한다.
      for (const e of evs) {
        if (e.status === 'IDLE') expect(e.activeTurns).toBe(0);
      }

      // 최종 DB 세션 IDLE.
      const sess = await prisma.agentSession.findUnique({ where: { id: sessionId } });
      expect(sess!.status).toBe('IDLE');

      // 키 누출 없음.
      expect(JSON.stringify(received)).not.toMatch(/apiKey|API_KEY|baseURL|BASE_URL|sk-[A-Za-z0-9]/i);
    } finally {
      unsubscribe();
    }
  });

  it('(C) 레거시 단일 턴(meta 미설정): RUNNING=1 / IDLE=0 (오늘 RUNNING→IDLE 동치)', async () => {
    const { postId, sessionId, sandboxId } = await setupSession({ concurrent: false });

    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(postId, (ev) => received.push(ev));

    try {
      await runAgentTurn({
        post: { id: postId },
        session: { id: sessionId, sandboxId },
        prompt: 'single legacy question',
        lang: 'en',
      });

      const evs = sessionStatusEvents(received);
      const running = evs.find((e) => e.status === 'RUNNING');
      const idle = evs.find((e) => e.status === 'IDLE');
      expect(running).toBeDefined();
      expect(idle).toBeDefined();
      // 레거시: activeTurnCount=(activeTurn?1:0)+0 → step2 0+1=1, step5 0.
      expect(running!.activeTurns).toBe(1);
      expect(idle!.activeTurns).toBe(0);

      // 시퀀스: RUNNING 이 IDLE 보다 앞(오늘 RUNNING→IDLE 1:1, 필드만 추가).
      const runIdx = evs.findIndex((e) => e.status === 'RUNNING');
      const idleIdx = evs.findIndex((e) => e.status === 'IDLE');
      expect(runIdx).toBeLessThan(idleIdx);

      const sess = await prisma.agentSession.findUnique({ where: { id: sessionId } });
      expect(sess!.status).toBe('IDLE');
    } finally {
      unsubscribe();
    }
  });
});
