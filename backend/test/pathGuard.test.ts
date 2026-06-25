// backend/test/pathGuard.test.ts
// BE-ISO 검증: '..' 트래버설 · 절대경로 주입 · symlink 탈출은 거부, 정상 중첩 상대경로는 허용.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveInsideRoot,
  isInsideRoot,
  PathEscapeError,
} from '../src/sandbox/pathGuard.js';

describe('pathGuard.resolveInsideRoot', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    const base = mkdtempSync(path.join(tmpdir(), 'aidit-pg-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  afterAll(() => {
    // base 디렉토리(root 의 부모) 정리.
    rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('accepts a normal nested relative path', () => {
    const resolved = resolveInsideRoot(root, 'sub/dir/file.txt');
    expect(resolved).toBe(path.resolve(root, 'sub/dir/file.txt'));
    expect(isInsideRoot(root, resolved)).toBe(true);
  });

  it('rejects ".." traversal that escapes root', () => {
    expect(() => resolveInsideRoot(root, '../outside/evil.txt')).toThrow(PathEscapeError);
    expect(() => resolveInsideRoot(root, 'a/../../escape')).toThrow(PathEscapeError);
  });

  it('rejects absolute path injection', () => {
    const abs = process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc/passwd';
    expect(() => resolveInsideRoot(root, abs)).toThrow(PathEscapeError);
  });

  it('rejects a symlink that escapes root', () => {
    // root 안에 root 밖(outside)을 가리키는 심링크를 만들고, 그 너머를 해석하려 하면 거부되어야 한다.
    const linkName = 'escape-link';
    const linkPath = path.join(root, linkName);
    try {
      symlinkSync(outside, linkPath, 'dir');
    } catch {
      // 심링크 생성 권한이 없는 환경(예: 일부 Windows)에서는 이 케이스를 스킵.
      return;
    }
    // escape-link -> outside 이므로 escape-link/secret.txt 의 realpath 는 root 밖.
    expect(() => resolveInsideRoot(root, path.join(linkName, 'secret.txt'))).toThrow(
      PathEscapeError,
    );
  });

  it('treats the root itself as inside', () => {
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it('does not confuse a sibling with a shared prefix', () => {
    // /base/root vs /base/root-evil 경계 오탐 방지.
    const sibling = root + '-evil';
    mkdirSync(sibling, { recursive: true });
    expect(isInsideRoot(root, sibling)).toBe(false);
  });
});
