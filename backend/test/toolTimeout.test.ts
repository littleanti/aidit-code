// backend/test/toolTimeout.test.ts
// M7 XC-ISO 검증: SHELL 도구가 벽시계 타임아웃을 초과하면 child 가 kill 되고
//   ToolExecResult 가 FAILED + result 'timeout' 으로 마감된다.
//   - 짧은 timeoutMs(예: 300ms)를 주고, 그보다 오래 도는 명령을 실행한다.
//   - 결과가 적시(타임아웃 + 약간의 여유) 안에 FAILED 'timeout' 으로 떨어지는지 확인.
//   - 정상(짧은) 명령은 타임아웃에 걸리지 않고 SUCCEEDED 인지(회귀) 확인.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeTool, killAllToolChildren } from '../src/agent/toolExec.js';
import { TOOL_TIMEOUT_RESULT } from '../src/sandbox/limits.js';

afterEach(() => {
  killAllToolChildren();
});

const isWin = process.platform === 'win32';
// 약 3초 자는 명령(플랫폼별). timeoutMs(150ms) 보다 훨씬 길어 타임아웃-킬 효과가 또렷하면서도
// (킬 실패 시에도) 잔여 프로세스 수명이 짧아 다른 스위트에 부하를 거의 주지 않는다.
//   Windows: ping -n N 는 약 (N-1)초. N=4 → ~3s.
const SLEEP_LONG = isWin ? 'ping -n 4 127.0.0.1 > NUL' : 'sleep 3';
const SLEEP_NONE = 'echo hi';

async function makeRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'tt-'));
}

describe('M7 tool wall-clock timeout', () => {
  it('kills a SHELL child exceeding timeoutMs and returns FAILED "timeout"', async () => {
    const root = await makeRoot();
    const start = Date.now();
    const result = await executeTool(
      root,
      { kind: 'SHELL', name: 'bash', command: SLEEP_LONG },
      () => {},
      undefined,
      { timeoutMs: 150, sandboxId: root },
    );
    const elapsed = Date.now() - start;

    expect(result.status).toBe('FAILED');
    expect(result.result).toBe(TOOL_TIMEOUT_RESULT);
    // 타임아웃(150ms) 직후 트리킬(taskkill /T)로 마감되어야 한다 — 3s 명령 전체를 끌지 않는다.
    // taskkill 스폰/킬 지연 여유를 감안해도 명령 자연종료(3s) 보다 또렷이 빠르다.
    expect(elapsed).toBeLessThan(2500);
  });

  it('does NOT time out a fast command (regression: SUCCEEDED)', async () => {
    const root = await makeRoot();
    const result = await executeTool(
      root,
      { kind: 'SHELL', name: 'bash', command: SLEEP_NONE },
      () => {},
      undefined,
      { timeoutMs: 5000, sandboxId: root },
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(result.exitCode).toBe(0);
  });
});
