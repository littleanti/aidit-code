// backend/test/sessionStart.test.ts
// 세션 시작/attach 동시성 가드 회귀(BE-SESS 동시성):
//   (a) 같은 sandbox 에 대한 동시 startOrAttach 가 자식/활성 세션을 2개 만들지 않는다(per-sandbox mutex 로 coalesce).
//   (b) Race B: stale RUNNING 샌드박스에서 attach 가 throw 한 뒤 messages/aiMode 경로(ensureActiveSession)가
//       null 대신 정규화(RUNNING→SUSPENDED)+fresh-start 로 복구한다.
//   (c) session.ts 응답코드 보존: 200(attach) / 201(fresh) / 409(CREATING).
//
// 격리/결정성: 실제 소켓 listen 없이 app.inject + 직접 헬퍼 호출. spawn 은 stub piWorker(실제 네트워크 없음).
//   spawn 된 자식/DB 행/임시 디렉토리는 afterAll/각 케이스에서 정리. vi.spyOn(piRuntime,...) 시임 사용.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { piRuntime } from '../src/agent/pi.js';
import { startOrAttach, ACTIVE_STATUSES } from '../src/agent/sessionStart.js';
import { ensureActiveSession } from '../src/routes/messages.js';
import { killAllToolChildren } from '../src/agent/toolExec.js';

let app: FastifyInstance;
let token = '';
let userId = '';

const spawnedSandboxIds: string[] = [];
const cleanup: Array<{ postId: string; sandboxId: string; dir: string }> = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const guest = await app.inject({
    method: 'POST',
    url: '/auth/guest',
    payload: { nickname: 'sess-start' },
  });
  token = guest.json().token as string;
  userId = guest.json().id as string;
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
  for (const c of cleanup) {
    await prisma.message.deleteMany({ where: { postId: c.postId } });
    await prisma.toolCall.deleteMany({ where: { session: { sandboxId: c.sandboxId } } });
    await prisma.agentSession.deleteMany({ where: { sandboxId: c.sandboxId } });
    await prisma.sandbox.deleteMany({ where: { id: c.sandboxId } });
    await prisma.post.deleteMany({ where: { id: c.postId } });
    await rm(c.dir, { recursive: true, force: true }).catch(() => {});
  }
  if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  await app.close();
  await prisma.$disconnect();
});

const auth = () => ({ authorization: `Bearer ${token}` });

/** READY 샌드박스 + 글을 만든다(활성 세션 없음). 보존된 디렉토리 사용. */
async function makeReadySandbox(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const post = await prisma.post.create({
    data: { authorId: userId, title: `${prefix} test`, body: '' },
  });
  const sandbox = await prisma.sandbox.create({
    data: { postId: post.id, path: dir, status: 'READY', runtime: 'pi' },
  });
  cleanup.push({ postId: post.id, sandboxId: sandbox.id, dir });
  spawnedSandboxIds.push(sandbox.id);
  return { post, sandbox, dir };
}

describe('startOrAttach — per-sandbox mutex (Race A/D)', () => {
  it('coalesces concurrent calls for the SAME sandbox: one spawn, one active session', async () => {
    const { post, sandbox } = await makeReadySandbox('coalesce');

    // 실제 stub spawn 을 그대로 쓰되 호출 횟수만 관측한다(멱등+mutex 의 합으로 1회여야 한다).
    const spawnSpy = vi.spyOn(piRuntime, 'spawn');

    // 동일 sandbox 로 8개의 동시 호출.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        startOrAttach({
          postId: post.id,
          sandbox: { id: sandbox.id, path: sandbox.path, status: 'READY' },
        }),
      ),
    );

    // 전부 성공.
    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    // ★ spawn 은 정확히 1회만 호출되었다(mutex 로 coalesce → 단 하나의 임계구역 실행).
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    // ★ 활성 세션 행은 정확히 1개(두 개의 active 세션이 생기지 않았다).
    const activeRows = await prisma.agentSession.findMany({
      where: { sandboxId: sandbox.id, status: { in: ACTIVE_STATUSES } },
    });
    expect(activeRows).toHaveLength(1);

    // ★ 모든 호출자가 같은 세션 id 를 받았다(공유된 in-flight 결과).
    const ids = new Set(results.map((r) => (r.ok ? r.session.id : 'x')));
    expect(ids.size).toBe(1);

    // ★ in-memory 핸들도 하나(살아있는 자식 1개).
    expect(piRuntime.getPid(sandbox.id)).not.toBeNull();

    // 키 누출 없음.
    expect(JSON.stringify(results)).not.toMatch(/apiKey|API_KEY|sk-[A-Za-z0-9]{8,}/);

    spawnSpy.mockRestore();
  });
});

