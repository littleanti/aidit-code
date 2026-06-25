// backend/src/sandbox/pathGuard.ts
// 경로 탈출 차단 가드(TRD §8 임의 코드 격리 ①). 순수 함수로, 파일 API(M6)·도구 실행(M5) 공용.
//
// 위협 모델:
//   1. '..' 트래버설        — root/../etc 로 루트 밖 접근
//   2. 절대경로 주입        — '/etc/passwd' 또는 'C:\Windows' 처럼 root 를 무시한 절대경로
//   3. symlink 탈출         — root 안에 root 밖을 가리키는 심볼릭 링크를 만들어 우회
//
// 차단 전략:
//   - 후보 경로를 root 기준으로 resolve 한 뒤, 정규화된 절대경로가 root 로 시작하는지 검사한다.
//   - symlink 우회는 path 문자열 검사만으로 막을 수 없으므로 realpath(실제 inode 경로)로 검증한다.
//
// symlink 동작(중요):
//   - resolveInsideRoot 는 "최종 해석 경로의 realpath 가 root 의 realpath 안에 있는가" 를 본다.
//   - 대상이 아직 존재하지 않을 수 있으므로(파일 생성 전 경로 검증), 존재하는 가장 가까운 조상까지
//     realpath 로 풀고, 나머지 비존재 구간은 문자열 정규화로 이어붙인 뒤 다시 검사한다.
//   - 따라서: root 안의 심링크가 root 밖을 가리키면 그 조상 realpath 가 root 밖으로 빠지므로 거부된다.
//   - 비존재 경로 자체는 거부 사유가 아니다(생성 의도 허용). 오직 "root 이탈" 만 거부한다.

import path from 'node:path';
import { realpathSync } from 'node:fs';

/** 경로가 root 를 이탈했을 때 던지는 타입드 에러. 호출부는 instanceof 로 분기/403 처리. */
export class PathEscapeError extends Error {
  constructor(
    message: string,
    /** 검증을 시도한 (정규화 전) 입력 경로. 로깅용 — 민감정보 아님. */
    public readonly attempted: string,
  ) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/**
 * 존재하는 가장 가까운 조상을 realpath 로 풀고, 비존재 꼬리는 문자열로 이어붙여
 * "실제 inode 기준" 절대경로를 만든다. (symlink 탈출 검출의 핵심)
 */
function realResolve(absPath: string): string {
  let current = path.resolve(absPath);
  const tail: string[] = [];
  // 존재하는 조상에 도달할 때까지 위로 올라간다.
  // (루트까지 올라가면 realpathSync 는 디스크 루트를 돌려준다.)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // 디스크 루트조차 realpath 불가 — 정규화 절대경로로 폴백.
        return path.resolve(absPath);
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * candidate(이미 절대경로일 수 있음)가 root 내부에 있는지 realpath 기준으로 판정.
 * 경계 자체(candidate === root)도 내부로 본다.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const realRoot = realResolve(root);
  const realCandidate = realResolve(candidate);
  if (realCandidate === realRoot) return true;
  // 경계 오탐 방지를 위해 구분자를 붙여 prefix 검사(/root vs /root-evil).
  const withSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realCandidate.startsWith(withSep);
}

/**
 * relPath 를 root 기준으로 해석한다. root 를 벗어나지 않을 때만 절대 해석 경로를 반환하고,
 * '..' 트래버설·절대경로 주입·symlink 탈출은 PathEscapeError 로 거부한다.
 *
 * @param root    격리 루트(호스트 절대경로). 보통 config.sandboxRoot 또는 sandbox.path.
 * @param relPath 루트 상대 경로. 절대경로가 들어오면(주입) 거부된다.
 * @returns       root 안에 안전하게 위치한 절대경로.
 * @throws        PathEscapeError — root 이탈 시.
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  // 절대경로 주입 차단: 루트 상대만 허용한다.
  if (path.isAbsolute(relPath)) {
    throw new PathEscapeError(
      `absolute path injection is not allowed: ${relPath}`,
      relPath,
    );
  }

  const absRoot = path.resolve(root);
  // 문자열 정규화 단계의 1차 해석(여기서 '..' 가 root 밖으로 빠지면 잡힌다).
  const resolved = path.resolve(absRoot, relPath);

  // realpath(symlink 포함) 기준 2차 검증.
  if (!isInsideRoot(absRoot, resolved)) {
    throw new PathEscapeError(
      `path escapes sandbox root: ${relPath}`,
      relPath,
    );
  }

  return resolved;
}
