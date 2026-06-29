// backend/test/xcCap.test.ts
// M8 XC-CAP 검증 — 부모 런타임(pi.ts)의 동시성 cap + per-user 1활성턴 게이트 + 공정 큐를
//   piRuntime.spawn 으로 띄운 실제 worker(STUB)로 구동. send 8번째 옵셔널 positional `userId` 사용.
//
// 검증 범위:
//   ① per-user 게이트(같은 userId 직렬, cap 무관) — 같은 userId 2건은 cap 여유에도 직렬.
//   ② 다른 userId 병렬 — 게이트 미적용, 둘 다 즉시 inflight.
//   ③ cap(서로 다른 4명 → 동시 3 + 큐 1) — MAX_CONCURRENT_TURNS='3'(vitest env) 고정.
//   ④ 공정성(한 사용자 독점 방지) — u1 2건 + u2 1건 → u2 가 기아 없이 슬롯 획득.
//   ⑤ 레거시 무영향(arMux ③ 복제) — concurrent 미지정 FIFO 직렬 + concurrentQueue 항상 0.
//
// STUB 모드(VITEST env 자동) — 실 네트워크 없음. `!write` 는 도구 의도 방출 + ack 대기로
//   활성 턴 수명을 결정적으로 제어한다(arMux ②④ 패턴). introspection(inflightTurns/queuedConcurrent)
//   으로 결정적 관측. afterEach 에서 piRuntime.suspend 로 child SIGTERM 정리.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { piRuntime, inflightTurns, queuedConcurrent } from '../src/agent/pi.js';
import type { ToolIntent } from '../src/agent/pi.js';

/** vitest.config.ts env 와 동기화된 cap(결정성). */
const CAP = 3;

const spawnedSandboxIds: string[] = [];

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

