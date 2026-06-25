// backend/src/plugins/auth.ts
// 인증 플러그인. app.requireAuth / app.optionalAuth preHandler 를 데코레이트한다.
//
//   - Authorization: Bearer <jwt> 를 파싱해 @fastify/jwt 로 검증.
//   - 성공 시 request.authUser = { userId, username } 세팅.
//   - requireAuth : 토큰 없음/무효 → 401.
//   - optionalAuth: 토큰 없음 → authUser=null(통과), 무효 → 401(잘못된 토큰은 거부).
//
// LLM 키는 토큰 페이로드에 절대 포함하지 않는다(서버 .env 전용).

import fp from 'fastify-plugin';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';

export interface AuthUser {
  userId: string;
  username: string;
}

/** JWT 페이로드 형태(서명 시 { userId, username } 만 넣는다). */
interface JwtPayload {
  userId: string;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    optionalAuth: preHandlerHookHandler;
  }
}

/** Authorization 헤더에서 Bearer 토큰을 추출(없으면 null). */
function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  // 모든 요청에 authUser 기본값(null)을 보장(타입/런타임 안전).
  app.decorateRequest('authUser', null);

  // 필수 인증: 토큰이 없거나 검증 실패하면 401.
  const requireAuth: preHandlerHookHandler = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const token = extractBearer(req);
    if (!token) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    try {
      const payload = app.jwt.verify<JwtPayload>(token);
      req.authUser = { userId: payload.userId, username: payload.username };
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  // 선택 인증: 토큰 없으면 authUser=null 로 통과, 토큰이 있는데 무효면 401.
  const optionalAuth: preHandlerHookHandler = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const token = extractBearer(req);
    if (!token) {
      req.authUser = null;
      return;
    }
    try {
      const payload = app.jwt.verify<JwtPayload>(token);
      req.authUser = { userId: payload.userId, username: payload.username };
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.decorate('requireAuth', requireAuth);
  app.decorate('optionalAuth', optionalAuth);
}

export default fp(authPlugin, { name: 'auth', dependencies: ['@fastify/jwt'] });
