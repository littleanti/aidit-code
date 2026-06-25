// backend/test/toolCall.test.ts
// M5 도구 실행 표면 검증(BE-TOOL/AR-TOOL/RT-TOOLEV/toolExec):
//   - FILE_WRITE: 샌드박스 디렉토리에 실제 파일이 생기고, ToolCall SUCCEEDED +
//     TOOL_CALL/TOOL_RESULT 버블이 연결되며, tool.call → tool.output → tool.result 이벤트가
//     in-process pubsub 구독으로 관측된다.
//   - SHELL(비0 종료): ToolCall FAILED + exitCode 캡처, tool.result status FAILED.
//   - path-escape FILE_WRITE('../escape'): PathEscapeError 로 거부 → ToolCall FAILED 'path violation',
//     루트 밖에 파일이 생기지 않는다.
//
// 모두 실제 spawn 된 piWorker 를 통해 runAgentTurn 으로 구동한다(end-to-end 경로 검증).
// spawn 된 자식 + 도구 shell 자식은 afterEach 에서 모두 종료.

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/db.js';
import { bus } from '../src/realtime/pubsub.js';
import type { RealtimeEvent } from '../src/realtime/events.js';
import { piRuntime } from '../src/agent/pi.js';
import { runAgentTurn } from '../src/agent/turn.js';
import { killAllToolChildren } from '../src/agent/toolExec.js';

const spawnedSandboxIds: string[] = [];
const cleanup: Array<{ userId: string; postId: string; sandboxId: string; sessionId: string }> = [];

afterEach(async () => {
  killAllToolChildren();
  for (const sid of spawnedSandboxIds) {
    try {
      await piRuntime.suspend({ id: 's', sandboxId: sid });
    } catch {
      /* noop */
    }
  }
  spawnedSandboxIds.length = 0;
});

afterAll(async () => {
  for (const c of cleanup) {
    await prisma.message.deleteMany({ where: { postId: c.postId } });
    await prisma.toolCall.deleteMany({ where: { sessionId: c.sessionId } });
    await prisma.agentSession.deleteMany({ where: { id: c.sessionId } });
    await prisma.sandbox.deleteMany({ where: { id: c.sandboxId } });
    await prisma.post.deleteMany({ where: { id: c.postId } });
    await prisma.user.deleteMany({ where: { id: c.userId } });
  }
  await prisma.$disconnect();
});

