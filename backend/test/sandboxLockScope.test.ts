// backend/test/sandboxLockScope.test.ts
// XC-SCOPE(2026-07-28) — 부수효과 락을 "샌드박스 단위"에서 "충돌 단위"로 좁힌 것의 검증.
//
// 왜 필요한가: E2-B 실측에서 두 동시 턴이 모두 파일을 수정하면 병렬 이점이 1.07× 로 붕괴했다.
//   원인은 서로 **다른 파일**을 만지는 작업도 샌드박스 단일 mutex 에 줄을 섰기 때문이다.
//   이제 다른 경로는 병렬로 통과시키는데, **그 대가로 새 레이스를 만들지 않았는지**가 핵심이다.
//   따라서 "병렬이 되는가"뿐 아니 "직렬이어야 하는 조합이 여전히 직렬인가"를 전수 단언한다.
//
// 호환성 행렬(설계):
//   path(P) ↔ path(Q≠P)  : 병렬
//   path(P) ↔ path(P)     : 직렬
//   exclusive ↔ 무엇이든   : 직렬
//   (SHELL/PACKAGE/FILE_DELETE/미지 kind → exclusive 로 매핑됨 — turn.ts lockScopeFor)

import { describe, it, expect } from 'vitest';
import {
  withScopedSandboxLock,
  withSandboxLock,
  normalizeLockPath,
  activeSandboxLockKeys,
  runningCount,
} from '../src/agent/sandboxLock.js';

const tick = (ms = 15) => new Promise<void>((r) => setTimeout(r, ms));

