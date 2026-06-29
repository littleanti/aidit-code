// backend/test/provisionConcurrent.test.ts
// 회귀 가드(XC-MODE): provisionSandbox 가 Sandbox.meta 를 다시 쓸 때 concurrentTurns opt-in 플래그를 보존하는가.
//
// 배경: createSandboxForPost 가 생성 시 meta={concurrentTurns:<bool>} 를 기록하지만, provisionSandbox 가
//   READY 전환에서 meta 를 {runtime,provisionedAt,policy} 로 **통째로 덮어쓰면** concurrentTurns 가 사라져
//   READY 이후 항상 false 가 된다(브라우저→DB 실측으로 발견된 통합 버그). 이 테스트는 provision 이 기존
//   플래그를 머지·보존함을 단정한다. (기존 xcMode.test.ts 는 POST 직후=provision 전 meta 만 보므로 못 잡았다.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { prisma } from '../src/db.js';
import { createSandboxForPost, getSandboxConcurrent } from '../src/sandbox/service.js';
import { provisionSandbox } from '../src/sandbox/provision.js';

describe('provisionSandbox — XC-MODE concurrentTurns 보존(회귀)', () => {
  let userId = '';
  const postIds: string[] = [];
  const paths: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { username: `xcp-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
    });
    userId = user.id;
  });

  afterAll(async () => {
    for (const p of paths) {
      try {
        await rm(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    for (const pid of postIds) {
      await prisma.sandbox.deleteMany({ where: { postId: pid } });
      await prisma.post.deleteMany({ where: { id: pid } });
    }
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function setup(concurrentTurns: boolean) {
    const post = await prisma.post.create({ data: { authorId: userId, title: 'xcp', body: '' } });
    postIds.push(post.id);
    const sandbox = await createSandboxForPost(post.id, { concurrentTurns });
    paths.push(sandbox.path);
    return sandbox;
  }

  it('preserves concurrentTurns:true through provisioning (CREATING→READY)', async () => {
    const sandbox = await setup(true);
    // 생성 직후엔 true (createSandboxForPost 가 기록).
    expect(getSandboxConcurrent({ meta: sandbox.meta })).toBe(true);

    // limiter 슬롯은 잡지 않는다(테스트가 세마포어를 건드리지 않도록).
    // 전체 sandbox 행(meta 포함)을 그대로 넘긴다 — 라우트(posts.ts)의 호출 형태와 동일.
    await provisionSandbox(sandbox, { acquireSlot: false, releaseSlot: false });

    const after = await prisma.sandbox.findUnique({
      where: { id: sandbox.id },
      select: { meta: true, status: true },
    });
    expect(after!.status).toBe('READY');
    // ← 회귀 가드: provision 이 meta 를 다시 써도 concurrentTurns 가 보존돼야 한다.
    expect(getSandboxConcurrent({ meta: after!.meta })).toBe(true);
    // provision 마커(runtime/policy)도 함께 기록되어 있어야 한다(머지 결과).
    const parsed = JSON.parse(after!.meta!);
    expect(parsed.runtime).toBeDefined();
    expect(parsed.policy).toBeDefined();
    expect(parsed.concurrentTurns).toBe(true);
  });

  it('keeps concurrentTurns:false false through provisioning', async () => {
    const sandbox = await setup(false);
    // 전체 sandbox 행(meta 포함)을 그대로 넘긴다 — 라우트(posts.ts)의 호출 형태와 동일.
    await provisionSandbox(sandbox, { acquireSlot: false, releaseSlot: false });
    const after = await prisma.sandbox.findUnique({ where: { id: sandbox.id }, select: { meta: true } });
    expect(getSandboxConcurrent({ meta: after!.meta })).toBe(false);
  });
});
