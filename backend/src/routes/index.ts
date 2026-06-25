// backend/src/routes/index.ts
// 라우트 등록 시임(seam). 인증 플러그인 + 도메인 라우트(auth/posts)를 연결한다.
// 이후 단계(messages/session/files/stream 등)는 여기에서 register 한다.

import type { FastifyInstance } from 'fastify';
import authPlugin from '../plugins/auth.js';
import { authRoutes } from './auth.js';
import { postRoutes } from './posts.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // GET /health → { ok: true }
  app.get('/health', async () => {
    return { ok: true };
  });

  // 인증 데코레이터(requireAuth/optionalAuth) — 라우트보다 먼저 등록.
  await app.register(authPlugin);

  // 도메인 라우트.
  await app.register(authRoutes);
  await app.register(postRoutes);
}
