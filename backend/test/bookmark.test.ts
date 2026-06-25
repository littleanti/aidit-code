// backend/test/bookmark.test.ts
// M7 BE-BOOKMARK 검증:
//   - POST /posts/:id/bookmark 멱등 추가(201 {bookmarked:true}, 중복 행 없음).
//   - DELETE /posts/:id/bookmark 멱등 해제(200 {bookmarked:false}, 없어도 200).
//   - GET /users/:id/bookmarks 는 BOOKMARK 행 createdAt DESC,id DESC 로 정렬/앵커한다
//     (글 createdAt 순서와 무관 — 나중에 북마크한 글이 먼저 온다). 잘못된 커서 → 400.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

let app: FastifyInstance;
let token = '';
const created = { userId: '', postIds: [] as string[] };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const user = await prisma.user.create({
    data: { username: `bm-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  created.userId = user.id;
  token = app.jwt.sign({ userId: user.id, username: user.username });

  // 3개의 글 생성(샌드박스 없이 — 북마크/목록만 검증).
  for (let i = 0; i < 3; i++) {
    const p = await prisma.post.create({
      data: { authorId: user.id, title: `bm post ${i}`, body: '' },
    });
    created.postIds.push(p.id);
  }
});

afterAll(async () => {
  await prisma.bookmark.deleteMany({ where: { userId: created.userId } });
  await prisma.post.deleteMany({ where: { id: { in: created.postIds } } });
  await prisma.user.deleteMany({ where: { id: created.userId } });
  await app.close();
  await prisma.$disconnect();
});

function auth() {
  return { authorization: `Bearer ${token}` };
}

describe('M7 bookmarks', () => {
  it('POST /posts/:id/bookmark is idempotent (201 + no duplicate rows)', async () => {
    const postId = created.postIds[0];

    const r1 = await app.inject({ method: 'POST', url: `/posts/${postId}/bookmark`, headers: auth() });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().bookmarked).toBe(true);

    const r2 = await app.inject({ method: 'POST', url: `/posts/${postId}/bookmark`, headers: auth() });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().bookmarked).toBe(true);

    const count = await prisma.bookmark.count({ where: { userId: created.userId, postId } });
    expect(count).toBe(1);
  });

  it('DELETE /posts/:id/bookmark is idempotent (200 even when absent)', async () => {
    const postId = created.postIds[0];

    const r1 = await app.inject({ method: 'DELETE', url: `/posts/${postId}/bookmark`, headers: auth() });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().bookmarked).toBe(false);

    // 이미 없는데 다시 해제해도 200(멱등).
    const r2 = await app.inject({ method: 'DELETE', url: `/posts/${postId}/bookmark`, headers: auth() });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().bookmarked).toBe(false);

    const count = await prisma.bookmark.count({ where: { userId: created.userId, postId } });
    expect(count).toBe(0);
  });

  it('GET /users/:id/bookmarks is ordered/anchored on the BOOKMARK row, not post createdAt', async () => {
    // 글 생성 순서: postIds[0],[1],[2]. 북마크는 역순으로 — [2] 먼저, 그다음 [0], 마지막 [1].
    // 따라서 bookmark.createdAt 기준 최신순은 [1], [0], [2] 가 되어야 한다(글 createdAt 순서와 다름).
    const order = [created.postIds[2], created.postIds[0], created.postIds[1]];
    for (const pid of order) {
      const r = await app.inject({ method: 'POST', url: `/posts/${pid}/bookmark`, headers: auth() });
      expect(r.statusCode).toBe(201);
      // 동일 ms 타이 회피 — createdAt 가 명확히 단조 증가하도록 약간 띄운다(정렬 결정성).
      await new Promise((res) => setTimeout(res, 5));
    }

    const res = await app.inject({ method: 'GET', url: `/users/${created.userId}/bookmarks`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; sandbox: { status: string | null } }>;
    // 최신 북마크가 먼저: 마지막으로 북마크한 postIds[1] 이 맨 앞.
    expect(items.map((i) => i.id)).toEqual([
      created.postIds[1],
      created.postIds[0],
      created.postIds[2],
    ]);
    // 카드에 sandbox.status 요약 필드가 있다(샌드박스 없으면 null).
    expect(items[0]).toHaveProperty('sandbox');
    expect(items[0].sandbox).toHaveProperty('status');
  });

  it('GET /users/:id/bookmarks rejects a malformed cursor with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/users/${created.userId}/bookmarks?cursor=not-a-valid-cursor!!!`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});
