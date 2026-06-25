// backend/test/messageImage.test.ts
// Feature A 검증(메시지에 imageUrl 저장/검증):
//   - 자기-소유 /uploads/<uuid>.<ext> imageUrl 은 HUMAN 메시지에 저장된다(aiMode=false).
//   - 이미지-only(빈 body + imageUrl) 메시지 허용(201).
//   - 화이트리스트 불통과 imageUrl(절대 URL/traversal/타 prefix)은 400.
//   - body·imageUrl 둘 다 없으면 400.
//
// aiMode=false 로만 검증(에이전트 spawn 회피). 비전 스레드-스루는 reasoningEffort.test.ts 가 spy 로 검증.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

let app: FastifyInstance;
let token = '';
let userId = '';
let postId = '';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const user = await prisma.user.create({
    data: { username: `mimg-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  userId = user.id;
  token = app.jwt.sign({ userId: user.id, username: user.username });
  const post = await prisma.post.create({ data: { authorId: user.id, title: 'img test', body: '' } });
  postId = post.id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { postId } });
  await prisma.post.deleteMany({ where: { id: postId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await app.close();
  await prisma.$disconnect();
});

const auth = () => ({ authorization: `Bearer ${token}` });
const uploadUrl = () => `/uploads/${randomUUID()}.png`;

describe('POST /posts/:id/messages — imageUrl (Feature A)', () => {
  it('stores a valid own /uploads/<uuid>.png on the HUMAN message', async () => {
    const imageUrl = uploadUrl();
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/messages`,
      headers: auth(),
      payload: { body: 'look at this', aiMode: false, clientId: `img-${Date.now()}`, imageUrl },
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json().message;
    expect(msg.imageUrl).toBe(imageUrl);

    const row = await prisma.message.findUnique({ where: { id: msg.id } });
    expect(row!.imageUrl).toBe(imageUrl);
  });

  it('allows an image-only message (empty body + imageUrl)', async () => {
    const imageUrl = uploadUrl();
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/messages`,
      headers: auth(),
      payload: { body: '', aiMode: false, clientId: `imgonly-${Date.now()}`, imageUrl },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.imageUrl).toBe(imageUrl);
  });

  it('rejects a non-whitelisted imageUrl (absolute URL / traversal / other prefix) with 400', async () => {
    const bad = [
      'https://evil.example.com/x.png',
      'http://localhost/uploads/x.png',
      '/uploads/../../etc/passwd',
      '/uploads/not-a-uuid.png',
      '/static/abc.png',
      '/uploads/12345678-1234-1234-1234-123456789012.exe',
      'C:\\Windows\\system32\\x.png',
      'file:///etc/passwd',
    ];
    for (const imageUrl of bad) {
      const res = await app.inject({
        method: 'POST',
        url: `/posts/${postId}/messages`,
        headers: auth(),
        payload: { body: 'x', aiMode: false, clientId: `bad-${randomUUID()}`, imageUrl },
      });
      expect(res.statusCode, `imageUrl=${imageUrl}`).toBe(400);
      expect(res.json().error).toMatch(/imageUrl/i);
    }
  });

  it('rejects when both body and imageUrl are missing (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/messages`,
      headers: auth(),
      payload: { body: '   ', aiMode: false, clientId: `empty-${Date.now()}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
