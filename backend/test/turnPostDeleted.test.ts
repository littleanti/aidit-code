// backend/test/turnPostDeleted.test.ts
// 2026-07-28 회귀 방어: **턴 진행 중 게시글 삭제 → 백엔드 프로세스 크래시** 재발 차단.
//
// 원 결함(E2 하네스 실측 중 발견 — 180런 중 39런 연쇄 실패의 진범):
//   runAgentTurn 의 4)·5) 단계(최종 body/status 영속화, commentCount, SYSTEM 버블, IDLE 전이)가
//   try/catch 밖에 있었다. 게시글이 턴 도중 삭제되면 AGENT_REPLY 행이 사라져
//   `prisma.message.update()` 가 P2025 로 던지는데, 호출부가 `void runAgentTurn(...)` 라
//   아무도 받지 않는 **unhandled rejection** → Node 20+ 기본 정책상 프로세스 즉시 종료.
//   → 인증만 있으면 누구나 자기 글을 턴 중에 지워 백엔드 전체를 내릴 수 있었다(원격 DoS).
//
// 이 테스트는 "프로세스가 죽는다"를 in-process 로 직접 재현할 수 없으므로(죽으면 러너도 죽는다),
// 그 **직전 조건**을 단언한다: runAgentTurn 이 반환하는 Promise 가 **reject 하지 않는 것**.
// reject 하면 fire-and-forget 호출부에서 그대로 unhandled rejection 이 되어 프로세스가 죽는다.
// 즉 "reject 하지 않음" == "프로세스가 살아남음" 이 성립한다.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { prisma } from '../src/db.js';
import { runAgentTurn } from '../src/agent/turn.js';
import { piRuntime } from '../src/agent/pi.js';
import { killAllToolChildren } from '../src/agent/toolExec.js';

let sandboxDir = '';
const created = { userId: '', postId: '', sandboxId: '', sessionId: '' };

beforeAll(async () => {
  sandboxDir = await mkdtemp(path.join(tmpdir(), 'turndel-sbx-'));

  const user = await prisma.user.create({
    data: { username: `turndel-${Date.now()}`, passwordHash: 'x' },
  });
  created.userId = user.id;

  const post = await prisma.post.create({
    data: { title: 'turn-vs-delete', body: 'race', authorId: user.id },
  });
  created.postId = post.id;

  const sandbox = await prisma.sandbox.create({
    data: { postId: post.id, path: sandboxDir, status: 'READY', runtime: 'pi' },
  });
  created.sandboxId = sandbox.id;

  const session = await prisma.agentSession.create({
    data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test/stub' },
  });
  created.sessionId = session.id;
});

afterAll(async () => {
  killAllToolChildren();
  try {
    await piRuntime.suspend({ id: created.sessionId, sandboxId: created.sandboxId });
  } catch {
    /* noop */
  }
  // 게시글은 테스트 본문에서 이미 지워졌을 수 있다 — deleteMany 로 멱등 정리.
  await prisma.message.deleteMany({ where: { postId: created.postId } });
  await prisma.toolCall.deleteMany({ where: { sessionId: created.sessionId } });
  await prisma.agentSession.deleteMany({ where: { id: created.sessionId } });
  await prisma.sandbox.deleteMany({ where: { id: created.sandboxId } });
  await prisma.post.deleteMany({ where: { id: created.postId } });
  await prisma.user.deleteMany({ where: { id: created.userId } });
  await rm(sandboxDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('turn vs. post deletion race (P2025 must not kill the process)', () => {
  it('runAgentTurn resolves (never rejects) when the post is deleted mid-turn', async () => {
    const turn = runAgentTurn({
      post: { id: created.postId },
      session: { id: created.sessionId, sandboxId: created.sandboxId },
      humanMessage: { id: null as unknown as string, body: 'hello' },
      lang: 'en',
      userId: created.userId,
    } as Parameters<typeof runAgentTurn>[0]);

    // 턴이 AGENT_REPLY 행을 만들 때까지 짧게 기다린 뒤, 그 아래에서 게시글을 통째로 지운다.
    // (실사용의 "진행 중 삭제"와 동일한 순서 — 삭제가 먼저 끝나고 턴이 나중에 마무리를 시도한다.)
    for (let i = 0; i < 200; i++) {
      const n = await prisma.message.count({
        where: { postId: created.postId, type: 'AGENT_REPLY' },
      });
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    await prisma.message.deleteMany({ where: { postId: created.postId } });
    await prisma.toolCall.deleteMany({ where: { sessionId: created.sessionId } });
    await prisma.agentSession.deleteMany({ where: { id: created.sessionId } });
    await prisma.sandbox.deleteMany({ where: { id: created.sandboxId } });
    await prisma.post.deleteMany({ where: { id: created.postId } });

    // ★ 핵심 단언: reject 하지 않는다. (수정 전에는 P2025 로 reject → unhandled → 프로세스 종료.)
    await expect(turn).resolves.toBeUndefined();
  }, 30_000);

  it('the process is still alive and Prisma still serves queries afterwards', async () => {
    // 크래시했다면 여기까지 오지 못한다. 후속 쿼리가 정상 동작하는지까지 확인.
    const n = await prisma.user.count({ where: { id: created.userId } });
    expect(n).toBe(1);
  });
});