/** 수동 게이트 — 작업을 원하는 시점까지 붙잡아 두고 겹침을 관측한다. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

const SBX = 'sbx-scope';

describe('XC-SCOPE — 다른 경로는 병렬', () => {
  it('서로 다른 경로의 path 락은 동시에 실행된다(이번 변경의 이득)', async () => {
    const order: string[] = [];
    const gA = gate();
    const gB = gate();

    const pA = withScopedSandboxLock(SBX, { mode: 'path', path: 'a.txt' }, async () => {
      order.push('A:start');
      await gA.p;
      order.push('A:end');
    });
    const pB = withScopedSandboxLock(SBX, { mode: 'path', path: 'b.txt' }, async () => {
      order.push('B:start');
      await gB.p;
      order.push('B:end');
    });

    await tick();
    // A 가 게이트에 걸려 있어도 B 는 이미 시작했다 = 병렬.
    expect(order).toEqual(['A:start', 'B:start']);
    expect(runningCount(SBX)).toBe(2);

    gA.open();
    gB.open();
    await Promise.all([pA, pB]);
  });

  it('N개의 서로 다른 경로가 모두 동시에 진행된다', async () => {
    const g = gate();
    const started: number[] = [];
    const ps = Array.from({ length: 8 }, (_, i) =>
      withScopedSandboxLock(SBX, { mode: 'path', path: `f${i}.txt` }, async () => {
        started.push(i);
        await g.p;
      }),
    );
    await tick();
    expect(started).toHaveLength(8);
    expect(runningCount(SBX)).toBe(8);
    g.open();
    await Promise.all(ps);
  });
});

describe('XC-SCOPE — 충돌하는 조합은 여전히 직렬(새 레이스 없음)', () => {
  it('같은 경로는 직렬화된다', async () => {
    const order: string[] = [];
    const gA = gate();

    const pA = withScopedSandboxLock(SBX, { mode: 'path', path: 'same.txt' }, async () => {
      order.push('A:start');
      await gA.p;
      order.push('A:end');
    });
    const pB = withScopedSandboxLock(SBX, { mode: 'path', path: 'same.txt' }, async () => {
      order.push('B:start');
    });

    await tick();
    expect(order).toEqual(['A:start']); // B 는 아직 시작조차 못 했다.
    gA.open();
    await Promise.all([pA, pB]);
    expect(order).toEqual(['A:start', 'A:end', 'B:start']);
  });

  it('exclusive(SHELL 등)는 path 작업과 겹치지 않는다 — 양방향', async () => {
    // (1) exclusive 가 먼저 실행 중이면 path 는 대기한다.
    const order: string[] = [];
    const gX = gate();
    const pX = withScopedSandboxLock(SBX, { mode: 'exclusive' }, async () => {
      order.push('X:start');
      await gX.p;
      order.push('X:end');
    });
    const pP = withScopedSandboxLock(SBX, { mode: 'path', path: 'z.txt' }, async () => {
      order.push('P:start');
    });
    await tick();
    expect(order).toEqual(['X:start']);
    gX.open();
    await Promise.all([pX, pP]);
    expect(order).toEqual(['X:start', 'X:end', 'P:start']);

    // (2) path 가 먼저 실행 중이면 exclusive 는 대기한다.
    const order2: string[] = [];
    const gP = gate();
    const pP2 = withScopedSandboxLock(SBX, { mode: 'path', path: 'z.txt' }, async () => {
      order2.push('P:start');
      await gP.p;
      order2.push('P:end');
    });
    const pX2 = withScopedSandboxLock(SBX, { mode: 'exclusive' }, async () => {
      order2.push('X:start');
    });
    await tick();
    expect(order2).toEqual(['P:start']);
    gP.open();
    await Promise.all([pP2, pX2]);
    expect(order2).toEqual(['P:start', 'P:end', 'X:start']);
  });

  it('exclusive 는 서로 직렬이다(SHELL 두 개)', async () => {
    const order: string[] = [];
    const g1 = gate();
    const p1 = withScopedSandboxLock(SBX, { mode: 'exclusive' }, async () => {
      order.push('1:start');
      await g1.p;
      order.push('1:end');
    });
    const p2 = withScopedSandboxLock(SBX, { mode: 'exclusive' }, async () => {
      order.push('2:start');
    });
    await tick();
    expect(order).toEqual(['1:start']);
    g1.open();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['1:start', '1:end', '2:start']);
  });
});

describe('XC-SCOPE — 공정성(엄격 FIFO, starvation 방지)', () => {
  it('대기 중인 exclusive 를 후속 path 작업이 추월하지 못한다', async () => {
    const order: string[] = [];
    const gA = gate();

    // A(path) 실행 중 → X(exclusive) 대기 → C(다른 path) 는 X 뒤에 줄 서야 한다.
    const pA = withScopedSandboxLock(SBX, { mode: 'path', path: 'a.txt' }, async () => {
      order.push('A:start');
      await gA.p;
      order.push('A:end');
    });
    await tick(5);
    const pX = withScopedSandboxLock(SBX, { mode: 'exclusive' }, async () => {
      order.push('X');
    });
    const pC = withScopedSandboxLock(SBX, { mode: 'path', path: 'c.txt' }, async () => {
      order.push('C');
    });

    await tick();
    // C 는 a.txt 와 경로가 달라 '호환'이지만, 앞선 X 를 추월하면 X 가 굶는다 → 대기해야 한다.
    expect(order).toEqual(['A:start']);

    gA.open();
    await Promise.all([pA, pX, pC]);
    expect(order).toEqual(['A:start', 'A:end', 'X', 'C']);
  });
});

describe('XC-SCOPE — 경로 키 정규화', () => {
  it('./ 와 중복 구분자를 같은 키로 본다', () => {
    expect(normalizeLockPath('./a/b.txt')).toBe(normalizeLockPath('a/b.txt'));
    expect(normalizeLockPath('a//b.txt')).toBe(normalizeLockPath('a/b.txt'));
    expect(normalizeLockPath('a/./b.txt')).toBe(normalizeLockPath('a/b.txt'));
  });

  it('백슬래시와 슬래시를 같은 키로 본다(Windows 경로 표기 혼용)', () => {
    expect(normalizeLockPath('a\\b.txt')).toBe(normalizeLockPath('a/b.txt'));
  });

  it('win32 에서는 대소문자를 무구분한다(같은 파일이므로 같은 키여야 한다)', () => {
    if (process.platform === 'win32') {
      expect(normalizeLockPath('A.TXT')).toBe(normalizeLockPath('a.txt'));
    } else {
      // POSIX 는 대소문자 구분 FS → 다른 파일이므로 다른 키여야 한다.
      expect(normalizeLockPath('A.TXT')).not.toBe(normalizeLockPath('a.txt'));
    }
  });

  it('대소문자만 다른 경로가 win32 에서 실제로 직렬화된다', async () => {
    if (process.platform !== 'win32') return;
    const order: string[] = [];
    const g = gate();
    const p1 = withScopedSandboxLock(SBX, { mode: 'path', path: normalizeLockPath('Case.txt') }, async () => {
      order.push('1:start');
      await g.p;
      order.push('1:end');
    });
    const p2 = withScopedSandboxLock(SBX, { mode: 'path', path: normalizeLockPath('case.TXT') }, async () => {
      order.push('2:start');
    });
    await tick();
    expect(order).toEqual(['1:start']); // 같은 파일 → 직렬
    g.open();
    await Promise.all([p1, p2]);
  });
});

describe('XC-SCOPE — 견고성', () => {
  it('reject 한 작업이 체인을 끊지 않는다(경로/배타 모두)', async () => {
    await expect(
      withScopedSandboxLock(SBX, { mode: 'path', path: 'err.txt' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const v = await withScopedSandboxLock(SBX, { mode: 'path', path: 'err.txt' }, async () => 42);
    expect(v).toBe(42);

    await expect(
      withScopedSandboxLock(SBX, { mode: 'exclusive' }, async () => {
        throw new Error('bang');
      }),
    ).rejects.toThrow('bang');
    expect(await withScopedSandboxLock(SBX, { mode: 'exclusive' }, async () => 7)).toBe(7);
  });

  it('다른 샌드박스 키는 서로 독립이다', async () => {
    const g = gate();
    const started: string[] = [];
    const p1 = withScopedSandboxLock('sbx-1', { mode: 'exclusive' }, async () => {
      started.push('s1');
      await g.p;
    });
    const p2 = withScopedSandboxLock('sbx-2', { mode: 'exclusive' }, async () => {
      started.push('s2');
    });
    await tick();
    expect(started).toContain('s1');
    expect(started).toContain('s2'); // 다른 샌드박스는 배타끼리도 병렬.
    g.open();
    await Promise.all([p1, p2]);
  });

  it('모두 끝나면 키가 정리된다(누수 없음)', async () => {
    await Promise.all([
      withScopedSandboxLock('sbx-clean-1', { mode: 'path', path: 'x' }, async () => 1),
      withScopedSandboxLock('sbx-clean-1', { mode: 'path', path: 'y' }, async () => 2),
      withScopedSandboxLock('sbx-clean-2', { mode: 'exclusive' }, async () => 3),
      withSandboxLock('sbx-clean-3', async () => 4),
    ]);
    await tick(10);
    expect(activeSandboxLockKeys()).toBe(0);
  });
});
