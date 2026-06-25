// backend/test/messages.test.ts
// BE-MSG 검증:
//   - clientId 멱등: 동일 clientId 재요청은 같은 메시지를 반환하고 중복 행을 만들지 않는다.
//   - seq 단조 증가: 같은 post 의 연속 메시지는 seq 가 1,2,3... 으로 증가한다.
//
// aiMode=false 로만 테스트(에이전트 프로세스 spawn 회피 — 그 경로는 agentTurn.test.ts 가 검증).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

let app: FastifyInstance;
const created = { userId: '', postId: '' };
let token = '';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const user = await prisma.user.create({
    data: { username: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  created.userId = user.id;
  token = app.jwt.sign({ userId: user.id, username: user.username });

  const post = await prisma.post.create({
    data: { authorId: user.id, title: 'msg test', body: '' },
  });
  created.postId = post.id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { postId: created.postId } });
  await prisma.post.deleteMany({ where: { id: created.postId } });
  await prisma.user.deleteMany({ where: { id: created.userId } });
  await app.close();
  await prisma.$disconnect();
});

function auth() {
  return { authorization: `Bearer ${token}` };
}

describe('POST /posts/:id/messages', () => {
  it('is idempotent on clientId (same clientId -> same message, no duplicate)', async () => {
    const clientId = `cid-${Date.now()}`;

    const r1 = await app.inject({
      method: 'POST',
      url: `/posts/${created.postId}/messages`,
      headers: auth(),
      payload: { body: 'hello idempotent', aiMode: false, clientId },
    });
    expect(r1.statusCode).toBe(201);
    const m1 = r1.json().message;

    const r2 = await app.inject({
      method: 'POST',
      url: `/posts/${created.postId}/messages`,
      headers: auth(),
      payload: { body: 'hello idempotent (retry)', aiMode: false, clientId },
    });
    // 멱등 재요청 → 200 + 동일 메시지(첫 본문 보존).
    expect(r2.statusCode).toBe(200);
    const m2 = r2.json().message;

    expect(m2.id).toBe(m1.id);
    expect(m2.body).toBe('hello idempotent');

    const count = await prisma.message.count({ where: { postId: created.postId, clientId } });
    expect(count).toBe(1);
  });

  it('assigns monotonically increasing seq per post', async () => {
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST',
        url: `/posts/${created.postId}/messages`,
        headers: auth(),
        payload: { body: `seq msg ${i}`, aiMode: false, clientId: `seq-${Date.now()}-${i}` },
      });
      expect(r.statusCode).toBe(201);
      seqs.push(r.json().message.seq);
    }
    // 엄격 증가.
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    // commentCount 가 생성 수만큼 증가.
    const post = await prisma.post.findUnique({ where: { id: created.postId } });
    expect(post!.commentCount).toBeGreaterThanOrEqual(seqs.length);
  });

  it('GET /posts/:id/messages?afterSeq returns ascending keyset page', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/posts/${created.postId}/messages?afterSeq=0`,
      headers: auth(),
    });
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Array<{ seq: number; toolCall: unknown }>;
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) {
      expect(items[i].seq).toBeGreaterThan(items[i - 1].seq);
    }
    // M5 전까지 toolCall 요약은 null.
    expect(items[0].toolCall).toBeNull();
  });
});
