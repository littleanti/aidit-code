// backend/src/routes/auth.ts
// 인증 라우트(TRD §4):
//   POST /auth/register  회원가입(username+password, bcrypt, 중복 409)
//   POST /auth/session   로그인(비밀번호 검증, 실패 401)
//   POST /auth/guest     게스트 진입(닉네임 ≤16자·'#' 금지, 서버가 #hex4 부여, passwordHash=null)
//   POST /auth/refresh   슬라이딩 토큰 갱신(requireAuth)
// 모두 { id, token, username } 반환. JWT 페이로드는 { userId, username } 만(LLM 키 절대 미포함).

import type { FastifyInstance, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';

const BCRYPT_ROUNDS = 10;
const MAX_NICKNAME_LEN = 16;
const MAX_GUEST_RETRIES = 8;

/** { userId, username } 로 JWT 서명(만료는 app 등록 시 jwtExpires). */
function signToken(app: FastifyInstance, userId: string, username: string): string {
  return app.jwt.sign({ userId, username });
}

function authResponse(reply: FastifyReply, status: number, user: { id: string; username: string }, token: string) {
  return reply.code(status).send({ id: user.id, token, username: user.username });
}

/** 4자리 hex 접미사(예: a3f9). */
function hex4(): string {
  return randomBytes(2).toString('hex');
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── 회원가입 ──────────────────────────────────────────
  app.post('/auth/register', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return reply.code(400).send({ error: 'username and password are required' });
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return reply.code(409).send({ error: 'username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({ data: { username, passwordHash } });
    const token = signToken(app, user.id, user.username);
    return authResponse(reply, 201, user, token);
  });

  // ── 로그인 ────────────────────────────────────────────
  app.post('/auth/session', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return reply.code(400).send({ error: 'username and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.passwordHash) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const token = signToken(app, user.id, user.username);
    return authResponse(reply, 200, user, token);
  });

  // ── 게스트 진입 ───────────────────────────────────────
  app.post('/auth/guest', async (req, reply) => {
    const body = (req.body ?? {}) as { nickname?: unknown };
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';

    if (!nickname) {
      return reply.code(400).send({ error: 'nickname is required' });
    }
    if (nickname.length > MAX_NICKNAME_LEN) {
      return reply.code(400).send({ error: `nickname must be <= ${MAX_NICKNAME_LEN} chars` });
    }
    if (nickname.includes('#')) {
      return reply.code(400).send({ error: "nickname must not contain '#'" });
    }

    // 서버가 #hex4 접미사 부여. unique 충돌 시 재생성.
    for (let attempt = 0; attempt < MAX_GUEST_RETRIES; attempt++) {
      const candidate = `${nickname}#${hex4()}`;
      const clash = await prisma.user.findUnique({ where: { username: candidate } });
      if (clash) continue;
      try {
        const user = await prisma.user.create({ data: { username: candidate, passwordHash: null } });
        const token = signToken(app, user.id, user.username);
        return authResponse(reply, 201, user, token);
      } catch {
        // 경합으로 인한 unique 위반 → 재시도.
        continue;
      }
    }
    return reply.code(409).send({ error: 'could not allocate a unique guest name, retry' });
  });

  // ── 슬라이딩 토큰 갱신 ────────────────────────────────
  app.post('/auth/refresh', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!; // requireAuth 통과 시 항상 존재.
    const token = signToken(app, authUser.userId, authUser.username);
    return reply.code(200).send({ id: authUser.userId, token, username: authUser.username });
  });
}
