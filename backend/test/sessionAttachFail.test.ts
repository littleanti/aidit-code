// backend/test/sessionAttachFail.test.ts
// BE-SESS 회귀: 서버 재시작 후 stale RUNNING 샌드박스에서 세션 시작이 409 가 아니라
//   SUSPENDED 로 정규화되어 새 세션(201)을 반환하는지 검증한다.
//
// 시나리오(재시작 후 전형적 상태 재현):
//   - sandbox.status='RUNNING' + 활성(IDLE) AgentSession 행이 DB 에 남아있다.
//   - in-memory 핸들은 사라졌으므로 runtime.attach 가 throw 한다(여기선 vi.spyOn 으로 결정적 유도).
// 기대:
//   - 409 가 아니라, 라우트가 stale 세션을 STOPPED 로 닫고 샌드박스를 SUSPENDED 로 정규화한 뒤
//     fresh spawn(201) 을 반환한다(resume 경로).
//
// 격리/결정성: 실제 소켓 listen 없이 app.inject. spawn 은 stub piWorker(실제 네트워크 없음).
//   spawn 된 자식/DB 행/임시 디렉토리는 afterAll 에서 정리.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { piRuntime } from '../src/agent/pi.js';
import { killAllToolChildren } from '../src/agent/toolExec.js';

let app: FastifyInstance;
let token = '';

const created = {
  userId: '',
  postId: '',
  sandboxId: '',
  sandboxPath: '',
  staleSessionId: '',
  freshSessionId: '',
};
const spawnedSandboxIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const guest = await app.inject({
    method: 'POST',
    url: '/auth/guest',
    payload: { nickname: 'attach-fail' },
  });
  token = guest.json().token as string;
  created.userId = guest.json().id as string;
});

afterAll(async () => {
  vi.restoreAllMocks();
  try {
    killAllToolChildren();
  } catch {
    /* noop */
  }
  for (const sid of spawnedSandboxIds) {
    try {
      await piRuntime.suspend({ id: 's', sandboxId: sid });
    } catch {
      /* noop */
    }
  }
  if (created.postId) await prisma.message.deleteMany({ where: { postId: created.postId } });
  for (const sid of [created.staleSessionId, created.freshSessionId]) {
    if (!sid) continue;
    await prisma.toolCall.deleteMany({ where: { sessionId: sid } });
    await prisma.agentSession.deleteMany({ where: { id: sid } });
  }
  if (created.sandboxId) await prisma.sandbox.deleteMany({ where: { id: created.sandboxId } });
  if (created.postId) await prisma.post.deleteMany({ where: { id: created.postId } });
  if (created.userId) await prisma.user.deleteMany({ where: { id: created.userId } });
  if (created.sandboxPath) {
    try {
      await rm(created.sandboxPath, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  await app.close();
  await prisma.$disconnect();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('POST /posts/:id/session — stale RUNNING after restart (attach fails)', () => {
  it('normalizes RUNNING→SUSPENDED and starts a fresh session (201), not 409', async () => {
    // ── 재시작 후 stale 상태 재현: post + RUNNING 샌드박스(보존된 디렉토리) + 활성 IDLE 세션 행 ──
    const dir = await mkdtemp(path.join(tmpdir(), 'attach-fail-'));
    created.sandboxPath = dir;

    const post = await prisma.post.create({
      data: { authorId: created.userId, title: 'attach-fail test', body: '' },
    });
    created.postId = post.id;

    const sandbox = await prisma.sandbox.create({
      // status=RUNNING: 활동 이력이 있던 글이 재시작 후 남기는 전형적 상태.
      data: { postId: post.id, path: dir, status: 'RUNNING', runtime: 'pi' },
    });
    created.sandboxId = sandbox.id;

    const staleSession = await prisma.agentSession.create({
      // 활성(IDLE) 행이 남아있다 — attach 대상으로 선택된다.
      data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test-model', runtimePid: 1 },
    });
    created.staleSessionId = staleSession.id;

    // ── 핵심: 프로세스가 사라진 상태를 결정적으로 재현 — attach 가 throw 한다.
    //   (실제로도 재시작 후 in-memory handles 가 비어 attach 는 같은 에러를 던진다.)
    const attachSpy = vi
      .spyOn(piRuntime, 'attach')
      .mockRejectedValue(new Error('no active runtime process to attach to'));

    const res = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/session`,
      headers: auth(),
    });

    // attach 가 시도되었고(=stale 경로 진입) 실패했음을 확인.
    expect(attachSpy).toHaveBeenCalledTimes(1);

    // ★ 409 가 아니라 새 세션이 시작되어야 한다.
    expect(res.statusCode).not.toBe(409);
    expect(res.statusCode).toBe(201);

    const session = res.json().session as { id: string; status: string };
    created.freshSessionId = session.id;
    spawnedSandboxIds.push(sandbox.id);

    // 새 세션은 stale 세션과 다른 행이며 IDLE 로 안착.
    expect(session.id).not.toBe(staleSession.id);
    expect(session.status).toBe('IDLE');

    // 응답에 키 누출 없음(TRD §8).
    expect(res.body).not.toMatch(/apiKey|API_KEY|sk-[A-Za-z0-9]{8,}/);

    // stale 세션은 STOPPED 로 닫혔다.
    const staleAfter = await prisma.agentSession.findUnique({ where: { id: staleSession.id } });
    expect(staleAfter!.status).toBe('STOPPED');
    expect(staleAfter!.endedAt).not.toBeNull();

    // 샌드박스는 RUNNING→SUSPENDED 로 정규화된 뒤(fresh spawn 이 다시 RUNNING 으로 올린다).
    //   fresh-start 가 RUNNING 으로 되돌리므로 최종은 RUNNING 이지만, 정규화 없이는 절대
    //   여기까지 못 와 409 가 났을 것이다. 새 IDLE 세션의 존재가 정규화가 일어났음을 증명한다.
    const sandboxAfter = await prisma.sandbox.findUnique({ where: { id: sandbox.id } });
    expect(sandboxAfter!.status).toBe('RUNNING'); // fresh spawn 이 다시 RUNNING 으로.
  });

  it('does NOT force-resume a CREATING sandbox (still 409)', async () => {
    // RUNNING 만 stale-active 케이스. CREATING 은 진짜 준비중이므로 409 가 유지되어야 한다.
    const dir = await mkdtemp(path.join(tmpdir(), 'attach-fail-creating-'));
    const post = await prisma.post.create({
      data: { authorId: created.userId, title: 'creating test', body: '' },
    });
    const sandbox = await prisma.sandbox.create({
      data: { postId: post.id, path: dir, status: 'CREATING', runtime: 'pi' },
    });
    const stale = await prisma.agentSession.create({
      data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test-model', runtimePid: 1 },
    });

    const attachSpy = vi
      .spyOn(piRuntime, 'attach')
      .mockRejectedValue(new Error('no active runtime process to attach to'));

    const res = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/session`,
      headers: auth(),
    });

    expect(attachSpy).toHaveBeenCalled();
    expect(res.statusCode).toBe(409);

    // 정리.
    await prisma.agentSession.deleteMany({ where: { id: stale.id } });
    await prisma.sandbox.deleteMany({ where: { id: sandbox.id } });
    await prisma.post.deleteMany({ where: { id: post.id } });
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
});
