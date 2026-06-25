// backend/test/metrics.test.ts
// M7 BE-METRICS 검증:
//   - GET /metrics 는 시드 데이터로부터 집계 숫자를 반환한다.
//   - 모든 값은 유한 숫자(NaN/Infinity 아님) — 0 division 방어 확인.
//   - avgAgentTurnsPerPost / uniqueParticipantsPerThread / sessionSuccessRate 가 합리적 범위.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

let app: FastifyInstance;
const created = {
  userIds: [] as string[],
  postIds: [] as string[],
  sandboxIds: [] as string[],
  sessionIds: [] as string[],
};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const u1 = await prisma.user.create({ data: { username: `mx-a-${tag}` } });
  const u2 = await prisma.user.create({ data: { username: `mx-b-${tag}` } });
  created.userIds.push(u1.id, u2.id);

  // post1: HUMAN(u1)+HUMAN(u2) 2명 참여, AGENT_REPLY 2개.
  const p1 = await prisma.post.create({ data: { authorId: u1.id, title: 'mx1', body: '' } });
  const p2 = await prisma.post.create({ data: { authorId: u1.id, title: 'mx2', body: '' } });
  created.postIds.push(p1.id, p2.id);

  let seq = 0;
  await prisma.message.create({
    data: { postId: p1.id, authorId: u1.id, type: 'HUMAN', status: 'COMPLETE', body: 'q', seq: ++seq },
  });
  await prisma.message.create({
    data: { postId: p1.id, authorId: u2.id, type: 'HUMAN', status: 'COMPLETE', body: 'q2', seq: ++seq },
  });
  await prisma.message.create({
    data: { postId: p1.id, authorId: null, type: 'AGENT_REPLY', status: 'COMPLETE', body: 'a', seq: ++seq },
  });
  await prisma.message.create({
    data: { postId: p1.id, authorId: null, type: 'AGENT_REPLY', status: 'COMPLETE', body: 'a2', seq: ++seq },
  });
  // post2: HUMAN(u1) 1명, AGENT_REPLY 0.
  await prisma.message.create({
    data: { postId: p2.id, authorId: u1.id, type: 'HUMAN', status: 'COMPLETE', body: 'q', seq: 1 },
  });

  // 샌드박스 + 세션: 1 STOPPED(성공), 1 ERROR(실패).
  const sb = await prisma.sandbox.create({
    data: { postId: p1.id, path: `/tmp/mx-${tag}-1`, status: 'READY', runtime: 'pi' },
  });
  const sb2 = await prisma.sandbox.create({
    data: { postId: p2.id, path: `/tmp/mx-${tag}-2`, status: 'READY', runtime: 'pi' },
  });
  created.sandboxIds.push(sb.id, sb2.id);

  const s1 = await prisma.agentSession.create({
    data: { sandboxId: sb.id, status: 'STOPPED', model: 'test', endedAt: new Date() },
  });
  const s2 = await prisma.agentSession.create({
    data: { sandboxId: sb2.id, status: 'ERROR', model: 'test', endedAt: new Date() },
  });
  created.sessionIds.push(s1.id, s2.id);
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { postId: { in: created.postIds } } });
  await prisma.agentSession.deleteMany({ where: { id: { in: created.sessionIds } } });
  await prisma.sandbox.deleteMany({ where: { id: { in: created.sandboxIds } } });
  await prisma.post.deleteMany({ where: { id: { in: created.postIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  await app.close();
  await prisma.$disconnect();
});

describe('M7 metrics', () => {
  it('GET /metrics returns finite numbers (no NaN/Infinity) from seeded data', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      avgAgentTurnsPerPost: number;
      uniqueParticipantsPerThread: number;
      sessionSuccessRate: number;
    };

    for (const key of ['avgAgentTurnsPerPost', 'uniqueParticipantsPerThread', 'sessionSuccessRate'] as const) {
      expect(typeof body[key]).toBe('number');
      expect(Number.isFinite(body[key])).toBe(true);
      expect(body[key]).toBeGreaterThanOrEqual(0);
    }

    // 시드: 전체에 AGENT_REPLY 가 존재하므로 평균 turns > 0.
    expect(body.avgAgentTurnsPerPost).toBeGreaterThan(0);
    // 우리 시드에 HUMAN 참여자가 있으므로 평균 참여자 > 0.
    expect(body.uniqueParticipantsPerThread).toBeGreaterThan(0);
    // 성공률은 0~1 사이(STOPPED/(STOPPED+ERROR)). 시드에 둘 다 있으므로 (0,1) 범위.
    expect(body.sessionSuccessRate).toBeGreaterThan(0);
    expect(body.sessionSuccessRate).toBeLessThanOrEqual(1);
  });
});
