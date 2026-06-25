// backend/test/reasoningEffort.test.ts
// Feature B(reasoning_effort) + Feature A 비전 스레드-스루 검증:
//   (1) buildCompletionBody(순수): reasoning_effort 는 값이 있을 때만 body 에 포함(없으면 생략, 무효값도 생략).
//   (2) buildUserContent(순수): 이미지 없으면 plain string, 있으면 multimodal 배열(text + image_url data-url).
//       업로드 디렉토리 밖 absPath 는 가드로 거부 → 텍스트-only 폴백.
//   (3) runAgentTurn → runtime.send 로 image{absPath,mime}·reasoningEffort 가 options 인자로 흘러간다(spy 캡처).
//   (4) messages 라우트의 reasoningEffort 검증: 무효값 400, aiMode 기본 medium.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { piRuntime } from '../src/agent/pi.js';
import { runAgentTurn } from '../src/agent/turn.js';
import {
  buildCompletionBody,
  buildUserContent,
  reasoningEffortApplies,
} from '../src/agent/piWorkerBody.mjs';

const TOOLS = [{ type: 'function', function: { name: 'noop' } }];

describe('reasoningEffortApplies (Feature B — model/env safety gate)', () => {
  it('auto (default): sends ONLY for reasoning models, not gpt-4o-mini', () => {
    // 비-reasoning → 미전송 (gpt-4o-mini 회귀 방지)
    expect(reasoningEffortApplies('openai/gpt-4o-mini', 'medium', undefined)).toBe(false);
    expect(reasoningEffortApplies('gpt-4o', 'high', 'auto')).toBe(false);
    // reasoning 패턴 → 전송
    expect(reasoningEffortApplies('o3', 'medium', 'auto')).toBe(true);
    expect(reasoningEffortApplies('openai/o4-mini', 'low', undefined)).toBe(true);
    expect(reasoningEffortApplies('gpt-5', 'high', 'auto')).toBe(true);
  });

  it('on: always sends for a valid effort; off: never sends', () => {
    expect(reasoningEffortApplies('openai/gpt-4o-mini', 'medium', 'on')).toBe(true);
    expect(reasoningEffortApplies('o3', 'medium', 'off')).toBe(false);
  });

  it('invalid/absent effort never applies regardless of model/override', () => {
    for (const eff of [undefined, null, '', 'extreme', 'LOW', 5] as unknown[]) {
      expect(reasoningEffortApplies('o3', eff as never, 'on')).toBe(false);
    }
  });
});

describe('buildCompletionBody (Feature B — pure)', () => {
  it('includes reasoning_effort ONLY when a valid value is provided', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    for (const eff of ['low', 'medium', 'high']) {
      const body = buildCompletionBody(msgs, 'm', TOOLS, eff);
      expect(body.reasoning_effort).toBe(eff);
    }
  });

  it('omits reasoning_effort when absent or invalid', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    for (const eff of [undefined, null, '', 'extreme', 'LOW', 5]) {
      const body = buildCompletionBody(msgs, 'm', TOOLS, eff as never);
      expect('reasoning_effort' in body).toBe(false);
    }
  });

  it('always carries the core fields (model/stream/tools/messages)', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    const body = buildCompletionBody(msgs, 'my-model', TOOLS, undefined);
    expect(body.model).toBe('my-model');
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBe('auto');
    expect(body.messages).toBe(msgs);
  });
});

