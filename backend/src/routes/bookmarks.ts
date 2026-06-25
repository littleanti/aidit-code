// backend/src/routes/bookmarks.ts
// M7 BE-BOOKMARK (TRD §4·§4.2):
//   POST   /posts/:id/bookmark        북마크 추가(requireAuth, 멱등 upsert) → 201 { bookmarked: true }
//   DELETE /posts/:id/bookmark        북마크 해제(requireAuth, 멱등 delete) → 200 { bookmarked: false }
//   GET    /users/:id/bookmarks?cursor=  프로필 북마크 목록(optionalAuth)
//        - keyset 커서/정렬은 BOOKMARK 행 기준(createdAt DESC, id DESC) — 글 createdAt 이 아니다(TRD §4.2).
//        - 응답 envelope { items: Post[], nextCursor }, page ~20. items 는 피드 카드 + sandbox.status 요약.
//        - 잘못된 커서 → 400.
//
// 보안(CLAUDE.md/TRD §8): 응답에 LLM 키 없음(Post/Sandbox 행에 키 필드 자체가 없음).

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { encodeCursor, decodeCursor, BadCursorError } from '../domain/cursor.js';

const PAGE_SIZE = 20;

/** 피드 카드 직렬화(posts.ts GET /posts 와 동일 형태 — sandbox.status 요약 포함). */
function serializePostCard(p: {
  id: string;
  authorId: string;
  title: string;
  body: string;
  score: number;
  commentCount: number;
  hotScore: number;
  createdAt: Date;
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
    sandbox: { status: p.sandbox?.status ?? null },
  };
}

export async function bookmarkRoutes(app: FastifyInstance): Promise<void> {
  // ── 북마크 추가(멱등 upsert) ──────────────────────────
  app.post('/posts/:id/bookmark', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!;
    const { id } = req.params as { id: string };

    const post = await prisma.post.findUnique({ where: { id }, select: { id: true } });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }

    // 멱등: 이미 있으면 그대로(unique 위반 무해 처리).
    await prisma.bookmark.upsert({
      where: { userId_postId: { userId: authUser.userId, postId: id } },
      create: { userId: authUser.userId, postId: id },
      update: {},
    });

    return reply.code(201).send({ bookmarked: true });
  });

  // ── 북마크 해제(멱등 delete) ──────────────────────────
  app.delete('/posts/:id/bookmark', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!;
    const { id } = req.params as { id: string };

    // 멱등: 없어도 200(deleteMany 는 없으면 0건 — 에러 아님).
    await prisma.bookmark.deleteMany({ where: { userId: authUser.userId, postId: id } });

    return reply.code(200).send({ bookmarked: false });
  });

  // ── 프로필 북마크 목록(BOOKMARK 행 기준 keyset) ───────
  app.get('/users/:id/bookmarks', { preHandler: app.optionalAuth }, async (req, reply) => {
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

    // keyset 은 BOOKMARK 행의 (createdAt, id) DESC 기준(TRD §4.2 — 글 createdAt 아님).
    const where = anchor
      ? {
          userId,
          OR: [
            { createdAt: { lt: anchor.createdAt } },
            { createdAt: anchor.createdAt, id: { lt: anchor.id } },
          ],
        }
      : { userId };

    const rows = await prisma.bookmark.findMany({
      where,
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
      take: PAGE_SIZE + 1,
      include: {
        post: { include: { sandbox: { select: { status: true } } } },
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const items = page.map((b) => serializePostCard(b.post));

    // nextCursor 는 BOOKMARK 행의 createdAt/id 로 인코딩(다음 페이지 앵커).
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

    return reply.code(200).send({ items, nextCursor });
  });
}
