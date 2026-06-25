// backend/test/stream.test.ts
// RT-STREAM + RT-REPLAY 검증(실제 SSE 엔드포인트):
//   - 연결 시 afterSeq 초과분 스냅샷을 message.created 프레임으로 재생한다.
//   - 연결 후 publish 된 라이브 이벤트(message.created)가 SSE 로 도착한다.
//   - SSE 프레임에 seq 가 id: 로 실려 Last-Event-ID 재연결 앵커가 된다.
//
// 실제 listen(임시 포트) + node http 로 -N 스타일 스트림을 읽는다. afterEach 에서 서버 종료.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { publishToPost } from '../src/realtime/publish.js';
import { makeMessageCreatedEvent } from '../src/realtime/events.js';

let app: FastifyInstance;
let baseUrl = '';
const created = { userId: '', postId: '' };

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const user = await prisma.user.create({
    data: { username: `stream-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  created.userId = user.id;
  const post = await prisma.post.create({
    data: { authorId: user.id, title: 'stream test', body: '' },
  });
  created.postId = post.id;

  // 사전 메시지 2개(스냅샷 재생 대상). seq 1,2.
  await prisma.message.create({
    data: { postId: post.id, authorId: user.id, type: 'HUMAN', status: 'COMPLETE', body: 'first', seq: 1 },
  });
  await prisma.message.create({
    data: { postId: post.id, authorId: user.id, type: 'HUMAN', status: 'COMPLETE', body: 'second', seq: 2 },
  });
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { postId: created.postId } });
  await prisma.post.deleteMany({ where: { id: created.postId } });
  await prisma.user.deleteMany({ where: { id: created.userId } });
  await app.close();
  await prisma.$disconnect();
});

/**
 * SSE 스트림을 연결하고 onChunk 로 누적된 텍스트를 검사한다.
 * collect(ms) 동안 수신한 raw 텍스트를 resolve 한다. headers 로 Last-Event-ID 등 전달 가능.
 */
function readStream(
  pathAndQuery: string,
  opts: { headers?: Record<string, string>; afterOpen?: () => void; ms: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + pathAndQuery, { headers: opts.headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
      });
      res.on('error', reject);
      // 연결이 열리고 첫 바이트 이후 라이브 publish 를 트리거.
      if (opts.afterOpen) setTimeout(opts.afterOpen, 50);
      setTimeout(() => {
        req.destroy();
        resolve(buf);
      }, opts.ms);
    });
    req.on('error', reject);
  });
}

describe('GET /posts/:id/stream', () => {
  it('replays afterSeq snapshot then delivers live message.created', async () => {
    const liveId = `live-${Date.now()}`;
    const text = await readStream(`/posts/${created.postId}/stream?afterSeq=0`, {
      ms: 400,
      afterOpen: () => {
        publishToPost(
          created.postId,
          makeMessageCreatedEvent({
            id: liveId,
            type: 'AGENT_REPLY',
            status: 'PENDING',
            body: '',
            authorId: null,
            seq: 3,
            replyToId: null,
            toolCallId: null,
            createdAt: new Date(),
          }),
        );
      },
    });

    // 스냅샷: seq 1,2 의 message.created 가 재생됨.
    expect(text).toContain('event: message.created');
    expect(text).toContain('"seq":1');
    expect(text).toContain('"seq":2');
    // seq 가 SSE id 로 실림(Last-Event-ID 앵커).
    expect(text).toContain('id: 1');
    expect(text).toContain('id: 2');
    // 라이브: 연결 후 publish 된 이벤트 도착.
    expect(text).toContain(liveId);
    expect(text).toContain('id: 3');

    // 키 누출 없음.
    expect(text).not.toMatch(/apiKey|API_KEY|baseURL|BASE_URL|sk-[A-Za-z0-9]/i);
  });

  it('Last-Event-ID replay starts after the given seq', async () => {
    // Last-Event-ID: 1 → seq>1 만 재생(=seq 2). seq 1 은 제외.
    const text = await readStream(`/posts/${created.postId}/stream`, {
      ms: 250,
      headers: { 'Last-Event-ID': '1' },
    });
    expect(text).toContain('"seq":2');
    // seq 1 의 message.created 프레임은 재생되지 않아야 한다(id: 1 줄 없음).
    expect(text).not.toContain('id: 1\n');
  });
});
