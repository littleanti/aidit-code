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
import { createSandboxForPost, sandboxLimiter, deleteSandboxDir, resolveSandboxDir } from '../sandbox/service.js';
import { provisionSandbox } from '../sandbox/provision.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { runAgentTurn } from '../agent/turn.js';
import { ensureActiveSession } from './messages.js';

const ACTIVE_SESSION_STATUSES = ['STARTING', 'IDLE', 'RUNNING'] as const;

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
    const body = (req.body ?? {}) as {
      title?: unknown;
      body?: unknown;
      autoReply?: unknown;
      reasoningEffort?: unknown;
    };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body : '';

    if (!title) {
      return reply.code(400).send({ error: 'title is required' });
    }

    // "게시 후 AI 1차 답변 받기"(기본 ON). false 일 때만 자동 응답 턴을 건너뛴다.
    const autoReply = body.autoReply !== false;
    // reasoningEffort(Feature B): 주어지면 low/medium/high 만 허용(그 외 400).
    //   autoReply ON 인데 미지정이면 medium(메시지 라우트와 동일 기본).
    let reasoningEffort: string | undefined;
    if (body.reasoningEffort !== undefined && body.reasoningEffort !== null) {
      if (typeof body.reasoningEffort !== 'string' || !REASONING_EFFORTS.has(body.reasoningEffort)) {
        return reply.code(400).send({ error: 'invalid reasoningEffort' });
      }
      reasoningEffort = body.reasoningEffort;
    }
    if (autoReply && reasoningEffort === undefined) {
      reasoningEffort = 'medium';
    }

    // 동시 프로비저닝 상한(TRD §8). PoC 정책: 용량 초과 시 글을 만들지 않고 429(429-on-overflow).
    // 슬롯은 여기서 선점하고, 비동기 provisionSandbox 가 finally 에서 반납한다(소유권 이전).
    if (!sandboxLimiter.tryAcquire()) {
      return reply.code(429).send({ error: 'sandbox capacity exceeded, retry later' });
    }

    let post;
    let sandbox;
    try {
      post = await prisma.post.create({
        data: { authorId: authUser.userId, title, body: text },
      });
      // Sandbox 1:1 자동 생성(행 + 디렉토리, status=CREATING).
      sandbox = await createSandboxForPost(post.id);
    } catch (err) {
      // 행 생성 실패 시 선점한 슬롯을 반납해야 누수가 없다.
      sandboxLimiter.release();
      throw err;
    }

    // 응답을 막지 않고(fire-and-forget) CREATING → READY 프로비저닝을 비동기로 시작한다.
    // provisionSandbox 가 슬롯 release 를 책임진다(releaseSlot 기본 true, acquireSlot=false).
    void provisionSandbox(sandbox).then(() => {
      if (autoReply) void maybeAutoReply(post.id, reasoningEffort);
    });

    // 응답은 즉시 status=CREATING 으로 반환되고, 이후 sandbox.status 이벤트로 READY 전이가 따른다.
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
      include: {
        sandbox: { select: { status: true } },
        author: { select: { id: true, username: true } },
      },
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
      // 작성자 표시(부모 Aidit 패리티) — 피드 카드에도 username 동봉.
      author: { id: p.author.id, username: p.author.username },
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
      include: {
        sandbox: { select: { status: true, runtime: true } },
        // 작성자 표시(부모 Aidit 패리티): username 조인. 키/비밀 필드 없음.
        author: { select: { id: true, username: true } },
      },
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

  // ── 글 삭제(작성자만) + 샌드박스 디렉토리 정리 ────────────
  // sandboxLifecycle §6.1 step7: 활성 프로세스 종료 → FK 안전 순서 행 삭제 → 디렉토리 rm -rf.
  app.delete('/posts/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const authUser = req.authUser!;
    const { id } = req.params as { id: string };

    const post = await prisma.post.findUnique({
      where: { id },
      include: { sandbox: true },
    });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }
    if (post.authorId !== authUser.userId) {
      return reply.code(403).send({ error: 'only the author can delete this post' });
    }

    const sandbox = post.sandbox;

    // 1) 활성 에이전트 세션이 있으면 프로세스 종료(디렉토리는 다음 단계에서 삭제).
    if (sandbox) {
      const active = await prisma.agentSession.findMany({
        where: { sandboxId: sandbox.id, status: { in: [...ACTIVE_SESSION_STATUSES] } },
        select: { id: true, sandboxId: true },
      });
      const runtime = getAgentRuntime();
      for (const s of active) {
        try {
          await runtime.suspend(s);
        } catch {
          // 프로세스가 이미 죽었거나 미등록이어도 삭제는 계속 진행.
        }
      }
    }

    // 2) FK 안전 순서로 행 삭제(스키마에 onDelete cascade 미설정).
    await prisma.$transaction(async (tx) => {
      // 자기참조(replyToId) 먼저 끊고 메시지 삭제.
      await tx.message.updateMany({ where: { postId: id }, data: { replyToId: null } });
      await tx.message.deleteMany({ where: { postId: id } });
      if (sandbox) {
        await tx.toolCall.deleteMany({ where: { session: { sandboxId: sandbox.id } } });
        await tx.agentSession.deleteMany({ where: { sandboxId: sandbox.id } });
      }
      await tx.vote.deleteMany({ where: { postId: id } });
      await tx.bookmark.deleteMany({ where: { postId: id } });
      if (sandbox) {
        await tx.sandbox.delete({ where: { id: sandbox.id } });
      }
      await tx.post.delete({ where: { id } });
    });

    // 3) 샌드박스 격리 디렉토리 삭제(루트 내부 확인 후에만).
    if (sandbox) {
      // 저장 절대경로가 박제돼 루트 밖이면 deleteSandboxDir 가드에 걸리므로, 실제 위치로 재계산.
      const sandboxDir = resolveSandboxDir({ postId: id, path: sandbox.path });
      try {
        await deleteSandboxDir(sandboxDir);
      } catch (err) {
        // 디렉토리 삭제 실패는 치명적이지 않음(행은 이미 삭제됨). 로깅만.
        app.log.warn({ err, sandboxPath: sandboxDir }, 'sandbox dir cleanup failed');
      }
    }

    return reply.code(200).send({ deleted: true });
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

