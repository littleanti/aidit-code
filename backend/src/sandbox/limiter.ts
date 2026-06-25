// backend/src/sandbox/limiter.ts
// 샌드박스 프로비저닝/활성 실행 동시성 제한(TRD §8 레이트/남용: 동시 생성·실행 수 제한).
//   - 운영자 LLM 키 비용 보호를 위해 동시에 진행되는 provision/run 슬롯 수를 제한한다.
//   - 단일 인스턴스 인메모리 카운터. 다중 인스턴스 확장은 후속(Redis/세마포어)로 교체.
//   - tryAcquire(): 용량 초과면 false(호출부가 429). acquire/release 는 명시적으로 짝맞춘다.

/** 단순 인메모리 동시성 슬롯 제한기. */
export class ConcurrencyLimiter {
  private inUse = 0;

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`ConcurrencyLimiter max must be a positive integer, got ${max}`);
    }
  }

  /** 현재 점유 슬롯 수. */
  get active(): number {
    return this.inUse;
  }

  /** 최대 동시 슬롯 수. */
  get capacity(): number {
    return this.max;
  }

  /** 여유 슬롯이 있는지(획득 없이 조회만). */
  hasCapacity(): boolean {
    return this.inUse < this.max;
  }

  /**
   * 슬롯을 시도 획득한다. 성공 시 점유하고 true, 용량 초과면 false(호출부는 429).
   * 비차단(non-blocking) — 대기/큐잉하지 않는다.
   */
  tryAcquire(): boolean {
    if (this.inUse >= this.max) return false;
    this.inUse += 1;
    return true;
  }

  /**
   * 슬롯을 무조건 획득한다(카운터 증가). 용량 초과 판단 없이 점유만 한다.
   * 호출부가 사전에 tryAcquire 로 게이트했을 때 사용. 균형을 위해 release 와 짝맞춘다.
   */
  acquire(): void {
    this.inUse += 1;
  }

  /** 슬롯을 반납한다. 0 미만으로 내려가지 않도록 보호. release 누락/중복에 안전. */
  release(): void {
    if (this.inUse > 0) this.inUse -= 1;
  }
}
