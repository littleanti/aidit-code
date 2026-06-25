// backend/src/routes/index.ts
// 라우트 등록 시임(seam). 인증 플러그인 + 도메인 라우트(auth/posts)를 연결한다.
// 이후 단계(messages/session/files/stream 등)는 여기에서 register 한다.

import type { FastifyInstance } from 'fastify';
import authPlugin from '../plugins/auth.js';
import rateLimitPlugin from '../plugins/rateLimit.js';
import { authRoutes } from './auth.js';
import { postRoutes } from './posts.js';
import { sessionRoutes } from './session.js';
import { runtimeRoutes } from './runtime.js';
import { messageRoutes } from './messages.js';
import { uploadRoutes } from './uploads.js';
import { filesRoutes } from './files.js';
import { bookmarkRoutes } from './bookmarks.js';
import { userRoutes } from './users.js';
import { metricsRoutes } from './metrics.js';
import { streamRoutes } from '../realtime/stream.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // GET /health → { ok: true }
  app.get('/health', async () => {
    return { ok: true };
  });

  // 인증 데코레이터(requireAuth/optionalAuth) — 라우트보다 먼저 등록.
  await app.register(authPlugin);

  // 쓰기 라우트 레이트리밋(M7 XC-RATE) — auth 다음(authUser 합성 후), 라우트보다 먼저.
  await app.register(rateLimitPlugin);

  // 도메인 라우트.
  await app.register(authRoutes);
  await app.register(postRoutes);
  await app.register(sessionRoutes);
  await app.register(runtimeRoutes);
  await app.register(messageRoutes);
  await app.register(uploadRoutes);
  await app.register(filesRoutes);
  await app.register(bookmarkRoutes);
  await app.register(userRoutes);
  await app.register(metricsRoutes);
  await app.register(streamRoutes);
}
