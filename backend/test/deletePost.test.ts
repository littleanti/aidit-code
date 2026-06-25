// backend/test/deletePost.test.ts
// DELETE /posts/:id 검증 (글 삭제 + 샌드박스 폴더 정리, sandboxLifecycle §6.1 step7):
//   - 비작성자 → 403.
//   - 작성자 → 200; Post/Sandbox/Message/ToolCall/AgentSession/Vote/Bookmark 행 전부 삭제;
//     샌드박스 격리 디렉토리도 디스크에서 제거.
//   - deleteSandboxDir 안전장치: sandboxRoot 밖(또는 루트 자체) 경로는 거부.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createSandboxForPost, deleteSandboxDir } from '../src/sandbox/service.js';
import { config } from '../src/config.js';

let app: FastifyInstance;
const u = { id: '', token: '' };
const other = { id: '', token: '' };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const author = await prisma.user.create({
    data: { username: `del-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  u.id = author.id;
  u.token = app.jwt.sign({ userId: author.id, username: author.username });

  const peer = await prisma.user.create({
    data: { username: `peer-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  other.id = peer.id;
  other.token = app.jwt.sign({ userId: peer.id, username: peer.username });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [u.id, other.id] } } });
  await app.close();
  await prisma.$disconnect();
});

describe('DELETE /posts/:id (+ sandbox dir cleanup)', () => {
  it('non-author gets 403 and nothing is deleted', async () => {
    const post = await prisma.post.create({ data: { authorId: u.id, title: 'guard', body: '' } });
    const sandbox = await createSandboxForPost(post.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.post.findUnique({ where: { id: post.id } })).not.toBeNull();
    expect(existsSync(sandbox.path)).toBe(true);

    // cleanup
    await app.inject({ method: 'DELETE', url: `/posts/${post.id}`, headers: { authorization: `Bearer ${u.token}` } });
  });

  it('author deletes the post, all related rows, AND the sandbox directory', async () => {
    const post = await prisma.post.create({ data: { authorId: u.id, title: 'full', body: 'x' } });
    const sandbox = await createSandboxForPost(post.id);
    // a real file inside the sandbox dir (must be removed by rm -rf)
    await writeFile(path.join(sandbox.path, 'work.txt'), 'data');

    // session + toolCall + messages (incl. a self-referencing reply) to exercise FK-safe deletion
    const sess = await prisma.agentSession.create({
      data: { sandboxId: sandbox.id, status: 'IDLE', model: 'openai/gpt-4o-mini' },
    });
    const tool = await prisma.toolCall.create({
      data: { sessionId: sess.id, kind: 'FILE_WRITE', name: 'write_file', args: '{}', status: 'SUCCEEDED', exitCode: 0 },
    });
    const human = await prisma.message.create({
      data: { postId: post.id, authorId: u.id, type: 'HUMAN', status: 'COMPLETE', body: 'hi', seq: 1, sessionId: sess.id },
    });
    await prisma.message.create({
      data: { postId: post.id, type: 'AGENT_REPLY', status: 'COMPLETE', body: 'ok', seq: 2, sessionId: sess.id, replyToId: human.id },
    });
    await prisma.message.create({
      data: { postId: post.id, type: 'TOOL_CALL', status: 'COMPLETE', body: '', seq: 3, sessionId: sess.id, toolCallId: tool.id },
    });
    await prisma.vote.create({ data: { userId: u.id, postId: post.id } });
    await prisma.bookmark.create({ data: { userId: u.id, postId: post.id } });

    expect(existsSync(sandbox.path)).toBe(true);

    const res = await app.inject({
      method: 'DELETE',
      url: `/posts/${post.id}`,
      headers: { authorization: `Bearer ${u.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);

    // every related row gone
    expect(await prisma.post.findUnique({ where: { id: post.id } })).toBeNull();
    expect(await prisma.sandbox.findUnique({ where: { id: sandbox.id } })).toBeNull();
    expect(await prisma.agentSession.count({ where: { sandboxId: sandbox.id } })).toBe(0);
    expect(await prisma.toolCall.count({ where: { sessionId: sess.id } })).toBe(0);
    expect(await prisma.message.count({ where: { postId: post.id } })).toBe(0);
    expect(await prisma.vote.count({ where: { postId: post.id } })).toBe(0);
    expect(await prisma.bookmark.count({ where: { postId: post.id } })).toBe(0);

    // directory (and its contents) removed from disk
    expect(existsSync(sandbox.path)).toBe(false);
  });

  it('deleteSandboxDir refuses to delete the sandbox root or any path outside it', async () => {
    await expect(deleteSandboxDir(config.sandboxRoot)).rejects.toThrow();
    await expect(deleteSandboxDir(path.join(config.sandboxRoot, '..', 'evil'))).rejects.toThrow();
    // sandboxRoot itself must still exist after the rejected calls
    expect(existsSync(config.sandboxRoot)).toBe(true);
  });
});
