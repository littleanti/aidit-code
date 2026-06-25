// backend/src/routes/metrics.ts
// M7 BE-METRICS (TRD §4):
//   GET /metrics → {
//     avgAgentTurnsPerPost,        // post 당 AGENT_REPLY 버블 수 평균
//     uniqueParticipantsPerThread, // post(스레드) 당 고유 HUMAN 작성자 수 평균
//     sessionSuccessRate           // AgentSession 성공(정상 종료=STOPPED) 비율 vs ERROR
//   }
//   - DB 집계 기반 best-effort PoC. 희소 데이터 허용(0 division 금지 — 분모 0이면 0 반환).
//   - 인증 불필요(공개 PoC 지표). 키/PII 미노출(집계 수치만).
//
// 보안(CLAUDE.md/TRD §8): LLM 키/원문 미노출. 순수 숫자 집계만 반환한다.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

/** 0으로 나누지 않는 안전 나눗셈(분모 0이면 0). */
function safeDiv(numer: number, denom: number): number {
  if (!denom) return 0;
  return numer / denom;
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    // 분모: 전체 post 수(스레드 수). 0이면 모든 평균은 0.
    const totalPosts = await prisma.post.count();

    // ── avgAgentTurnsPerPost: 전체 AGENT_REPLY 버블 수 / 전체 post 수 ──
    const agentReplyCount = await prisma.message.count({ where: { type: 'AGENT_REPLY' } });
    const avgAgentTurnsPerPost = safeDiv(agentReplyCount, totalPosts);

    // ── uniqueParticipantsPerThread: post 당 고유 HUMAN 작성자 수의 평균 ──
    // (postId, authorId) distinct 쌍 수 / post 수. authorId null(에이전트/시스템)은 제외.
    const humanPairs = await prisma.message.findMany({
      where: { type: 'HUMAN', authorId: { not: null } },
      distinct: ['postId', 'authorId'],
      select: { postId: true },
    });
    const uniqueParticipantsPerThread = safeDiv(humanPairs.length, totalPosts);

    // ── sessionSuccessRate: 정상 종료(STOPPED) / (STOPPED + ERROR) ──
    // best-effort: 종료 결과가 확정된 세션만 분모로 본다(진행중 STARTING/IDLE/RUNNING 제외).
    const [stopped, errored] = await Promise.all([
      prisma.agentSession.count({ where: { status: 'STOPPED' } }),
      prisma.agentSession.count({ where: { status: 'ERROR' } }),
    ]);
    const sessionSuccessRate = safeDiv(stopped, stopped + errored);

    return reply.code(200).send({
      avgAgentTurnsPerPost,
      uniqueParticipantsPerThread,
      sessionSuccessRate,
    });
  });
}
