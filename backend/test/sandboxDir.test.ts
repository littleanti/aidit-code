// backend/test/sandboxDir.test.ts
// resolveSandboxDir 단위 검증(2026-06-26 절대경로 박제 사고 회귀 방지).
//   - Sandbox.path 에 박제된 절대경로가 레포 이동/이름변경으로 깨져도, 표준 위치
//     (sandboxRoot/postId)가 실재하면 그쪽으로 self-heal 해야 한다.
//   - 루트 밖 외부/테스트 디렉토리(표준 위치 없음)는 저장 path 를 그대로 보존해야 한다.
//
// 순수 함수 + 파일시스템만 사용(DB 불필요). config.sandboxRoot 기준으로 임시 디렉토리를 만든다.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { resolveSandboxDir } from '../src/sandbox/service.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('resolveSandboxDir', () => {
  it('현재 루트 안의 저장 path 는 그대로 신뢰한다', () => {
    const postId = `pg-inroot-${Date.now()}`;
    const dir = path.join(config.sandboxRoot, postId);
    mkdirSync(dir, { recursive: true });
    cleanup.push(dir);

    expect(resolveSandboxDir({ postId, path: dir })).toBe(dir);
  });

  it('박제된 옛 루트 경로(루트 밖)라도 표준 위치가 실재하면 self-heal 한다', () => {
    const postId = `pg-heal-${Date.now()}`;
    const canonical = path.join(config.sandboxRoot, postId);
    mkdirSync(canonical, { recursive: true });
    cleanup.push(canonical);

    // 레포가 Audit-Code → Aidit-Code 로 바뀐 상황을 모사: 존재하지 않는 옛 루트 절대경로.
    const stale = path.join('Z:', 'gone', 'Audit-Code', '.sandboxes', postId);
    expect(existsSync(stale)).toBe(false);

    expect(resolveSandboxDir({ postId, path: stale })).toBe(canonical);
  });

  it('루트 밖 외부 디렉토리는 표준 위치가 없으면 저장 path 를 보존한다(테스트 샌드박스)', () => {
    const external = mkdtempSync(path.join(tmpdir(), 'sbxdir-ext-'));
    cleanup.push(external);
    // 표준 위치가 만들어지지 않은 임의 postId — canonical 미존재.
    const postId = `pg-ext-${Date.now()}`;
    expect(existsSync(path.join(config.sandboxRoot, postId))).toBe(false);

    expect(resolveSandboxDir({ postId, path: external })).toBe(external);
  });
});
