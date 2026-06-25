// backend/test/files.test.ts
// M6 워크스페이스 파일 API + file.changed 검증(BE-FILES/BE-FILECONTENT/RT-FILEEV):
//   - 트리: 샌드박스 아래 만든 파일/디렉토리가 dirs-first 로 나온다. '..'/절대경로 → 400(path violation).
//   - 내용: 텍스트 파일은 content, NUL 포함 파일은 binary:true(내용 미포함), 상한 초과 파일은 truncated:true.
//   - file.changed: FILE_WRITE 가 CREATED/MODIFIED 를 루트 상대 경로로 publish, FILE_DELETE 는 DELETED.
//     (in-process pubsub 구독으로 관측 — executeTool→toolBridge onFileChange 경로.)
//
// 임시 샌드박스 디렉토리를 쓰고 afterAll 에서 정리한다. 도구 shell 자식은 killAllToolChildren 으로 종료.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { bus } from '../src/realtime/pubsub.js';
import type { RealtimeEvent } from '../src/realtime/events.js';
import { runToolIntent } from '../src/agent/toolBridge.js';
import { killAllToolChildren } from '../src/agent/toolExec.js';

let app: FastifyInstance;
const created = { userId: '', postId: '', sandboxId: '', sandboxDir: '', sessionId: '' };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const dir = await mkdtemp(path.join(tmpdir(), 'files-'));
  created.sandboxDir = dir;

  const user = await prisma.user.create({
    data: { username: `files-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  created.userId = user.id;

  const post = await prisma.post.create({
    data: { authorId: user.id, title: 'files test', body: '' },
  });
  created.postId = post.id;

  const sandbox = await prisma.sandbox.create({
    data: { postId: post.id, path: dir, status: 'READY', runtime: 'pi' },
  });
  created.sandboxId = sandbox.id;

  // file.changed 테스트는 runToolIntent 를 직접 구동한다(createToolCall 이 sessionId FK 를 요구).
  const session = await prisma.agentSession.create({
    data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test-model' },
  });
  created.sessionId = session.id;

  // 시드 트리: a.txt, sub/b.txt, bin.dat(NUL), big.txt(상한 초과).
  await writeFile(path.join(dir, 'a.txt'), 'hello alpha', 'utf8');
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  await writeFile(path.join(dir, 'sub', 'b.txt'), 'beta inside sub', 'utf8');
  await writeFile(path.join(dir, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]));
  await writeFile(path.join(dir, 'big.txt'), 'x'.repeat(256 * 1024 + 100), 'utf8');
});

afterAll(async () => {
  killAllToolChildren();
  await prisma.toolCall.deleteMany({ where: { session: { sandboxId: created.sandboxId } } });
  await prisma.message.deleteMany({ where: { postId: created.postId } });
  await prisma.agentSession.deleteMany({ where: { sandboxId: created.sandboxId } });
  await prisma.sandbox.deleteMany({ where: { id: created.sandboxId } });
  await prisma.post.deleteMany({ where: { id: created.postId } });
  await prisma.user.deleteMany({ where: { id: created.userId } });
  await app.close();
  await prisma.$disconnect();
  try {
    await rm(created.sandboxDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe('GET /posts/:id/files (tree)', () => {
  it('lists entries dirs-first for files created under the sandbox', async () => {
    const r = await app.inject({ method: 'GET', url: `/posts/${created.postId}/files?path=.` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { entries: Array<{ name: string; path: string; type: string; size?: number }> };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('sub');
    // dirs-first: 'sub'(dir) 가 어떤 파일보다 앞에 온다.
    const subIdx = body.entries.findIndex((e) => e.name === 'sub');
    const fileIdx = body.entries.findIndex((e) => e.type === 'file');
    expect(subIdx).toBeLessThan(fileIdx);
    // 파일 엔트리는 size, 경로는 루트 상대.
    const aEntry = body.entries.find((e) => e.name === 'a.txt')!;
    expect(aEntry.type).toBe('file');
    expect(aEntry.path).toBe('a.txt');
    expect(aEntry.size).toBe(Buffer.byteLength('hello alpha'));
  });

  it('lists a nested directory with root-relative child paths', async () => {
    const r = await app.inject({ method: 'GET', url: `/posts/${created.postId}/files?path=sub` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { entries: Array<{ name: string; path: string }> };
    const b = body.entries.find((e) => e.name === 'b.txt')!;
    expect(b).toBeTruthy();
    expect(b.path).toBe('sub/b.txt');
  });

  it('rejects ".." traversal with 400 path violation', async () => {
    const r = await app.inject({ method: 'GET', url: `/posts/${created.postId}/files?path=${encodeURIComponent('../')}` });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'path violation' });
  });

  it('rejects absolute path with 400 path violation', async () => {
    const abs = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const r = await app.inject({ method: 'GET', url: `/posts/${created.postId}/files?path=${encodeURIComponent(abs)}` });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'path violation' });
  });
});

describe('GET /posts/:id/files/content', () => {
  it('returns content for a text file', async () => {
    const r = await app.inject({ method: 'GET', url: `/posts/${created.postId}/files/content?path=a.txt` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { content: string; truncated: boolean; size: number; path: string };
    expect(body.content).toBe('hello alpha');
    expect(body.truncated).toBe(false);
    expect(body.path).toBe('a.txt');
  });

  it('returns binary:true without content for a NUL-byte file', async () => {
    const r = await app.inject({ method: 'GET', url: `/posts/${created.postId}/files/content?path=bin.dat` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { binary?: boolean; content?: string; size: number };
    expect(body.binary).toBe(true);
    expect(body.content).toBeUndefined();
    expect(body.size).toBeGreaterThan(0);
  });

  it('returns truncated:true for a file over the cap', async () => {
    const r = await app.inject({ method: 'GET', url: `/posts/${created.postId}/files/content?path=big.txt` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { content: string; truncated: boolean; size: number };
    expect(body.truncated).toBe(true);
    expect(body.size).toBe(256 * 1024 + 100);
    expect(body.content.length).toBe(256 * 1024);
  });

  it('returns 400 when the target is a directory', async () => {
    const r = await app.inject({ method: 'GET', url: `/posts/${created.postId}/files/content?path=sub` });
    expect(r.statusCode).toBe(400);
  });

  it('rejects ".." traversal with 400 path violation', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/posts/${created.postId}/files/content?path=${encodeURIComponent('../secret.txt')}`,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'path violation' });
  });
});

