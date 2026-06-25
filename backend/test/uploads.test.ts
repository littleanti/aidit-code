// backend/test/uploads.test.ts
// BE-UPLOAD 검증(Feature A):
//   - 비이미지 MIME 거부(400).
//   - 5MB 초과 거부(413).
//   - 작은 png 수락 → 201 + /uploads/<uuid>.png (UUID 파일명, 클라 파일명 미사용).
//   - 응답에 키/시크릿 없음.
//
// 멀티파트 본문은 form-data 를 직접 구성해 app.inject 의 payload(Buffer)+content-type 로 주입한다.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { rm, readdir } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';

let app: FastifyInstance;
let token = '';
let userId = '';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const user = await prisma.user.create({
    data: { username: `upl-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  userId = user.id;
  token = app.jwt.sign({ userId: user.id, username: user.username });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  // 테스트가 만든 업로드 파일 정리(uuid.png 등 — 다른 파일은 건드리지 않도록 생성분만).
  for (const f of createdFiles) {
    await rm(f, { force: true }).catch(() => {});
  }
  await app.close();
  await prisma.$disconnect();
});

const createdFiles: string[] = [];

function auth() {
  return { authorization: `Bearer ${token}` };
}

const BOUNDARY = '----vitestUploadBoundary';

/** form-data 멀티파트 본문(파일 1개)을 Buffer 로 구성한다. */
function multipartBody(opts: {
  fieldName: string;
  filename: string;
  contentType: string;
  content: Buffer;
}): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="${opts.fieldName}"; filename="${opts.filename}"\r\n` +
      `Content-Type: ${opts.contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8');
  return Buffer.concat([head, opts.content, tail]);
}

function mpHeaders() {
  return { ...auth(), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
}

// 최소 유효 PNG(1x1) 시그니처 바이트.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('POST /uploads', () => {
  it('rejects a non-image type with 400', async () => {
    const payload = multipartBody({
      fieldName: 'file',
      filename: 'evil.txt',
      contentType: 'text/plain',
      content: Buffer.from('not an image', 'utf8'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: mpHeaders(),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unsupported|image/i);
  });

  it('rejects an oversize file with 413', async () => {
    // 5MB + 1KB 의 png-typed 본문(내용은 0 으로 채워도 multipart fileSize limit 가 잡는다).
    const big = Buffer.alloc(5 * 1024 * 1024 + 1024, 0);
    const payload = multipartBody({
      fieldName: 'file',
      filename: 'big.png',
      contentType: 'image/png',
      content: big,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: mpHeaders(),
      payload,
    });
    expect(res.statusCode).toBe(413);
  });

  it('accepts a small png → 201 with a /uploads/<uuid>.png url (UUID name, not client filename)', async () => {
    const payload = multipartBody({
      fieldName: 'file',
      filename: 'my-secret-name.png', // 클라 파일명 — 응답/저장에 절대 쓰이면 안 됨.
      contentType: 'image/png',
      content: PNG_1x1,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: mpHeaders(),
      payload,
    });
    expect(res.statusCode).toBe(201);
    const imageUrl = res.json().imageUrl as string;
    // 정확히 /uploads/<uuid>.png 형태.
    expect(imageUrl).toMatch(
      /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
    );
    // 클라 파일명이 경로에 들어가지 않았다.
    expect(imageUrl).not.toContain('my-secret-name');

    // 실제로 업로드 디렉토리에 UUID 파일이 생성됐다.
    const name = imageUrl.slice('/uploads/'.length);
    createdFiles.push(`${config.uploadDir}/${name}`);
    const files = await readdir(config.uploadDir);
    expect(files).toContain(name);

    // 키 누출 없음.
    expect(res.body).not.toMatch(/apiKey|API_KEY|BASE_URL|sk-[A-Za-z0-9]/i);
  });

  it('requires auth (401 without token)', async () => {
    const payload = multipartBody({
      fieldName: 'file',
      filename: 'x.png',
      contentType: 'image/png',
      content: PNG_1x1,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });
});
