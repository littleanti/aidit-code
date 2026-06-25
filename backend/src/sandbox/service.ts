// backend/src/sandbox/service.ts
// 샌드박스 서비스.
//   createSandboxForPost(postId):
//     - pathGuard.resolveInsideRoot(config.sandboxRoot, postId) 로 경로 계산(루트 탈출 불가) + mkdir -p.
//     - Sandbox 행 생성(status=CREATING, runtime="pi", path=절대경로).
//   setSandboxStatus(sandboxId, status):
//     - 행 상태 + lastActiveAt 갱신 후 'sandbox.status' 이벤트를 post 채널로 publish(M2: RT-PS+RT-SBXEV 배선).
//   ※ READY 전이/디렉토리·meta 준비는 provision.ts(BE-PROV)가 담당. 에이전트 스폰은 M3.

import { mkdir } from 'node:fs/promises';
import type { Sandbox } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { resolveInsideRoot } from './pathGuard.js';
import { ConcurrencyLimiter } from './limiter.js';
import { publishToPost } from '../realtime/publish.js';
import { makeSandboxStatusEvent, type SandboxStatusValue } from '../realtime/events.js';

/**
 * 프로비저닝/활성 실행 동시성 제한 싱글턴(TRD §8).
 * POST /posts(신규 provision)와 provision.ts 가 공유한다.
 */
export const sandboxLimiter = new ConcurrencyLimiter(config.sandboxMaxConcurrent);

/**
 * 게시글에 1:1 샌드박스를 생성한다(행 + 격리 디렉토리, status=CREATING).
 * 경로는 resolveInsideRoot 로 계산되어 절대 sandboxRoot 를 벗어날 수 없다.
 * @returns 생성된 Sandbox 행.
 */
export async function createSandboxForPost(postId: string): Promise<Sandbox> {
  // postId 를 루트 상대 세그먼트로 해석. cuid 라 '..'/구분자 없지만 가드를 통해 경계를 강제한다.
  const sandboxPath = resolveInsideRoot(config.sandboxRoot, postId);

  // 격리 디렉토리 준비(존재 시 무해). recursive 로 루트까지 보장.
  await mkdir(sandboxPath, { recursive: true });

  const sandbox = await prisma.sandbox.create({
    data: {
      postId,
      path: sandboxPath,
      status: 'CREATING',
      runtime: 'pi',
    },
  });

  return sandbox;
}

/**
 * 샌드박스 상태를 전이한다: 행 상태 + lastActiveAt 갱신 후 'sandbox.status' 이벤트 publish.
 * publish 는 SoT(DB) 갱신 뒤에 일어나며, 이벤트 payload 에 LLM 키는 절대 포함하지 않는다(TRD §8).
 * @returns 갱신된 Sandbox 행.
 */
export async function setSandboxStatus(
  sandboxId: string,
  status: SandboxStatusValue,
): Promise<Sandbox> {
  const updated = await prisma.sandbox.update({
    where: { id: sandboxId },
    data: { status, lastActiveAt: new Date() },
  });

  publishToPost(
    updated.postId,
    makeSandboxStatusEvent({
      sandboxId: updated.id,
      status: updated.status as SandboxStatusValue,
      lastActiveAt: updated.lastActiveAt,
    }),
  );

  return updated;
}
