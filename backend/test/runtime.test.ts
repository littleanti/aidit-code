// backend/test/runtime.test.ts
// AR-PI 검증:
//   - spawn 은 숫자 pid 를 반환하고 자식 프로세스가 실제로 살아있다.
//   - suspend 는 프로세스를 죽인다(pid 가 더 이상 실행되지 않음).
//   - 주입 env 에는 model/baseURL 이 들어가지만, adapter 가 로그할 스냅샷에는 apiKey 평문이 없다.
//
// 스폰된 자식은 afterEach 에서 항상 정리(누수 방지).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { piRuntime, describeSpawn, redactSpawnEnv } from '../src/agent/pi.js';
import { getLlmRuntimeConfig } from '../src/agent/config.js';

/** pid 가 살아있는지(시그널 0 으로 검사). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const spawnedSandboxIds: string[] = [];

afterEach(async () => {
  // 누수 방지: 남은 자식은 모두 suspend(SIGTERM).
  for (const sid of spawnedSandboxIds) {
    try {
      await piRuntime.suspend({ id: 's', sandboxId: sid });
    } catch {
      /* noop */
    }
  }
  spawnedSandboxIds.length = 0;
});

describe('PiRuntime spawn/suspend', () => {
  it('spawns a live child with a numeric pid, then suspend kills it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-rt-'));
    const sandboxId = `sbx-${Date.now()}`;
    spawnedSandboxIds.push(sandboxId);

    const res = await piRuntime.spawn({ id: sandboxId, path: dir });

    expect(typeof res.pid).toBe('number');
    expect(res.pid).toBeGreaterThan(0);
    expect(typeof res.sessionRef).toBe('string');

    // 자식이 실제로 살아있다.
    expect(isAlive(res.pid)).toBe(true);
    expect(piRuntime.getPid(sandboxId)).toBe(res.pid);

    // suspend → SIGTERM → 죽는다.
    await piRuntime.suspend({ id: 's', sandboxId });

    // 종료가 비동기일 수 있으므로 잠깐 폴링.
    const pid = res.pid;
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (!isAlive(pid) || Date.now() - start > 3000) return resolve();
        setTimeout(tick, 25);
      };
      tick();
    });

    expect(isAlive(pid)).toBe(false);
    expect(piRuntime.getPid(sandboxId)).toBeNull();
  });

  it('attach reuses the existing process (no new spawn)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-rt-'));
    const sandboxId = `sbx-${Date.now()}-a`;
    spawnedSandboxIds.push(sandboxId);

    const res = await piRuntime.spawn({ id: sandboxId, path: dir });
    // attach 는 throw 하지 않고 같은 pid 를 유지해야 한다.
    await piRuntime.attach({ id: 'sess', sandboxId });
    expect(piRuntime.getPid(sandboxId)).toBe(res.pid);
  });

  it('injected env carries model/baseURL but a logged snapshot never contains the apiKey value', () => {
    const rt = getLlmRuntimeConfig();
    const snap = describeSpawn('ko');

    // model/baseURL 은 주입 스냅샷에 존재.
    expect(snap.env.OPENAI_MODEL).toBe(rt.model);
    expect(snap.env.OPENAI_BASE_URL).toBe(rt.baseURL);
    expect(snap.env.LANG_HINT).toBe('ko');

    // 키는 마스킹.
    expect(snap.env.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(snap.env.PI_API_KEY).toBe('[REDACTED]');

    // 평문 키가 어디에도 없다(실제 키가 설정된 경우에도).
    const serialized = JSON.stringify(snap);
    if (rt.apiKey) {
      expect(serialized).not.toContain(rt.apiKey);
    }
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('redactSpawnEnv masks every secret-like key', () => {
    const masked = redactSpawnEnv({
      OPENAI_API_KEY: 'super-secret-value',
      PI_API_KEY: 'super-secret-value',
      OPENAI_MODEL: 'openai/gpt-4o-mini',
      OPENAI_BASE_URL: 'https://models.github.ai/inference',
      LANG_HINT: 'en',
    });
    expect(masked.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(masked.PI_API_KEY).toBe('[REDACTED]');
    expect(masked.OPENAI_MODEL).toBe('openai/gpt-4o-mini');
    expect(JSON.stringify(masked)).not.toContain('super-secret-value');
  });
});
