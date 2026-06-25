// backend/test/limiter.test.ts
// BE-LIMIT 검증: max 초과 시 tryAcquire false, release 후 다시 true.

import { describe, it, expect } from 'vitest';
import { ConcurrencyLimiter } from '../src/sandbox/limiter.js';

describe('ConcurrencyLimiter', () => {
  it('returns false beyond max and true again after release', () => {
    const limiter = new ConcurrencyLimiter(2);

    expect(limiter.tryAcquire()).toBe(true); // 1/2
    expect(limiter.tryAcquire()).toBe(true); // 2/2
    expect(limiter.active).toBe(2);

    // 용량 초과 — 거부.
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.hasCapacity()).toBe(false);

    // 한 슬롯 반납 → 다시 획득 가능.
    limiter.release();
    expect(limiter.hasCapacity()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true); // 2/2 다시
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('release does not underflow below zero', () => {
    const limiter = new ConcurrencyLimiter(1);
    limiter.release();
    limiter.release();
    expect(limiter.active).toBe(0);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('rejects an invalid max', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
    expect(() => new ConcurrencyLimiter(-1)).toThrow();
  });
});
