// backend/src/routes/users.ts
// M7 BE-USERPOSTS (TRD §4·§4.2):
//   GET /users/:id/posts?cursor=  사용자 작성 글 목록(optionalAuth)
//        - keyset: post.createdAt DESC, id DESC. envelope { items, nextCursor }, page ~20.
//        - items 는 피드 카드 + sandbox.status 요약. 잘못된 커서 → 400.
//
// 보안(CLAUDE.md/TRD §8): 응답에 LLM 키 없음(Post/Sandbox 행에 키 필드 없음).

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { encodeCursor, decodeCursor, BadCursorError } from '../domain/cursor.js';

const PAGE_SIZE = 20;

/** 피드 카드 직렬화(GET /posts 와 동일 형태 — sandbox.status 요약 포함). */
function serializePostCard(p: {
  id: string;
  authorId: string;
  title: string;
  body: string;
  score: number;
  commentCount: number;
  hotScore: number;
  createdAt: Date;
  author: { id: string; username: string };
  sandbox: { status: string } | null;
}) {
  return {
    id: p.id,
    authorId: p.authorId,
    title: p.title,
    body: p.body,
    score: p.score,
    commentCount: p.commentCount,
    hotScore: p.hotScore,
    createdAt: p.createdAt,
    // 작성자 표시(부모 Aidit 패리티) — 프로필 작성글 카드에도 username 동봉.
    author: { id: p.author.id, username: p.author.username },
    sandbox: { status: p.sandbox?.status ?? null },
  };
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // ── 사용자 작성 글 목록(post.createdAt DESC, id DESC keyset) ──
  app.get('/users/:id/posts', { preHandler: app.optionalAuth }, async (req, reply) => {
    const { id: userId } = req.params as { id: string };
    const query = (req.query ?? {}) as { cursor?: unknown };
    const cursorStr =
      typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : null;

    let anchor: { createdAt: Date; id: string } | null = null;
    if (cursorStr) {
      try {
        anchor = decodeCursor(cursorStr);
      } catch (err) {
        if (err instanceof BadCursorError) {
          return reply.code(400).send({ error: 'malformed cursor' });
        }
        throw err;
      }
    }

    const where = anchor
      ? {
          authorId: userId,
          OR: [
            { createdAt: { lt: anchor.createdAt } },
            { createdAt: anchor.createdAt, id: { lt: anchor.id } },
          ],
        }
      : { authorId: userId };

    const rows = await prisma.post.findMany({
      where,
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
      take: PAGE_SIZE + 1,
      include: {
        sandbox: { select: { status: true } },
        author: { select: { id: true, username: true } },
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const items = page.map(serializePostCard);

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

    return reply.code(200).send({ items, nextCursor });
  });
}
