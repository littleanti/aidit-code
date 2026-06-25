// backend/src/sandbox/limits.ts
// M7 XC-ISO — best-effort 격리 하드닝(PoC, TRD §8 isolation: path+resource+network).
//
//   (a) 도구 실행 벽시계 TIMEOUT — SHELL/PACKAGE 자식이 config.isolation.toolTimeoutMs 를
//       초과하면 kill(SIGTERM→SIGKILL) 하고 ToolCall 을 FAILED 'timeout' 으로 마감한다.
//       toolExec.ts 의 runShell 이 이 헬퍼를 사용한다.
//   (b) per-sandbox child-process cap — sandboxId 별 동시 실행 자식 수를 카운트해
//       config.isolation.maxProcsPerSandbox 를 넘는 신규 실행을 거부한다(best-effort).
//   (c) network policy 플래그 — config.isolation.networkPolicy('restricted'|'open')를
//       샌드박스 meta 에 기록만 한다. 실제 네트워크 강제는 본 PoC 범위 밖이다(정직히 문서화).
//
//   ※ 이식성 한계(정직한 문서화): cgroup/메모리/CPU 쿼터는 Windows 에서 이식 불가하므로
//     본 모듈에서 흉내내지 않는다(가짜 제한 금지). 향후 Linux 컨테이너 런타임에서 cgroup v2 로
//     보강 예정 — 현재는 deferred. 네트워크 격리도 동일하게 deferred(플래그만 기록).
//
// 보안(CLAUDE.md/TRD §8): 이 모듈은 PID/카운터/정책 플래그만 다루며 LLM 키를 절대 참조/출력하지 않는다.

import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';

/**
 * child 와 그 자식 트리를 강제 종료한다(플랫폼별).
 *   - Windows: `taskkill /pid <pid> /T /F` — cmd 셸과 그 하위(ping 등)를 함께 죽인다.
 *     (child.kill 은 셸만 신호하고 하위 프로세스는 남는다.)
 *   - POSIX: child.kill(signal) — sh -c 자식. 프로세스 그룹 전체 종료는 PoC 범위 밖.
 * 멱등/안전: 이미 죽었거나 PID 없으면 noop.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid != null) {
    try {
      // /F 강제, /T 트리. 별도 detached 프로세스로 실행해 자신을 블로킹하지 않는다.
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      tk.on('error', () => {
        /* taskkill 부재 등 — 최선 노력. */
      });
      tk.unref?.();
    } catch {
      /* noop */
    }
    return;
  }
  try {
    child.kill(signal);
  } catch {
    /* noop */
  }
}

/** 도구 타임아웃 결과 문구(이벤트/행에 남는 일반 문구 — 민감정보 아님). */
export const TOOL_TIMEOUT_RESULT = 'timeout';

/** per-sandbox 동시 자식 상한 초과 시 사용하는 결과 문구. */
export const PROC_CAP_RESULT = 'process cap exceeded';

/**
 * (c) 네트워크 정책 플래그를 읽는다. 'restricted' | 'open'.
 * meta 기록 전용 — 실제 강제는 범위 밖(deferred).
 */
export function networkPolicy(): 'restricted' | 'open' {
  return config.isolation.networkPolicy;
}

// ── (b) per-sandbox child-process cap ──────────────────────────────────────
// sandboxId → 현재 실행 중 도구 자식 수. best-effort 인메모리 카운터(단일 인스턴스).
const procCounts = new Map<string, number>();

/**
 * sandboxId 에 새 자식 실행 슬롯을 시도 획득한다. 상한 미만이면 점유하고 true,
 * 초과면 false(호출부가 거부). max < 1 또는 sandboxId 없음이면 캡을 적용하지 않는다(통과).
 */
export function tryAcquireProc(sandboxId?: string): boolean {
  const max = config.isolation.maxProcsPerSandbox;
  if (!sandboxId || !Number.isInteger(max) || max < 1) return true;
  const cur = procCounts.get(sandboxId) ?? 0;
  if (cur >= max) return false;
  procCounts.set(sandboxId, cur + 1);
  return true;
}

/** sandboxId 의 자식 실행 슬롯을 반납한다. 0 미만으로 내려가지 않는다. */
export function releaseProc(sandboxId?: string): void {
  if (!sandboxId) return;
  const cur = procCounts.get(sandboxId) ?? 0;
  if (cur <= 1) procCounts.delete(sandboxId);
  else procCounts.set(sandboxId, cur - 1);
}

/** 진단/테스트용: 현재 sandboxId 점유 자식 수. */
export function procCount(sandboxId: string): number {
  return procCounts.get(sandboxId) ?? 0;
}

// ── (a) 도구 실행 벽시계 타임아웃 ──────────────────────────────────────────

/** 타임아웃 가드 핸들. clear() 로 정상 종료 시 타이머를 해제한다. */
export interface TimeoutGuard {
  /** 타임아웃이 발생해 자식을 kill 했는지. */
  readonly timedOut: () => boolean;
  /** 정상 종료 시 호출 — 타이머 해제(중복 호출 안전). */
  clear: () => void;
}

/**
 * child 에 벽시계 타임아웃을 건다. ms 초과 시 SIGTERM, 잠시 후에도 살아있으면 SIGKILL.
 * onTimeout 콜백으로 호출부가 결과 문구를 'timeout' 으로 마감하도록 알린다.
 * ms<=0 이면 가드를 적용하지 않는다(no-op clear).
 */
export function attachToolTimeout(
  child: ChildProcess,
  ms: number,
  onTimeout: () => void,
): TimeoutGuard {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { timedOut: () => false, clear: () => {} };
  }
  let firedTimeout = false;
  let cleared = false;

  const killTimer = setTimeout(() => {
    firedTimeout = true;
    // 셸 서브트리까지 함께 종료(Windows=taskkill /T, POSIX=SIGTERM).
    killTree(child, 'SIGTERM');
    // 그래도 살아있으면(완강한 자식) 강제 종료.
    setTimeout(() => {
      if (!child.killed) killTree(child, 'SIGKILL');
    }, 1_500).unref?.();
    onTimeout();
  }, ms);
  killTimer.unref?.();

  return {
    timedOut: () => firedTimeout,
    clear: () => {
      if (cleared) return;
      cleared = true;
      clearTimeout(killTimer);
    },
  };
}
