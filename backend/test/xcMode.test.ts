// backend/test/xcMode.test.ts
// M8 XC-MODE — v2 동시 병렬 협업 opt-in 게이트(기본 OFF) 백엔드 슬라이스 검증.
// 계약(고정):
//   - POST /posts body concurrent?:boolean — 정확히 true 일 때만 true(미지정/null/비-boolean → false).
//   - 저장: Sandbox.meta(JSON) = `{"concurrentTurns": <bool>}` (meta 는 객체로 저장).
//   - 읽기 헬퍼 getSandboxConcurrent(meta 안전 파싱; 손상/부재 → false).
//   - 동작 불변: 이번 WP 는 플래그 저장·노출만, 런타임 분기 없음(항상 v0.1 직렬).
// 단언:
//   (1) concurrent:true → 생성된 Sandbox.meta 에 concurrentTurns:true 저장.
//   (2) concurrent 미지정 → concurrentTurns:false 저장(meta 부재 아님; 명시 false).
//   (3) concurrent:"yes"(비-boolean)/null → false.
//   (4) getSandboxConcurrent 단위: 다양한 meta 입력에 대한 안전 파싱.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { getSandboxConcurrent } from '../src/sandbox/service.js';

describe('getSandboxConcurrent (XC-MODE — meta 안전 파싱, 순수)', () => {
  it('returns true only for valid {"concurrentTurns": true}', () => {
    expect(getSandboxConcurrent({ meta: JSON.stringify({ concurrentTurns: true }) })).toBe(true);
  });

  it('returns false for explicit false / missing key / null / empty meta', () => {
    expect(getSandboxConcurrent({ meta: JSON.stringify({ concurrentTurns: false }) })).toBe(false);
    expect(getSandboxConcurrent({ meta: JSON.stringify({ other: 1 }) })).toBe(false);
    expect(getSandboxConcurrent({ meta: null })).toBe(false);
    expect(getSandboxConcurrent({ meta: '' })).toBe(false);
  });

  it('returns false for non-boolean concurrentTurns (truthy non-true) and corrupt JSON', () => {
    expect(getSandboxConcurrent({ meta: JSON.stringify({ concurrentTurns: 'true' }) })).toBe(false);
    expect(getSandboxConcurrent({ meta: JSON.stringify({ concurrentTurns: 1 }) })).toBe(false);
    expect(getSandboxConcurrent({ meta: '{not valid json' })).toBe(false);
    // 객체가 아닌 JSON(배열/스칼라)도 안전하게 false.
    expect(getSandboxConcurrent({ meta: '42' })).toBe(false);
    expect(getSandboxConcurrent({ meta: 'null' })).toBe(false);
  });
});

describe('POST /posts — concurrent flag → Sandbox.meta (XC-MODE)', () => {
  let app: FastifyInstance;
  let token = '';
  let userId = '';
  const createdPostIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const user = await prisma.user.create({
      data: { username: `xc-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
    });
    userId = user.id;
    token = app.jwt.sign({ userId: user.id, username: user.username });
  });

  afterAll(async () => {
    for (const pid of createdPostIds) {
      await prisma.message.deleteMany({ where: { postId: pid } });
      await prisma.agentSession.deleteMany({ where: { sandbox: { postId: pid } } });
      await prisma.sandbox.deleteMany({ where: { postId: pid } });
      await prisma.post.deleteMany({ where: { id: pid } });
    }
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
    await prisma.$disconnect();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  async function createPost(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: auth(),
      // autoReply:false 로 자동 응답 턴/세션 스폰을 피한다(메타 저장만 검증).
      payload: { title: 'xc', body: '', autoReply: false, ...payload },
    });
    expect(res.statusCode).toBe(201);
    const postId = res.json().post.id as string;
    createdPostIds.push(postId);
    return postId;
  }

  async function metaConcurrent(postId: string): Promise<boolean> {
    const sandbox = await prisma.sandbox.findUnique({ where: { postId }, select: { meta: true } });
    expect(sandbox).not.toBeNull();
    return getSandboxConcurrent({ meta: sandbox!.meta });
  }

  it('concurrent:true → meta.concurrentTurns === true', async () => {
    const postId = await createPost({ concurrent: true });
    // 생성 시 concurrentTurns:true 가 저장된다. 단, fire-and-forget provisionSandbox 가 READY 전환에서
    //   meta 를 {runtime,provisionedAt,policy,concurrentTurns} 로 머지할 수 있어(타이밍 의존), 생성시점
    //   '정확한 문자열'이 아니라 '플래그 보존'만 단정한다(머지 전/후 모두 성립). 머지 계약 자체는
    //   provisionConcurrent.test.ts 가 별도 검증한다.
    const sandbox = await prisma.sandbox.findUnique({ where: { postId }, select: { meta: true } });
    expect(JSON.parse(sandbox!.meta!).concurrentTurns).toBe(true);
    expect(await metaConcurrent(postId)).toBe(true);
  });

  it('concurrent omitted → meta.concurrentTurns === false', async () => {
    const postId = await createPost({});
    expect(await metaConcurrent(postId)).toBe(false);
  });

  it('concurrent:false → meta.concurrentTurns === false', async () => {
    const postId = await createPost({ concurrent: false });
    expect(await metaConcurrent(postId)).toBe(false);
  });

  it('concurrent non-boolean ("yes") / null → false (계약: 정확히 true 일 때만 true)', async () => {
    const postId1 = await createPost({ concurrent: 'yes' });
    expect(await metaConcurrent(postId1)).toBe(false);
    const postId2 = await createPost({ concurrent: null });
    expect(await metaConcurrent(postId2)).toBe(false);
  });
});
