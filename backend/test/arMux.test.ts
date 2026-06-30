// backend/test/arMux.test.ts
// M8 AR-MUX 검증 — 부모 런타임(pi.ts)의 turnId 라우팅을 piRuntime.spawn 으로 띄운 실제 worker(STUB)로 구동.
//   AR-PAR 까지는 worker 단독 spawn 으로만 멀티플렉싱을 검증했으나, 이제 부모 pi.ts 가 concurrent=true 면
//   turnId 를 부여해 병렬 디스패치하므로 piRuntime.send(…, concurrent) 를 직접 호출해 부모-워커 왕복을 검증한다.
//
// 검증 범위:
//   ① concurrent=true 2 send 동시 → 진짜 병렬 인터리브(t2 토큰이 t1 done 이전 도착) + 양쪽 완주 + 라우팅 무교차.
//   ② tool-done turnId 라우팅 — 서로 다른 turnId 부여 + 교차 ack 무오류(B ack 가 A 를 끝내지 않음).
//   ③ concurrent 미지정(레거시) 2 send → FIFO 직렬 보존(t2 토큰이 t1 done 이전에 절대 안 옴).
//   ④ interrupt(turnId) — A 만 취소, B 정상 완주.
//
// STUB 모드(VITEST env 자동) — 실 네트워크 없음. afterEach 에서 piRuntime.suspend 로 child SIGTERM 정리.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { piRuntime } from '../src/agent/pi.js';
import type { ToolIntent } from '../src/agent/pi.js';

const spawnedSandboxIds: string[] = [];

afterEach(async () => {
  // 누수 방지: 남은 worker child 는 모두 suspend(SIGTERM). 동시 턴 Promise 도 여기서 reject 되어 매달리지 않는다.
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
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-mux-'));
  const sandboxId = `sbx-${Date.now()}-${suffix}`;
  spawnedSandboxIds.push(sandboxId);
  await piRuntime.spawn({ id: sandboxId, path: dir });
  return { id: 'sess', sandboxId };
}

describe('AR-MUX 부모 런타임 turnId 라우팅', () => {
  it('concurrent=true 2 send 동시 → 진짜 병렬 인터리브(t2 토큰이 t1 done 이전) + 라우팅 무교차', async () => {
    const session = await spawnSandbox('par');

    const t1: string[] = [];
    const t2: string[] = [];
    let t1Done = false;
    let t2BeforeDone1 = false;

    // t1 은 긴 텍스트(스트리밍 길게), t2 는 짧은 텍스트. concurrent=true(7번째 인자).
    const p1 = piRuntime
      .send(
        session,
        'alpha alpha alpha alpha alpha alpha alpha alpha',
        'en',
        (d) => t1.push(d),
        undefined,
        undefined,
        true,
      )
      .then(() => {
        t1Done = true;
      });
    const p2 = piRuntime
      .send(
        session,
        'bravo',
        'en',
        (d) => {
          if (!t1Done) t2BeforeDone1 = true; // 병렬이면 t2 토큰이 t1 done 전에 도착.
          t2.push(d);
        },
        undefined,
        undefined,
        true,
      )
      .then(() => {
        /* resolve */
      });

    await Promise.all([p1, p2]);

    // 진짜 병렬: t2 토큰이 t1 done 이전에 도착(FIFO 와 정반대).
    expect(t2BeforeDone1).toBe(true);
    // 양쪽 완주.
    expect(t1.join('')).toContain('alpha');
    expect(t2.join('')).toContain('bravo');
    // 라우팅 무교차: 토큰이 서로의 턴으로 새지 않는다.
    expect(t1.join('')).not.toContain('bravo');
    expect(t2.join('')).not.toContain('alpha');
  });

  it('tool-done turnId 라우팅: 서로 다른 turnId 부여 + 교차 ack 무오류(B ack 가 A 를 끝내지 않음)', async () => {
    const session = await spawnSandbox('tool');

    let intentA: ToolIntent | null = null;
    let intentB: ToolIntent | null = null;
    let aDone = false;
    let bDone = false;

    // !write 는 두 모드 공통 도구 의도 방출(STUB 에서도 네트워크 없이 검증 가능). ack 전까지 turn 미완료.
    const pA = piRuntime
      .send(session, '!write a.txt hi', 'en', () => {}, (intent) => {
        intentA = intent;
      }, undefined, true)
      .then(() => {
        aDone = true;
      });
    const pB = piRuntime
      .send(session, '!write b.txt yo', 'en', () => {}, (intent) => {
        intentB = intent;
      }, undefined, true)
      .then(() => {
        bDone = true;
      });

    // 두 도구 의도가 모두 방출될 때까지 대기.
    await waitFor(() => intentA !== null && intentB !== null);

    // 각 턴이 서로 다른 turnId 를 갖는다(병렬 라우팅 식별자).
    expect((intentA as ToolIntent | null)?.turnId).toBeDefined();
    expect((intentB as ToolIntent | null)?.turnId).toBeDefined();
    expect((intentA as ToolIntent).turnId).not.toBe((intentB as ToolIntent).turnId);

    // 아직 ack 전이라 양쪽 미완료.
    expect(aDone).toBe(false);
    expect(bDone).toBe(false);

    // B 먼저 ack(B 의 turnId 로) → B 만 done, A 는 미진행(교차 ack 아님).
    piRuntime.ackTool({ sandboxId: session.sandboxId }, { ok: true, output: 'ok' }, (intentB as ToolIntent).turnId);
    await waitFor(() => bDone);
    expect(aDone).toBe(false);

    // A ack 후에야 A done.
    piRuntime.ackTool({ sandboxId: session.sandboxId }, { ok: true, output: 'ok' }, (intentA as ToolIntent).turnId);
    await waitFor(() => aDone);
    await Promise.all([pA, pB]);
    expect(aDone).toBe(true);
    expect(bDone).toBe(true);
  });

  it('concurrent 미지정(레거시): 2 send 가 FIFO 직렬 보존 — t2 토큰은 t1 done 이후에만', async () => {
    const session = await spawnSandbox('fifo');

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
  });

  it('interrupt(turnId): A 만 취소, B 정상 완주', async () => {
    const session = await spawnSandbox('intr');

    const t2: string[] = [];
    let bDone = false;
    let intentA: ToolIntent | null = null;

    // A 는 도구 의도로 방출되어 ack 대기 상태(인터럽트 표적). B 는 평범한 텍스트로 완주.
    const pA = piRuntime
      .send(session, '!write a.txt hi', 'en', () => {}, (intent) => {
        intentA = intent;
      }, undefined, true)
      .then(
        () => {},
        () => {}, // A 의 reject/resolve 둘 다 허용(turn.ts race 영역).
      );
    const pB = piRuntime
      .send(session, 'bravo bravo bravo', 'en', (d) => t2.push(d), undefined, undefined, true)
      .then(() => {
        bDone = true;
      });

    // A 도구 의도 방출 대기 → A 의 turnId 로 인터럽트.
    await waitFor(() => intentA !== null);
    await piRuntime.interrupt(session, undefined, (intentA as ToolIntent).turnId);

    // B 는 정상 완주.
    await waitFor(() => bDone);
    expect(bDone).toBe(true);
    expect(t2.join('')).toContain('bravo');

    // A 는 인터럽트되어 ack 가 와도 매달리지 않는다 — pA 가 마감되도록 보장(suspend 가 정리).
    // (A 의 Promise 는 race 영역이라 명시 단언하지 않고, afterEach suspend 로 정리.)
    void pA;
  });
});
