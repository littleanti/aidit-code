// backend/src/routes/runtime.ts
// GET-RUNTIME (PLAN §5): GET /runtime (optionalAuth) → 공개 런타임 정보.
//   응답 = getPublicRuntimeInfo() = { model, baseURLHost }. apiKey 는 절대 포함하지 않는다.

import type { FastifyInstance } from 'fastify';
import { getPublicRuntimeInfo } from '../agent/config.js';

export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/runtime', { preHandler: app.optionalAuth }, async (_req, reply) => {
    // { model, baseURLHost } — 키/자격증명 없음(getPublicRuntimeInfo 가 구조적으로 보장).
    return reply.code(200).send(getPublicRuntimeInfo());
  });
}
