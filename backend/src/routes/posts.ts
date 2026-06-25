// backend/src/routes/posts.ts
// 게시글 라우트(TRD §4·§9):
//   POST   /posts            글 작성(requireAuth) → Post 생성 + Sandbox 1:1 → { post, sandbox }
//   GET    /posts/:id        단건 조회(optionalAuth) → sandbox{status,runtime}, voted, bookmarked, activeSession:null
//   GET    /posts            피드(optionalAuth) sort=hot|new, keyset 커서 → { items, nextCursor }
//   PATCH  /posts/:id        수정(requireAuth, 작성자만 / 비작성자 403)
//   POST   /posts/:id/upvote 추천(멱등) / DELETE /posts/:id/upvote 취소(멱등)
//                            → score=Vote count 재계산 + hotScore 갱신 → { id, score, hotScore, voted }

import type { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '../db.js';
import { hotScore } from '../domain/hotScore.js';
import { encodeCursor, decodeCursor, BadCursorError } from '../domain/cursor.js';
import { createSandboxForPost } from '../sandbox/service.js';

const PAGE_SIZE = 20;

/** Post.score(Vote count)·hotScore 를 재계산해 영속화하고 갱신값을 반환. */
async function recomputeScore(postId: string): Promise<{ score: number; hotScore: number }> {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) {
    throw Object.assign(new Error('post not found'), { statusCode: 404 });
  }
  const score = await prisma.vote.count({ where: { postId } });
  const hs = hotScore(score, post.commentCount, post.createdAt);
  await prisma.post.update({ where: { id: postId }, data: { score, hotScore: hs } });
  return { score, hotScore: hs };
}

export async function postRoutes(app: FastifyInstance): Promise<void> {
  // ── 글 작성 ───────────────────────────────────────────
  app.post('/posts', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!;
    const body = (req.body ?? {}) as { title?: unknown; body?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body : '';

    if (!title) {
      return reply.code(400).send({ error: 'title is required' });
    }

    const post = await prisma.post.create({
      data: { authorId: authUser.userId, title, body: text },
    });
    // M1: Sandbox 1:1 자동 생성(행 + 디렉토리, status=CREATING).
    const sandbox = await createSandboxForPost(post.id);

    return reply.code(201).send({ post, sandbox });
  });

  // ── 피드(hot|new, keyset 커서) ───────────────────────
  app.get('/posts', { preHandler: app.optionalAuth }, async (req, reply) => {
    const query = (req.query ?? {}) as { sort?: unknown; cursor?: unknown };
    const sort = query.sort === 'hot' ? 'hot' : 'new';
    const cursorStr = typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : null;

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

    // keyset: (createdAt, id) DESC. hot 은 hotScore 우선 정렬, createdAt/id 로 tiebreak·커서.
    const orderBy =
      sort === 'hot'
        ? [{ hotScore: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'desc' as const }]
        : [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

    // (createdAt, id) < (anchor.createdAt, anchor.id) — keyset 다음 페이지 조건.
    const where = anchor
      ? {
          OR: [
            { createdAt: { lt: anchor.createdAt } },
            { createdAt: anchor.createdAt, id: { lt: anchor.id } },
          ],
        }
      : {};

    const rows = await prisma.post.findMany({
      where,
      orderBy,
      take: PAGE_SIZE + 1,
      include: { sandbox: { select: { status: true } } },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const items = page.map((p) => ({
      id: p.id,
      authorId: p.authorId,
      title: p.title,
      body: p.body,
      score: p.score,
      commentCount: p.commentCount,
      hotScore: p.hotScore,
      createdAt: p.createdAt,
      sandbox: { status: p.sandbox?.status ?? null },
    }));

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

    return reply.code(200).send({ items, nextCursor });
  });

  // ── 단건 조회 ─────────────────────────────────────────
  app.get('/posts/:id', { preHandler: app.optionalAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const post = await prisma.post.findUnique({
      where: { id },
      include: { sandbox: { select: { status: true, runtime: true } } },
    });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }

    let voted = false;
    let bookmarked = false;
    if (req.authUser) {
      const userId = req.authUser.userId;
      const [v, b] = await Promise.all([
        prisma.vote.findUnique({ where: { userId_postId: { userId, postId: id } } }),
        prisma.bookmark.findUnique({ where: { userId_postId: { userId, postId: id } } }),
      ]);
      voted = v != null;
      bookmarked = b != null;
    }

    const { sandbox, ...rest } = post;
    return reply.code(200).send({
      post: rest,
      sandbox: sandbox ? { status: sandbox.status, runtime: sandbox.runtime } : null,
      voted,
      bookmarked,
      activeSession: null,
    });
  });

  // ── 수정(작성자만) ───────────────────────────────────
  app.patch('/posts/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: unknown; body?: unknown };

    const post = await prisma.post.findUnique({ where: { id } });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }
    if (post.authorId !== authUser.userId) {
      return reply.code(403).send({ error: 'only the author can edit this post' });
    }

    const data: { title?: string; body?: string } = {};
    if (typeof body.title === 'string') data.title = body.title.trim();
    if (typeof body.body === 'string') data.body = body.body;

    const updated = await prisma.post.update({ where: { id }, data });
    return reply.code(200).send({ post: updated });
  });

  // ── 추천(멱등 upsert) ────────────────────────────────
  app.post('/posts/:id/upvote', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!;
    const { id } = req.params as { id: string };

    const post = await prisma.post.findUnique({ where: { id } });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }

    // 멱등: 이미 있으면 무시(unique 위반 무해 처리).
    await prisma.vote.upsert({
      where: { userId_postId: { userId: authUser.userId, postId: id } },
      create: { userId: authUser.userId, postId: id },
      update: {},
    });

    const { score, hotScore: hs } = await recomputeScore(id);
    return reply.code(200).send({ id, score, hotScore: hs, voted: true });
  });

  // ── 추천 취소(멱등 delete) ───────────────────────────
  app.delete('/posts/:id/upvote', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!;
    const { id } = req.params as { id: string };

    const post = await prisma.post.findUnique({ where: { id } });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }

    await prisma.vote.deleteMany({ where: { userId: authUser.userId, postId: id } });

    const { score, hotScore: hs } = await recomputeScore(id);
    return reply.code(200).send({ id, score, hotScore: hs, voted: false });
  });
}