describe('ensureActiveSession — Race B recovery (stale RUNNING after restart)', () => {
  it('recovers (normalizes + fresh-starts) instead of returning null when attach throws', async () => {
    // 재시작 후 stale: sandbox RUNNING + 활성 IDLE 세션 행(보존된 디렉토리). in-memory 핸들 없음.
    const dir = await mkdtemp(path.join(tmpdir(), 'raceb-'));
    const post = await prisma.post.create({
      data: { authorId: userId, title: 'race-b test', body: '' },
    });
    const sandbox = await prisma.sandbox.create({
      data: { postId: post.id, path: dir, status: 'RUNNING', runtime: 'pi' },
    });
    const stale = await prisma.agentSession.create({
      data: { sandboxId: sandbox.id, status: 'IDLE', model: 'test-model', runtimePid: 1 },
    });
    cleanup.push({ postId: post.id, sandboxId: sandbox.id, dir });
    spawnedSandboxIds.push(sandbox.id);

    // 프로세스 소멸을 결정적으로 재현 — attach throw.
    const attachSpy = vi
      .spyOn(piRuntime, 'attach')
      .mockRejectedValue(new Error('no active runtime process to attach to'));

    // ★ 과거엔 여기서 null 을 반환해 aiMode 가 조용히 실패했다. 이제는 복구되어 세션을 반환해야 한다.
    const session = await ensureActiveSession(post.id, sandbox.id, sandbox.path, 'RUNNING');

    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(session).not.toBeNull();
    expect(session!.id).not.toBe(stale.id); // 새 세션(fresh-start).

    // stale 세션은 STOPPED 로 닫혔다.
    const staleAfter = await prisma.agentSession.findUnique({ where: { id: stale.id } });
    expect(staleAfter!.status).toBe('STOPPED');
    expect(staleAfter!.endedAt).not.toBeNull();

    // 새 세션은 IDLE 활성. 샌드박스는 fresh spawn 으로 다시 RUNNING.
    const fresh = await prisma.agentSession.findUnique({ where: { id: session!.id } });
    expect(fresh!.status).toBe('IDLE');
    const sandboxAfter = await prisma.sandbox.findUnique({ where: { id: sandbox.id } });
    expect(sandboxAfter!.status).toBe('RUNNING');

    attachSpy.mockRestore();
  });
});

describe('POST /posts/:id/session — response codes preserved', () => {
  it('returns 201 on fresh start, then 200 on attach to the live session', async () => {
    const { post, sandbox } = await makeReadySandbox('codes');

    // 1) fresh-start → 201.
    const r1 = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/session`,
      headers: auth(),
    });
    expect(r1.statusCode).toBe(201);
    const s1 = r1.json().session as { id: string; status: string };
    expect(s1.status).toBe('IDLE');

    // 2) 이제 live 세션이 있으므로 같은 요청은 attach → 200(같은 세션 id).
    const r2 = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/session`,
      headers: auth(),
    });
    expect(r2.statusCode).toBe(200);
    const s2 = r2.json().session as { id: string };
    expect(s2.id).toBe(s1.id);

    // 키 누출 없음.
    expect(r1.body).not.toMatch(/apiKey|API_KEY|sk-[A-Za-z0-9]{8,}/);
    expect(r2.body).not.toMatch(/apiKey|API_KEY|sk-[A-Za-z0-9]{8,}/);

    // sandbox.id 무관 — getPid 로 핸들 정리 대상 등록은 makeReadySandbox 에서 처리됨.
  });

  it('returns 409 for a CREATING sandbox (cannot start a session)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'creating-'));
    const post = await prisma.post.create({
      data: { authorId: userId, title: 'creating test', body: '' },
    });
    const sandbox = await prisma.sandbox.create({
      data: { postId: post.id, path: dir, status: 'CREATING', runtime: 'pi' },
    });
    cleanup.push({ postId: post.id, sandboxId: sandbox.id, dir });

    const res = await app.inject({
      method: 'POST',
      url: `/posts/${post.id}/session`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(409);
  });
});