/** reasoningEffort(Feature B) 화이트리스트 — 메시지 라우트와 동일. */
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

/** Hangul 감지로 응답 언어 힌트. */
function detectLang(text: string): 'ko' | 'en' {
  return /[가-힣]/.test(text) ? 'ko' : 'en';
}

/**
 * 글 생성 후(샌드박스 READY) 게시글 내용으로 에이전트 자동 응답을 1회 띄운다.
 * fire-and-forget — 예외는 삼켜 글 생성 흐름에 영향 주지 않는다.
 */
async function maybeAutoReply(postId: string, reasoningEffort?: string): Promise<void> {
  // 결정적 테스트 보호: 테스트 환경(vitest)에서는 글 생성의 부수효과(자동 응답 턴)를 띄우지 않는다.
  //   기존 스위트(e2e/redaction)는 글 생성 후 특정 agent 프레임 시퀀스를 단정하므로, 비요청 턴이
  //   끼어들면 오염된다. 운영/개발 구동에는 영향 없음. (필요 시 POST_AUTO_REPLY=1 로 강제 가능.)
  if ((process.env.VITEST || process.env.NODE_ENV === 'test') && process.env.POST_AUTO_REPLY !== '1') {
    return;
  }
  try {
    const post = await prisma.post.findUnique({ where: { id: postId }, include: { sandbox: true } });
    if (!post || !post.sandbox) return;
    if (post.sandbox.status !== 'READY' && post.sandbox.status !== 'SUSPENDED') return;
    // 이미 메시지가 있으면(중복 트리거) 스킵.
    const existing = await prisma.message.count({ where: { postId } });
    if (existing > 0) return;
    const promptText = [post.title, post.body].filter((s) => s && s.trim()).join('\n\n').trim();
    if (!promptText) return;
    const session = await ensureActiveSession(postId, post.sandbox.id, post.sandbox.path, post.sandbox.status);
    if (!session) return;
    await runAgentTurn({
      post: { id: postId },
      session: { id: session.id, sandboxId: post.sandbox.id },
      prompt: promptText,
      lang: detectLang(promptText),
      reasoningEffort, // 작성 시 선택한 작업 강도(낮음/중간/높음). 없으면 worker 가 생략.
    });
  } catch {
    /* 자동 응답 실패는 무해 — 글은 이미 생성됨. */
  }
}
