// backend/src/plugins/rateLimit.ts
// M7 XC-RATE — 쓰기 라우트용 경량 인메모리 고정 윈도우 레이트리밋(TRD §8 남용 방지).
//
//   적용 대상(쓰기 경로만):
//     - POST /posts                 → config.rateLimit.postsPerWindow
//     - POST /posts/:id/messages    → config.rateLimit.messagesPerWindow
//   키: userId(인증) + ip(미인증/보강). 윈도우(config.rateLimit.windowMs) 내 횟수 초과 시 429.
//
//   설계 의도:
//     - GENEROUS 한도(기본 30 posts/min, 120 messages/min)로 정상 흐름/기존 테스트를 절대 막지 않는다.
//     - 기존 sandbox ConcurrencyLimiter(POST /posts 동시성 게이트)와 직교 합성 — 레이트리밋은
//       시간당 횟수, ConcurrencyLimiter 는 동시 점유. 둘 다 통과해야 한다.
//     - RATE_LIMIT_DISABLED=1 이면 완전 비활성(M1-M6 vitest/smoke 무영향).
//     - 단일 인스턴스 인메모리(다중 인스턴스는 후속 Redis 로 교체).
//
// 보안(CLAUDE.md/TRD §8): 키/PII 미로깅. 식별자는 userId/ip 뿐.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/** 고정 윈도우 카운터 1칸. */
interface Bucket {
  count: number;
  /** 윈도우 만료 시각(ms epoch). 지나면 리셋. */
  resetAt: number;
}

/**
 * 인메모리 고정 윈도우 카운터. (bucketKey) → Bucket.
 * hit() 은 허용 시 true(카운트 증가), 한도 초과면 false.
 */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * key 에 1회 시도를 기록한다. 윈도우 내 limit 이하면 true(허용),
   * 초과면 false(거부 → 429). 윈도우가 지났으면 리셋.
   */
  hit(key: string, now: number = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (b.count >= this.limit) {
      return false;
    }
    b.count += 1;
    return true;
  }

  /** 진단/테스트용: 현재 key 의 카운트(없으면 0). */
  countOf(key: string, now: number = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) return 0;
    return b.count;
  }

  /** 만료된 버킷을 청소(메모리 보호). 호출은 선택적. */
  sweep(now: number = Date.now()): void {
    for (const [k, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(k);
    }
  }
}

/** request 에서 레이트리밋 식별 키를 만든다: userId(있으면) + ip. */
function identityKey(req: FastifyRequest): string {
  const userId = req.authUser?.userId ?? 'anon';
  const ip = req.ip ?? 'noip';
  return `${userId}|${ip}`;
}

async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const { windowMs, postsPerWindow, messagesPerWindow } = config.rateLimit;
  const postsLimiter = new FixedWindowLimiter(postsPerWindow, windowMs);
  const messagesLimiter = new FixedWindowLimiter(messagesPerWindow, windowMs);

  // requireAuth 가 먼저 authUser 를 세팅하므로 onRequest 보다 늦은 preHandler 단계에서 게이트한다.
  // (실제 등록은 라우트 preHandler 다음으로 합성 — onRequest 는 authUser 가 아직 null 이라 ip 만 사용 가능.)
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (config.rateLimit.disabled) return;
    if (req.method !== 'POST') return;

    const url = req.routeOptions?.url ?? req.url;
    let limiter: FixedWindowLimiter | null = null;
    if (url === '/posts') {
      limiter = postsLimiter;
    } else if (url === '/posts/:id/messages') {
      limiter = messagesLimiter;
    }
    if (!limiter) return;

    const key = identityKey(req);
    if (!limiter.hit(key)) {
      return reply.code(429).send({ error: 'rate limit exceeded, retry later' });
    }
  });
}

export default fp(rateLimitPlugin, { name: 'rateLimit', dependencies: ['auth'] });
