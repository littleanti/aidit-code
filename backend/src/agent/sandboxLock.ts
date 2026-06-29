// backend/src/agent/sandboxLock.ts
// XC-SERIAL(M8) — 샌드박스 단위 부수효과 직렬 lock.
//
// 목적: AR-PAR 이후 여러 턴이 동시 inflight 되어도, 도구 실행(파일 쓰기/쉘/컨텍스트 커밋)은
//   샌드박스 단위로 "한 번에 하나"만 진행되게 직렬화한다 → 동시 파일 쓰기 진입 0(충돌·머지 불필요).
//   현재(단일 활성 턴)에는 경합이 없어 동작 불변(no-op) — AR-PAR 도입을 위한 seam을 미리 깐다.
//
// 구현: sandboxId(또는 임의 키)별 promise-chain mutex. withSandboxLock(key, fn) 은 직전 작업이
//   "정착(성공/실패)"한 뒤에야 fn 을 실행하고, fn 의 성공/실패와 무관하게 다음 대기자를 진행시킨다
//   (한 작업의 reject 가 체인을 끊지 않도록 tail 은 항상 swallow). 키별로 독립적이다.
//
// 보안/불변식: 키/시크릿을 다루지 않는다(순수 동시성 프리미티브).

/** 키별 직렬 체인의 꼬리(tail). 이 promise 는 절대 reject 되지 않는다(아래 swallow). */
const tails = new Map<string, Promise<unknown>>();

/**
 * 같은 key 의 작업을 직렬화한다(키별 독립). 반환 promise 는 fn 의 결과(성공/실패)를 그대로 전달한다.
 * - fn 은 직전 작업이 끝난 뒤에만 시작된다(겹침 없음).
 * - fn 이 throw/reject 해도 다음 대기자는 정상 진행된다(직렬성 보존).
 * - 해당 key 의 마지막 작업이 끝나면 맵에서 정리한다(메모리 누수 방지).
 */
export function withSandboxLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // 직전 tail 은 non-rejecting 이므로 then 한 갈래로 충분하다(없으면 즉시 시작).
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  // 다음 대기자가 이 작업의 reject 에 영향받지 않도록 tail 은 성공/실패 모두 흡수한다.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  // 정확히 이 tail 이 마지막일 때만 정리(이후 들어온 작업의 tail 을 지우지 않도록).
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/** 테스트/진단용: 현재 대기 체인이 걸려있는 키 수(0 이면 모두 정리됨). */
export function activeSandboxLockKeys(): number {
  return tails.size;
}
