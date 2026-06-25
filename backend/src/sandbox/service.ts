// backend/src/sandbox/service.ts
// 샌드박스 서비스(M1 범위 = "row + 1:1 훅" 만).
//   createSandboxForPost(postId):
//     - config.sandboxRoot/<postId> 경로 계산 + 디렉토리 생성(mkdir -p).
//     - Sandbox 행 생성(status=CREATING, runtime="pi", path=절대경로).
//   ※ M1 에서는 에이전트 스폰/READY 전이를 하지 않는다(전체 프로비저닝 라이프사이클은 M2).

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Sandbox } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';

/**
 * 게시글에 1:1 샌드박스를 생성한다(M1: 행 + 디렉토리 only).
 * @returns 생성된 Sandbox 행.
 */
export async function createSandboxForPost(postId: string): Promise<Sandbox> {
  const sandboxPath = path.join(config.sandboxRoot, postId);

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
