// backend/test/turnFailurePath.test.ts
// 2026-07-28 회귀 방어: **턴 실패가 사용자에게 보이는가**(TRD §11).
//
// 왜 이 테스트가 필요한가:
//   runAgentTurn 에 최상위 catch 를 추가했다(게시글 삭제 P2025 로 프로세스가 죽는 것을 막기 위해).
//   그 catch 는 "정상 실패"(런타임 오류 → AGENT_REPLY=FAILED + SYSTEM 버블) 경로도 지나간다.
//   잘못 흡수하면 사용자 화면에 아무 오류도 안 보이는 **조용한 실패**가 된다.
//   그런데 리포에 이 경로를 단언하는 테스트가 **하나도 없었다** — 즉 조용한 실패로 퇴화해도
//   아무도 못 잡는 상태였다. 이 파일이 그 공백을 메운다.
//
// 단언:
//   ① runAgentTurn 이 throw 하지 않는다(fire-and-forget 호출부 보호)
//   ② AGENT_REPLY 가 FAILED 로 확정된다
//   ③ SYSTEM 버블이 실제로 생성된다(사용자가 실패를 인지할 수 있다)
//   ④ 세션이 IDLE 로 복귀한다(RUNNING 에 갇히지 않는다)
//   ⑤ 실패한 턴은 commentCount 를 올리지 않는다(COMPLETE 만 카운트)
//   ⑥ SYSTEM 버블 문구에 키/원문이 실리지 않는다

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { prisma } from '../src/db.js';
import { runAgentTurn } from '../src/agent/turn.js';
import { piRuntime } from '../src/agent/pi.js';

/** 런타임이 던지는 오류에 키처럼 보이는 문자열을 섞어, 그것이 버블로 새지 않는지 확인한다. */
const RAW_ERROR = 'connect ECONNREFUSED 1.2.3.4:443 (api key sk-LEAKED-SENTINEL-0123456789)';

let sandboxDir = '';
const created = { userId: '', postId: '', sandboxId: '', sessionId: '', humanId: '' };

beforeAll(async () => {
  sandboxDir = await mkdtemp(path.join(tmpdir(), 'turnfail-sbx-'));

  const user = await prisma.user.create({
    data: { username: `turnfail-${Date.now()}`, passwordHash: 'x' },
  });
  created.userId = user.id;

  const post = await prisma.post.create({
    data: { title: 'turn failure path', body: 'x', authorId: user.id },
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

  const human = await prisma.message.create({
    data: {
      postId: post.id,
      authorId: user.id,
      type: 'HUMAN',
      status: 'COMPLETE',
      body: 'do something',
      seq: 1,
    },
  });
  created.humanId = human.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { postId: created.postId } });
  await prisma.toolCall.deleteMany({ where: { sessionId: created.sessionId } });
  await prisma.agentSession.deleteMany({ where: { id: created.sessionId } });
  await prisma.sandbox.deleteMany({ where: { id: created.sandboxId } });
  await prisma.post.deleteMany({ where: { id: created.postId } });
  await prisma.user.deleteMany({ where: { id: created.userId } });
  await rm(sandboxDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('턴 실패가 사용자에게 표면화된다 (TRD §11)', () => {
  it('런타임 오류 → FAILED + SYSTEM 버블 + IDLE 복귀, throw 없음', async () => {
    // 런타임이 턴 도중 실패하는 상황(LLM 연결 실패 등)을 주입.
    vi.spyOn(piRuntime, 'send').mockImplementation(async () => {
      throw new Error(RAW_ERROR);
    });

    const before = await prisma.post.findUnique({ where: { id: created.postId } });

    // ① throw 하지 않는다.
    await expect(
      runAgentTurn({
        post: { id: created.postId },
        session: { id: created.sessionId, sandboxId: created.sandboxId },
        humanMessage: { id: created.humanId, body: 'do something' },
        lang: 'ko',
        userId: created.userId,
      }),
    ).resolves.toBeUndefined();

    const messages = await prisma.message.findMany({
      where: { postId: created.postId },
      orderBy: { seq: 'asc' },
    });

    // ② AGENT_REPLY 가 FAILED 로 확정된다.
    const reply = messages.find((m) => m.type === 'AGENT_REPLY');
    expect(reply, 'AGENT_REPLY 가 생성되지 않았다').toBeTruthy();
    expect(reply?.status).toBe('FAILED');

    // ③ SYSTEM 버블이 실제로 생성된다 — 이게 없으면 사용자는 실패를 알 수 없다.
    const system = messages.filter((m) => m.type === 'SYSTEM');
    expect(system.length, 'SYSTEM 버블이 없다 — 조용한 실패로 퇴화했다').toBeGreaterThanOrEqual(1);
    expect(system.some((m) => m.body.length > 0)).toBe(true);

    // ④ 세션이 IDLE 로 복귀한다(RUNNING 에 갇히지 않는다).
    const sess = await prisma.agentSession.findUnique({ where: { id: created.sessionId } });
    expect(sess?.status).toBe('IDLE');

    // ⑤ 실패는 commentCount 를 올리지 않는다.
    const after = await prisma.post.findUnique({ where: { id: created.postId } });
    expect(after?.commentCount).toBe(before?.commentCount);

    // ⑥ 원문/키가 버블로 새지 않는다(일반 문구만).
    const blob = JSON.stringify(messages);
    expect(blob).not.toContain('sk-LEAKED-SENTINEL-0123456789');
    expect(blob).not.toContain('ECONNREFUSED');
  }, 30_000);

  it('성공 턴은 COMPLETE 로 확정되고 SYSTEM 버블을 만들지 않는다 (대조군)', async () => {
    // 실패 경로만 검사하면 "항상 FAILED" 로 퇴화해도 통과한다 — 성공 경로도 함께 고정한다.
    vi.spyOn(piRuntime, 'send').mockImplementation(async (_s, _i, _l, onToken) => {
      onToken?.('정상 응답');
    });

    const human2 = await prisma.message.create({
      data: {
        postId: created.postId,
        authorId: created.userId,
        type: 'HUMAN',
        status: 'COMPLETE',
        body: 'again',
        seq: 100,
      },
    });

    const systemBefore = await prisma.message.count({
      where: { postId: created.postId, type: 'SYSTEM' },
    });

    await runAgentTurn({
      post: { id: created.postId },
      session: { id: created.sessionId, sandboxId: created.sandboxId },
      humanMessage: { id: human2.id, body: 'again' },
      lang: 'ko',
      userId: created.userId,
    });

    const reply = await prisma.message.findFirst({
      where: { postId: created.postId, type: 'AGENT_REPLY', replyToId: human2.id },
    });
    expect(reply?.status).toBe('COMPLETE');
    expect(reply?.body).toBe('정상 응답');

    // 성공 턴은 SYSTEM 버블을 새로 만들지 않는다.
    const systemAfter = await prisma.message.count({
      where: { postId: created.postId, type: 'SYSTEM' },
    });
    expect(systemAfter).toBe(systemBefore);
  }, 30_000);
});
