// backend/src/app.ts
// Fastify 앱 팩토리. buildApp() 은 설정된 인스턴스를 반환만 하고 listen 하지 않는다
// (테스트에서 import 시 side-effect 없이 inject 가능). 직접 실행 시에만 listen.

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { registerRoutes } from './routes/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  // CORS — PoC 는 모든 출처 허용(origin true).
  await app.register(cors, { origin: true });

  // JWT 서명/검증 — secret 은 config(.env JWT_SECRET).
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpires },
  });

  // 멀티파트 업로드(Feature A) — 파일 1개, 5MB 상한. 초과 시 라우트가 413 으로 마감.
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });

  // 업로드 디렉토리 부팅 시 생성(없으면). 정적 서빙 루트.
  mkdirSync(config.uploadDir, { recursive: true });

  // 업로드 이미지를 /uploads URL prefix 로 정적 서빙(에이전트 비전 입력의 출처이자 클라 표시용).
  await app.register(fastifyStatic, {
    root: path.resolve(config.uploadDir),
    prefix: '/uploads/',
    // 디렉토리 인덱싱/리스팅 비활성(파일 직접 접근만).
    index: false,
    list: false,
  });

  // 도메인 라우트 등록 시임(현재 /health 만).
  await app.register(registerRoutes);

  return app;
}

// 직접 실행될 때만 listen (import 시에는 실행 안 함).
const isMain =
  process.argv[1] != null &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  const app = await buildApp();
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
