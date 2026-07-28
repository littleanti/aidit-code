// backend/src/agent/sandboxLock.ts
// XC-SERIAL(M8) + XC-SCOPE(2026-07-28) — 부수효과 직렬 lock.
//
// 목적: 여러 턴이 동시 inflight 되어도 **충돌하는** 부수효과는 한 번에 하나만 진행되게 해
//   동시 파일 쓰기 진입을 0으로 만든다(충돌·머지 불필요).
//
// XC-SCOPE 로 무엇이 바뀌었나:
//   v2 최초 구현은 **샌드박스 단위 단일 mutex** 였다. 안전하지만, 서로 **다른 파일**을 만지는 턴도
//   줄을 세웠다. E2-B 실측에서 두 동시 턴이 모두 파일을 수정하면 병렬 이점이 1.07× 로 붕괴하는 것이
//   확인돼(EXPERIMENTS §E2-B), 직렬 경계를 "샌드박스"에서 "**충돌 단위**"로 좁혔다.
//
//   핵심 제약: SHELL/PACKAGE 는 **어떤 파일을 만질지 알 수 없다**(파이프·변수전개·서브셸). 그래서
//   파일 단위로 좁힐 수 없고 샌드박스 전체 배타여야 한다. 결과적으로 단순 mutex 가 아니라
//   아래 호환성 행렬을 만족하는 **계층 락**이 된다:
//
//     FILE_WRITE/READ(경로 P) ↔ FILE_WRITE/READ(경로 Q≠P) : 병렬  ← 이번 이득
//     FILE_WRITE/READ(P)      ↔ FILE_WRITE/READ(P)        : 직렬
//     그 외 모든 조합(SHELL/PACKAGE/FILE_DELETE/미지 kind) : 직렬(배타)
//
//   FILE_DELETE 를 배타로 둔 이유: 삭제는 디렉토리를 지울 수 있어 `rm -r src/` 와 `write src/x.py` 가
//   경로 키가 달라 병렬 진입하면 ENOENT 레이스가 **새로** 생긴다. 삭제는 드물어 배타 비용이 거의
//   없으므로, 새 레이스 클래스를 만들지 않는 쪽을 택했다.
//
// 공정성: 샌드박스별 **엄격 FIFO**(추월 금지). 큐 머리가 막히면 뒤도 대기한다 — 파일 작업이 계속
//   들어와도 SHELL 이 굶지 않는다(starvation 방지). 동시성을 조금 포기하고 공정성을 택했다.
//
// 하위호환: 기존 `withSandboxLock(key, fn)` 은 `{ mode: 'exclusive' }` 별칭이다. 모든 호출이
//   배타면 큐는 완전 직렬로 동작해 이전 구현과 의미가 같다(기존 테스트 무수정 통과).
//
// 보안/불변식: 키/시크릿을 다루지 않는다(순수 동시성 프리미티브). 경로는 락 키로만 쓰고
//   파일시스템에 접근하지 않는다.

import path from 'node:path';

/** 락 범위. exclusive = 샌드박스 전체 배타, path = 그 경로만 배타(다른 경로와 병렬). */
export type LockScope = { mode: 'exclusive' } | { mode: 'path'; path: string };

interface Waiter {
  scope: LockScope;
  /** 입장 게이트 resolver. pump 가 호출하면 대기 중인 작업이 시작된다. */
  start: () => void;
}

interface LockState {
  /** 현재 실행 중인 작업들(병렬 가능하므로 배열). */
  running: Waiter[];
  /** 대기열(엄격 FIFO). */
  queue: Waiter[];
}

const states = new Map<string, LockState>();

/**
 * 경로를 락 키로 정규화한다.
 *   - `path.normalize` 로 `./`·중복 구분자 정리
 *   - 구분자를 `/` 로 통일(같은 파일이 다른 키가 되지 않도록)
 *   - win32 는 소문자화 — 대소문자 무구분 FS 라 `A.txt`/`a.txt` 는 **같은 파일**이므로 같은 키여야 한다
 * 경로 탈출 검사는 하지 않는다(그건 pathGuard 책임). 여기서는 키 동일성만 본다.
 */
export function normalizeLockPath(relPath: string): string {
  const unified = path.normalize(relPath).replace(/\\/g, '/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/** w 가 현재 실행 중인 작업들과 동시에 돌 수 있는가. */
function compatible(w: Waiter, running: Waiter[]): boolean {
  if (w.scope.mode === 'exclusive') return running.length === 0;
  // path 모드: 실행 중인 것이 모두 path 모드이고 경로가 서로 달라야 한다.
  return running.every((r) => r.scope.mode === 'path' && r.scope.path !== (w.scope as { path: string }).path);
}

/**
 * 큐 머리에서 호환되는 동안 입장시킨다(엄격 FIFO — 막히면 중단).
 * 머리를 추월시키지 않는 것이 starvation 방지의 핵심이다.
 */
function pump(key: string): void {
  const st = states.get(key);
  if (!st) return;
  while (st.queue.length > 0) {
    const head = st.queue[0];
    if (!compatible(head, st.running)) break;
    st.queue.shift();
    st.running.push(head);
    head.start();
  }
  if (st.running.length === 0 && st.queue.length === 0) states.delete(key);
}

/**
 * scope 가 충돌하는 작업만 직렬화한다(키별 독립). 반환 promise 는 fn 의 결과를 그대로 전달한다.
 * - fn 은 호환되지 않는 선행 작업이 모두 정착한 뒤에만 시작된다.
 * - fn 이 throw/reject 해도 다음 대기자는 정상 진행된다(직렬성 보존).
 * - 해당 key 의 모든 작업이 끝나면 맵에서 정리한다(메모리 누수 방지).
 */
export function withScopedSandboxLock<T>(
  key: string,
  scope: LockScope,
  fn: () => Promise<T>,
): Promise<T> {
  let st = states.get(key);
  if (!st) {
    st = { running: [], queue: [] };
    states.set(key, st);
  }

  let start!: () => void;
  const gate = new Promise<void>((resolve) => {
    start = resolve;
  });
  const waiter: Waiter = { scope, start };
  st.queue.push(waiter);
  pump(key);

  return gate.then(async () => {
    try {
      return await fn();
    } finally {
      // 실행 집합에서 자신을 제거하고 다음 대기자를 진행시킨다(성공/실패 무관).
      const cur = states.get(key);
      if (cur) {
        const i = cur.running.indexOf(waiter);
        if (i >= 0) cur.running.splice(i, 1);
      }
      pump(key);
    }
  });
}

/**
 * 하위호환 별칭 — 샌드박스 전체 배타. 기존 호출부/테스트의 의미를 그대로 보존한다
 * (모든 작업이 배타면 큐는 완전 직렬로 동작 = 이전 promise-chain mutex 와 동치).
 */
export function withSandboxLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withScopedSandboxLock(key, { mode: 'exclusive' }, fn);
}

/** 테스트/진단용: 현재 대기/실행 체인이 걸려있는 키 수(0 이면 모두 정리됨). */
export function activeSandboxLockKeys(): number {
  return states.size;
}

/** 테스트/진단용: 특정 키의 현재 실행 중 작업 수(병렬도 관측). */
export function runningCount(key: string): number {
  return states.get(key)?.running.length ?? 0;
}
