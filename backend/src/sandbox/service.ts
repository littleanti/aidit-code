// backend/src/sandbox/service.ts
// 샌드박스 서비스.
//   createSandboxForPost(postId):
//     - pathGuard.resolveInsideRoot(config.sandboxRoot, postId) 로 경로 계산(루트 탈출 불가) + mkdir -p.
//     - Sandbox 행 생성(status=CREATING, runtime="pi", path=절대경로).
//   setSandboxStatus(sandboxId, status):
//     - 행 상태 + lastActiveAt 갱신 후 'sandbox.status' 이벤트를 post 채널로 publish(M2: RT-PS+RT-SBXEV 배선).
//   ※ READY 전이/디렉토리·meta 준비는 provision.ts(BE-PROV)가 담당. 에이전트 스폰은 M3.

import { mkdir, rm } from 'node:fs/promises';
import type { Sandbox } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { resolveInsideRoot, isInsideRoot } from './pathGuard.js';
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

/**
 * 샌드박스 격리 디렉토리를 영구 삭제한다(글 삭제 cleanup, sandboxLifecycle §6.1 step7).
 * 안전장치: 경로가 sandboxRoot 내부임을 isInsideRoot 로 확인한 뒤에만 삭제한다.
 * 루트 밖(또는 루트 자체) 경로는 거부하여 호스트 파일시스템 손상을 차단한다.
 * 디렉토리가 이미 없으면 무해(force).
 */
export async function deleteSandboxDir(sandboxPath: string): Promise<void> {
  // 루트 자체나 루트 밖 경로는 절대 지우지 않는다.
  if (sandboxPath === config.sandboxRoot || !isInsideRoot(config.sandboxRoot, sandboxPath)) {
    throw Object.assign(new Error('refusing to delete path outside sandbox root'), {
      statusCode: 400,
    });
  }
  await rm(sandboxPath, { recursive: true, force: true });
}