describe('file.changed events from tool execution', () => {
  function ctx() {
    return { postId: created.postId, sessionId: created.sessionId, sandboxRoot: created.sandboxDir };
  }

  it('FILE_WRITE publishes CREATED with root-relative path, then MODIFIED on re-write', async () => {
    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(created.postId, (ev) => received.push(ev));
    try {
      await runToolIntent(ctx(), {
        kind: 'FILE_WRITE',
        name: 'write_file',
        relPath: 'notes/created.txt',
        content: 'first',
      });

      const createdEv = received.find(
        (e) => e.type === 'file.changed' && e.path === 'notes/created.txt',
      );
      expect(createdEv).toBeTruthy();
      if (createdEv && createdEv.type === 'file.changed') {
        expect(createdEv.change).toBe('CREATED');
        expect(createdEv.path).toBe('notes/created.txt'); // forward-slash, root-relative
        expect(createdEv.size).toBe(Buffer.byteLength('first'));
      }

      // 재기록 → MODIFIED.
      received.length = 0;
      await runToolIntent(ctx(), {
        kind: 'FILE_WRITE',
        name: 'write_file',
        relPath: 'notes/created.txt',
        content: 'second longer',
      });
      const modifiedEv = received.find(
        (e) => e.type === 'file.changed' && e.path === 'notes/created.txt',
      );
      expect(modifiedEv).toBeTruthy();
      if (modifiedEv && modifiedEv.type === 'file.changed') {
        expect(modifiedEv.change).toBe('MODIFIED');
        expect(modifiedEv.size).toBe(Buffer.byteLength('second longer'));
      }

      // 키 누출 없음.
      expect(JSON.stringify(received)).not.toMatch(/apiKey|API_KEY|baseURL|BASE_URL|sk-[A-Za-z0-9]/i);
    } finally {
      unsubscribe();
    }
  });

  it('FILE_DELETE publishes DELETED with root-relative path', async () => {
    // 먼저 만든 뒤 삭제.
    await runToolIntent(ctx(), {
      kind: 'FILE_WRITE',
      name: 'write_file',
      relPath: 'notes/todelete.txt',
      content: 'bye',
    });

    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(created.postId, (ev) => received.push(ev));
    try {
      await runToolIntent(ctx(), {
        kind: 'FILE_DELETE',
        name: 'delete_file',
        relPath: 'notes/todelete.txt',
      });
      const delEv = received.find(
        (e) => e.type === 'file.changed' && e.path === 'notes/todelete.txt',
      );
      expect(delEv).toBeTruthy();
      if (delEv && delEv.type === 'file.changed') {
        expect(delEv.change).toBe('DELETED');
        expect(delEv.size).toBeUndefined();
      }
    } finally {
      unsubscribe();
    }
  });

  it('path-escape FILE_WRITE does not publish file.changed', async () => {
    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(created.postId, (ev) => received.push(ev));
    try {
      await runToolIntent(ctx(), {
        kind: 'FILE_WRITE',
        name: 'write_file',
        relPath: '../escape.txt',
        content: 'nope',
      });
      const fileEv = received.find((e) => e.type === 'file.changed');
      expect(fileEv).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