describe('buildUserContent (Feature A — pure, vision)', () => {
  let dir = '';
  let imgAbs = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vis-'));
    imgAbs = path.join(dir, 'a.png');
    await writeFile(imgAbs, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // 'PNG' 시그니처 바이트.
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns the plain string when no image is attached', async () => {
    const content = await buildUserContent('hello', undefined, dir);
    expect(content).toBe('hello');
  });

  it('returns a multimodal array (text + image_url data-url) when an in-dir image is attached', async () => {
    const content = await buildUserContent('describe this', { absPath: imgAbs, mime: 'image/png' }, dir);
    expect(Array.isArray(content)).toBe(true);
    const arr = content as Array<Record<string, unknown>>;
    expect(arr[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(arr[1].type).toBe('image_url');
    const url = (arr[1].image_url as { url: string }).url;
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to text-only when absPath escapes the upload dir (path guard)', async () => {
    const content = await buildUserContent('x', { absPath: '/etc/passwd', mime: 'image/png' }, dir);
    expect(content).toBe('x'); // 가드 거부 → 텍스트-only.
  });

  it('allows an image-only message (empty text → text part is empty string)', async () => {
    const content = await buildUserContent('', { absPath: imgAbs, mime: 'image/png' }, dir);
    const arr = content as Array<Record<string, unknown>>;
    expect(arr[0]).toEqual({ type: 'text', text: '' });
    expect(arr[1].type).toBe('image_url');
  });
});

describe('runAgentTurn → runtime.send options (Feature A/B thread-through)', () => {
  const cleanup: Array<{ userId: string; postId: string; sandboxId: string; sessionId: string }> = [];

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const c of cleanup) {
      await prisma.message.deleteMany({ where: { postId: c.postId } });
      await prisma.agentSession.deleteMany({ where: { id: c.sessionId } });
      await prisma.sandbox.deleteMany({ where: { id: c.sandboxId } });
      await prisma.post.deleteMany({ where: { id: c.postId } });
      await prisma.user.deleteMany({ where: { id: c.userId } });
    }
    await prisma.$disconnect();
  });

  it('passes image{absPath,mime} and reasoningEffort as the options arg to runtime.send', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rt-'));
    const user = await prisma.user.create({
      data: { username: `re-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
    });
    const post = await prisma.post.create({ data: { authorId: user.id, title: 're test', body: '' } });
    const sandbox = await prisma.sandbox.create({
      data: { postId: post.id, path: dir, status: 'RUNNING', runtime: 'pi' },
    });
    const session = await prisma.agentSession.create({
      data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test-model', runtimePid: 1 },
    });
    const human = await prisma.message.create({
      data: { postId: post.id, authorId: user.id, type: 'HUMAN', status: 'COMPLETE', body: 'see img', seq: 1 },
    });
    cleanup.push({ userId: user.id, postId: post.id, sandboxId: sandbox.id, sessionId: session.id });

    // runtime.send 를 mock — 실제 worker 없이 options 인자만 캡처하고 즉시 resolve(턴 완료).
    const sendSpy = vi
      .spyOn(piRuntime, 'send')
      .mockImplementation(async (_s, _input, _lang, onToken) => {
        onToken('ok'); // 토큰 1개 흘려 STREAMING→COMPLETE 경로 유지.
      });

    const image = { absPath: path.join(dir, 'pic.png'), mime: 'image/png' };
    await runAgentTurn({
      post: { id: post.id },
      session: { id: session.id, sandboxId: sandbox.id },
      humanMessage: { id: human.id, body: 'see img' },
      lang: 'en',
      image,
      reasoningEffort: 'high',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const callArgs = sendSpy.mock.calls[0];
    // send(session, input, lang, onToken, onTool?, options?) — options 는 6번째 인자.
    const options = callArgs[5] as { image?: typeof image; reasoningEffort?: string };
    expect(options).toBeDefined();
    expect(options.image).toEqual(image);
    expect(options.reasoningEffort).toBe('high');

    sendSpy.mockRestore();
  });
});

describe('POST /posts/:id/messages — reasoningEffort validation (Feature B)', () => {
  let app: FastifyInstance;
  let token = '';
  let userId = '';
  let postId = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const user = await prisma.user.create({
      data: { username: `rev-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
    });
    userId = user.id;
    token = app.jwt.sign({ userId: user.id, username: user.username });
    const post = await prisma.post.create({ data: { authorId: user.id, title: 're val', body: '' } });
    postId = post.id;
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { postId } });
    await prisma.post.deleteMany({ where: { id: postId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('rejects an invalid reasoningEffort with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/messages`,
      headers: auth(),
      payload: { body: 'x', aiMode: false, clientId: `re-bad-${Date.now()}`, reasoningEffort: 'extreme' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reasoningEffort/i);
  });

  it('accepts a valid reasoningEffort (no agent spawn since aiMode=false)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/messages`,
      headers: auth(),
      payload: { body: 'x', aiMode: false, clientId: `re-ok-${Date.now()}`, reasoningEffort: 'low' },
    });
    expect(res.statusCode).toBe(201);
  });
});