async function setupSession(): Promise<{
  postId: string;
  sessionId: string;
  sandboxId: string;
  sandboxDir: string;
  humanId: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tool-'));
  const user = await prisma.user.create({
    data: { username: `tool-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
  });
  const post = await prisma.post.create({
    data: { authorId: user.id, title: 'tool test', body: '' },
  });
  const sandbox = await prisma.sandbox.create({
    data: { postId: post.id, path: dir, status: 'RUNNING', runtime: 'pi' },
  });
  const { pid } = await piRuntime.spawn({ id: sandbox.id, path: dir });
  spawnedSandboxIds.push(sandbox.id);
  const session = await prisma.agentSession.create({
    data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test-model', runtimePid: pid },
  });
  const human = await prisma.message.create({
    data: { postId: post.id, authorId: user.id, type: 'HUMAN', status: 'COMPLETE', body: 'seed', seq: 1 },
  });

  cleanup.push({ userId: user.id, postId: post.id, sandboxId: sandbox.id, sessionId: session.id });
  return { postId: post.id, sessionId: session.id, sandboxId: sandbox.id, sandboxDir: dir, humanId: human.id };
}

describe('M5 tool execution surface', () => {
  it('FILE_WRITE: creates a real file, ToolCall SUCCEEDED, linked bubbles, tool.* event order', async () => {
    const { postId, sessionId, sandboxId, sandboxDir, humanId } = await setupSession();

    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(postId, (ev) => received.push(ev));

    try {
      await runAgentTurn({
        post: { id: postId },
        session: { id: sessionId, sandboxId },
        humanMessage: { id: humanId, body: '!write notes/hello.txt hello sandbox world' },
        lang: 'en',
      });

      // 실제 파일이 샌드박스 안에 생겼는지.
      const target = path.join(sandboxDir, 'notes', 'hello.txt');
      const content = await readFile(target, 'utf8');
      expect(content).toBe('hello sandbox world');

      // ToolCall SUCCEEDED.
      const tc = await prisma.toolCall.findFirst({ where: { sessionId } });
      expect(tc).toBeTruthy();
      expect(tc!.kind).toBe('FILE_WRITE');
      expect(tc!.status).toBe('SUCCEEDED');
      expect(tc!.exitCode).toBe(0);

      // 연결된 TOOL_CALL 버블(toolCallId 1:1) + TOOL_RESULT 버블(replyTo == TOOL_CALL 버블).
      const callBubble = await prisma.message.findUnique({ where: { toolCallId: tc!.id } });
      expect(callBubble).toBeTruthy();
      expect(callBubble!.type).toBe('TOOL_CALL');
      const resultBubble = await prisma.message.findFirst({
        where: { replyToId: callBubble!.id, type: 'TOOL_RESULT' },
      });
      expect(resultBubble).toBeTruthy();
      expect(resultBubble!.status).toBe('COMPLETE');

      // tool.* 이벤트 순서: tool.call → tool.output(≥1) → tool.result(SUCCEEDED).
      const toolCallEv = received.find((e) => e.type === 'tool.call');
      const toolOutEv = received.filter((e) => e.type === 'tool.output');
      const toolResEv = received.find((e) => e.type === 'tool.result');
      expect(toolCallEv).toBeTruthy();
      expect(toolOutEv.length).toBeGreaterThan(0);
      expect(toolResEv).toBeTruthy();
      if (toolResEv && toolResEv.type === 'tool.result') {
        expect(toolResEv.status).toBe('SUCCEEDED');
        expect(toolResEv.exitCode).toBe(0);
      }
      const callIdx = received.findIndex((e) => e.type === 'tool.call');
      const outIdx = received.findIndex((e) => e.type === 'tool.output');
      const resIdx = received.findIndex((e) => e.type === 'tool.result');
      expect(callIdx).toBeLessThan(outIdx);
      expect(outIdx).toBeLessThan(resIdx);

      // 키 누출 없음.
      expect(JSON.stringify(received)).not.toMatch(/apiKey|API_KEY|baseURL|BASE_URL|sk-[A-Za-z0-9]/i);
    } finally {
      unsubscribe();
    }
  });

  it('SHELL nonzero exit: ToolCall FAILED with exitCode, tool.result FAILED', async () => {
    const { postId, sessionId, sandboxId, humanId } = await setupSession();

    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(postId, (ev) => received.push(ev));

    try {
      await runAgentTurn({
        post: { id: postId },
        session: { id: sessionId, sandboxId },
        humanMessage: { id: humanId, body: '!shell exit 3' },
        lang: 'en',
      });

      const tc = await prisma.toolCall.findFirst({ where: { sessionId } });
      expect(tc).toBeTruthy();
      expect(tc!.kind).toBe('SHELL');
      expect(tc!.status).toBe('FAILED');
      expect(tc!.exitCode).toBe(3);

      const toolResEv = received.find((e) => e.type === 'tool.result');
      expect(toolResEv).toBeTruthy();
      if (toolResEv && toolResEv.type === 'tool.result') {
        expect(toolResEv.status).toBe('FAILED');
        expect(toolResEv.exitCode).toBe(3);
      }
    } finally {
      unsubscribe();
    }
  });

  it('path-escape FILE_WRITE: rejected, ToolCall FAILED "path violation", no file outside root', async () => {
    const { postId, sessionId, sandboxId, sandboxDir, humanId } = await setupSession();

    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(postId, (ev) => received.push(ev));

    try {
      await runAgentTurn({
        post: { id: postId },
        session: { id: sessionId, sandboxId },
        humanMessage: { id: humanId, body: '!write ../escape.txt should be rejected' },
        lang: 'en',
      });

      const tc = await prisma.toolCall.findFirst({ where: { sessionId } });
      expect(tc).toBeTruthy();
      expect(tc!.status).toBe('FAILED');
      expect(tc!.result).toContain('path violation');

      const toolResEv = received.find((e) => e.type === 'tool.result');
      expect(toolResEv).toBeTruthy();
      if (toolResEv && toolResEv.type === 'tool.result') {
        expect(toolResEv.status).toBe('FAILED');
        expect(toolResEv.result).toContain('path violation');
      }

      // 루트 밖(부모 디렉토리)에 파일이 생기지 않았는지.
      const escapedPath = path.join(path.dirname(sandboxDir), 'escape.txt');
      await expect(stat(escapedPath)).rejects.toThrow();
    } finally {
      unsubscribe();
    }
  });
});