/** 조건이 참이 될 때까지 폴링(고정 sleep 금지, 타임아웃 안전). */
async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function spawnSandbox(suffix: string): Promise<{ id: string; sandboxId: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-cap-'));
  const sandboxId = `sbx-${Date.now()}-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
  spawnedSandboxIds.push(sandboxId);
  await piRuntime.spawn({ id: sandboxId, path: dir });
  return { id: 'sess', sandboxId };
}

/**
 * concurrent send 를 userId 게이트와 함께 발사하는 헬퍼.
 *   8번째 positional=userId, 7번째=concurrent(true). resolve/reject 둘 다 흡수(turn.ts race 영역).
 */
function sendConcurrent(
  session: { id: string; sandboxId: string },
  input: string,
  userId: string | null,
  onIntent: (i: ToolIntent) => void,
): Promise<void> {
  return piRuntime
    .send(session, input, 'en', () => {}, (i) => onIntent(i), undefined, true, userId)
    .then(
      () => {},
      () => {}, // 인터럽트/suspend 로 reject 될 수 있으므로 흡수.
    );
}

describe('XC-CAP 동시성 cap + per-user 게이트 + 공정 큐', () => {
  it('① per-user 게이트: 같은 userId 2건은 cap 여유에도 직렬(t2 는 t1 완료까지 대기)', async () => {
    const session = await spawnSandbox('user-serial');
    const sid = session.sandboxId;

    let intentA: ToolIntent | null = null;
    let intentB: ToolIntent | null = null;

    // 같은 userId 'u1' 로 !write 2건. cap=3 이지만 per-user=1 게이트로 직렬이어야 한다.
    void sendConcurrent(session, '!write a.txt hi', 'u1', (i) => { intentA = i; });
    void sendConcurrent(session, '!write b.txt yo', 'u1', (i) => { intentB = i; });

    // t1 만 inflight, t2 는 게이트로 큐 대기.
    await waitFor(() => intentA !== null);
    await waitFor(() => inflightTurns(sid) === 1 && queuedConcurrent(sid) === 1);
    expect(intentB).toBeNull(); // t2 아직 디스패치 안 됨(게이트 작동).

    // t1 ack → done → pump → t2 디스패치.
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (intentA as ToolIntent).turnId);
    await waitFor(() => inflightTurns(sid) === 1 && queuedConcurrent(sid) === 0);
    await waitFor(() => intentB !== null); // 비로소 t2 의도 방출.

    // t2 ack → 양쪽 종료.
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (intentB as ToolIntent).turnId);
    await waitFor(() => inflightTurns(sid) === 0 && queuedConcurrent(sid) === 0);
  });

  it('② 다른 userId 2건은 병렬(게이트 미적용, 둘 다 즉시 inflight)', async () => {
    const session = await spawnSandbox('user-par');
    const sid = session.sandboxId;

    let intentA: ToolIntent | null = null;
    let intentB: ToolIntent | null = null;

    void sendConcurrent(session, '!write a.txt hi', 'u1', (i) => { intentA = i; });
    void sendConcurrent(session, '!write b.txt yo', 'u2', (i) => { intentB = i; });

    // 둘 다 즉시 inflight(cap=3 ≥ 2, 서로 다른 userId → 게이트 미적용).
    await waitFor(() => inflightTurns(sid) === 2 && queuedConcurrent(sid) === 0);
    await waitFor(() => intentA !== null && intentB !== null);
    // 서로 다른 turnId(병렬 라우팅).
    expect((intentA as ToolIntent).turnId).not.toBe((intentB as ToolIntent).turnId);

    // 정리.
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (intentA as ToolIntent).turnId);
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (intentB as ToolIntent).turnId);
    await waitFor(() => inflightTurns(sid) === 0);
  });

  it('③ cap: 서로 다른 4명 → 동시 3 + 큐 1, 완료 시 4번째 디스패치', async () => {
    const session = await spawnSandbox('cap');
    const sid = session.sandboxId;

    const intents: Record<string, ToolIntent | null> = { u1: null, u2: null, u3: null, u4: null };
    for (const u of ['u1', 'u2', 'u3', 'u4']) {
      void sendConcurrent(session, `!write ${u}.txt hi`, u, (i) => { intents[u] = i; });
    }

    // cap=3 → 동시 3 inflight, 4번째는 큐 대기.
    await waitFor(() => inflightTurns(sid) === CAP && queuedConcurrent(sid) === 1);

    // 디스패치된 3건의 turnId 를 수집(어떤 사용자 3명인지는 순서 무관, FIFO 라 u1/u2/u3).
    await waitFor(() => intents.u1 !== null && intents.u2 !== null && intents.u3 !== null);
    expect(intents.u4).toBeNull(); // 4번째는 큐 대기.

    // u1 ack → done → pump → 4번째(u4) 디스패치.
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (intents.u1 as ToolIntent).turnId);
    await waitFor(() => inflightTurns(sid) === CAP && queuedConcurrent(sid) === 0);
    await waitFor(() => intents.u4 !== null);

    // 나머지 전부 ack 로 종료.
    for (const u of ['u2', 'u3', 'u4']) {
      piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (intents[u] as ToolIntent).turnId);
    }
    await waitFor(() => inflightTurns(sid) === 0 && queuedConcurrent(sid) === 0);
  });

  it('④ 공정성: u1 2건 + u2 1건 → u2 가 기아 없이 슬롯 획득(독점 방지)', async () => {
    const session = await spawnSandbox('fair');
    const sid = session.sandboxId;

    let u1a: ToolIntent | null = null;
    let u1b: ToolIntent | null = null;
    let u2: ToolIntent | null = null;

    // u1 첫건, u2 건, u1 둘째건 순으로 발사. cap=3 이나 per-user=1 → inflight={u1첫,u2}, queued={u1둘째}.
    void sendConcurrent(session, '!write u1a.txt hi', 'u1', (i) => { u1a = i; });
    void sendConcurrent(session, '!write u2.txt hi', 'u2', (i) => { u2 = i; });
    void sendConcurrent(session, '!write u1b.txt hi', 'u1', (i) => { u1b = i; });

    // u1 첫건 + u2 inflight, u1 둘째건은 게이트로 큐 대기(u2 가 기아 없이 슬롯 확보).
    await waitFor(() => inflightTurns(sid) === 2 && queuedConcurrent(sid) === 1);
    await waitFor(() => u1a !== null && u2 !== null);
    expect(u1b).toBeNull(); // u1 둘째건은 u1 첫건이 끝나야 디스패치.

    // u1 첫건 ack → done → pump → u1 둘째건 디스패치.
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (u1a as ToolIntent).turnId);
    await waitFor(() => u1b !== null);
    expect(inflightTurns(sid)).toBe(2); // u2 + u1둘째건.

    // 정리.
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (u2 as ToolIntent).turnId);
    piRuntime.ackTool({ sandboxId: sid }, { ok: true, output: 'ok' }, (u1b as ToolIntent).turnId);
    await waitFor(() => inflightTurns(sid) === 0 && queuedConcurrent(sid) === 0);
  });

  it('⑤ 레거시 무영향: concurrent 미지정 2 send 는 FIFO 직렬 + concurrentQueue 항상 0', async () => {
    const session = await spawnSandbox('legacy');
    const sid = session.sandboxId;

    const order: string[] = [];
    let firstDone = false;
    let t2BeforeDone1 = false;
    const t1: string[] = [];
    const t2: string[] = [];

    // concurrent 인자 미지정 → 레거시 FIFO 경로(오늘과 100% 동일).
    const p1 = piRuntime.send(session, 'first', 'en', (d) => t1.push(d)).then(() => {
      firstDone = true;
      order.push('done1');
    });
    const p2 = piRuntime
      .send(session, 'second', 'en', (d) => {
        if (!firstDone) t2BeforeDone1 = true;
        t2.push(d);
      })
      .then(() => order.push('done2'));

    await Promise.all([p1, p2]);

    expect(t1.join('')).toContain('first');
    expect(t2.join('')).toContain('second');
    // FIFO 직렬: 둘째 턴 토큰은 첫 턴 done 이후에만.
    expect(t2BeforeDone1).toBe(false);
    expect(order).toEqual(['done1', 'done2']);
    // 회귀 가드: 레거시는 concurrentQueue 를 절대 사용하지 않는다.
    expect(queuedConcurrent(sid)).toBe(0);
  });
});
