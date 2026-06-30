// backend/src/sandbox/provision.ts
// 샌드박스 프로비저닝(BE-PROV). POST /posts 응답 이후 fire-and-forget 로 비동기 실행된다.
//   단계:
//     1. 디렉토리 보장(mkdir -p) — createSandboxForPost 에서 이미 만들지만 멱등 안전망.
//     2. 런타임 meta 마커(JSON) 를 Sandbox.meta 에 기록.
//     3. CREATING → READY 전이(setSandboxStatus → 'sandbox.status' publish).
//   실패 시: ERROR 전이(publish). 슬롯은 항상 finally 에서 반납한다.
//
//   PoC 범위: 실제 pi 런타임 스폰 없음. READY = "디렉토리 + meta 준비 완료"(유휴).
//   실제 에이전트 세션 spawn 은 M3(BE-SESS).
//
//   동시성: 호출부(POST /posts)가 tryAcquire 로 슬롯을 선점하고 provisionSandbox 에 위임하는 것을 권장한다.
//   acquireSlot 를 직접 잡지 않은 경우(테스트 등)에는 옵션으로 limiter 점유 없이도 돌 수 있게 한다.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sandbox } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { setSandboxStatus, sandboxLimiter, getSandboxConcurrent } from './service.js';

const META_FILENAME = '.sandbox-meta.json';

/** 런타임 meta 마커 형태. LLM 키는 절대 포함하지 않는다(TRD §8). */
interface SandboxMeta {
  runtime: string;
  provisionedAt: string;
  /**
   * 리소스/네트워크 정책(M7 XC-ISO). network 플래그는 config.isolation 에서 기록.
   * ※ 정직한 범위: network 강제는 본 PoC 범위 밖(플래그 기록만). maxProcs 는 best-effort cap.
   */
  policy: { network: 'restricted' | 'open'; maxProcs: number };
  /**
   * (v2 XC-MODE) 동시 병렬 협업 opt-in 플래그. createSandboxForPost 가 생성 시 meta 에 기록한 값을
   * 프로비저닝이 meta 를 다시 쓸 때 **보존**한다(덮어쓰면 안 됨 — 그렇지 않으면 READY 후 항상 false 가 됨).
   */
  concurrentTurns: boolean;
}

export interface ProvisionOptions {
  /**
   * 이미 호출부에서 limiter 슬롯을 잡은 경우 false 로 두면 provision 종료 시 release 만 한다.
   * 기본값 false: 슬롯 소유권은 호출부(POST /posts)에 있고, 여기서는 finally 에서 release 만 수행한다.
   * acquireSlot=true 면 이 함수가 직접 acquire/release 한다(독립 호출/테스트용).
   */
  acquireSlot?: boolean;
  /** 슬롯 반납을 이 함수가 책임지는지. 기본 true. */
  releaseSlot?: boolean;
}

/**
 * 샌드박스를 READY 까지 프로비저닝한다(비동기, 응답 블로킹 금지).
 * 어떤 경로로 실패하든 throw 하지 않고 ERROR 로 전이한 뒤 슬롯을 반납한다(fire-and-forget 안전).
 */
export async function provisionSandbox(
  sandbox: Pick<Sandbox, 'id' | 'path' | 'postId' | 'runtime' | 'meta'>,
  options: ProvisionOptions = {},
): Promise<void> {
  const { acquireSlot = false, releaseSlot = true } = options;

  if (acquireSlot) sandboxLimiter.acquire();

  try {
    // 1. 디렉토리 보장(멱등).
    await mkdir(sandbox.path, { recursive: true });

    // 2. 런타임 meta 마커 기록(파일 + DB.meta 필드 양쪽).
    //    XC-MODE: createSandboxForPost 가 기록한 concurrentTurns opt-in 플래그를 보존한다
    //    (이 update 가 meta 를 통째로 다시 쓰므로, 안 옮기면 READY 후 플래그가 사라진다).
    //    호출부가 넘긴 sandbox 행에 meta 가 이미 있으므로 추가 DB 조회 없이 그대로 읽는다.
    const concurrentTurns = getSandboxConcurrent(sandbox);
    const meta: SandboxMeta = {
      runtime: sandbox.runtime,
      provisionedAt: new Date().toISOString(),
      policy: {
        network: config.isolation.networkPolicy,
        maxProcs: config.isolation.maxProcsPerSandbox,
      },
      concurrentTurns,
    };
    const metaJson = JSON.stringify(meta);
    await writeFile(path.join(sandbox.path, META_FILENAME), metaJson, 'utf8');
    await prisma.sandbox.update({
      where: { id: sandbox.id },
      data: { meta: metaJson },
    });

    // 3. CREATING → READY (publishes sandbox.status).
    await setSandboxStatus(sandbox.id, 'READY');
  } catch {
    // 실패 시 ERROR 전이(publish). 전이 자체가 또 실패해도 fire-and-forget 이므로 삼킨다.
    try {
      await setSandboxStatus(sandbox.id, 'ERROR');
    } catch {
      // 최종 방어선: 더 이상 할 수 있는 일 없음.
    }
  } finally {
    if (releaseSlot) sandboxLimiter.release();
  }
}
