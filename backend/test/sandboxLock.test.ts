// backend/test/sandboxLock.test.ts
// XC-SERIAL(M8) — 샌드박스 단위 부수효과 직렬 lock 프리미티브 검증.
// 단언:
//   (1) 같은 key 작업은 직렬(겹침 0) — 두 번째 fn 은 첫 fn 이 끝난 뒤에만 시작.
//   (2) 다른 key 는 동시 진행(독립).
//   (3) 한 작업의 reject 가 체인을 끊지 않는다(다음 대기자 정상 진행).
//   (4) 작업 결과(성공/실패)는 호출부로 그대로 전달된다.
//   (5) 모두 끝나면 키가 정리된다(누수 없음).

import { describe, it, expect } from 'vitest';
import { withSandboxLock, activeSandboxLockKeys } from '../src/agent/sandboxLock.js';

const tick = (ms = 15) => new Promise<void>((r) => setTimeout(r, ms));

describe('withSandboxLock (XC-SERIAL — 샌드박스 단위 직렬 lock)', () => {
  it('serializes same-key operations (no overlap)', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });

    const pA = withSandboxLock('sbx-1', async () => {
      order.push('A:start');
      await aGate;
      order.push('A:end');
    });
    const pB = withSandboxLock('sbx-1', async () => {
      order.push('B:start');
      order.push('B:end');
    });

    // A 가 게이트에 걸려있는 동안 B 는 lock 대기 — 아직 시작도 못 한다.
    await tick();
    expect(order).toEqual(['A:start']);

    releaseA();
    await Promise.all([pA, pB]);
    // 완전 직렬: A 끝난 뒤에야 B 시작.
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('runs different keys concurrently (independent locks)', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });

    const pA = withSandboxLock('sbx-A', async () => {
      order.push('A:start');
      await aGate;
      order.push('A:end');
    });
    const pB = withSandboxLock('sbx-B', async () => {
      order.push('B:start');
      order.push('B:end');
    });

    // 다른 key 라 A 가 막혀 있어도 B 는 완료된다.
    await tick();
    expect(order).toContain('B:start');
    expect(order).toContain('B:end');
    expect(order).not.toContain('A:end');

    releaseA();
    await Promise.all([pA, pB]);
  });

  it('a rejecting op does not break the chain; result is propagated', async () => {
    await expect(
      withSandboxLock('sbx-err', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 직전 작업이 reject 했어도 다음 작업은 정상 진행되고 결과를 그대로 받는다.
    const v = await withSandboxLock('sbx-err', async () => 42);
    expect(v).toBe(42);
  });

  it('cleans up keys after all ops settle (no leak)', async () => {
    await withSandboxLock('sbx-clean', async () => 'x');
    // microtask 정리 여유.
    await tick(5);
    expect(activeSandboxLockKeys()).toBe(0);
  });
});
