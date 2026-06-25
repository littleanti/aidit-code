// backend/src/agent/pi.ts
// AR-PI — PoC pi-agent 바인딩. 실제 pi 바이너리는 이 머신에 보장되지 않으므로
//   stub worker(piWorker.mjs)를 REAL child process 로 spawn 해 세션 프로세스를 표상한다.
//
// 동작(TRD §5·§6):
//   - spawn(sandbox): cwd = sandbox.path, env = process.env + 주입된 OpenAI-compatible 설정
//       (OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL + PI_* 별칭 + LANG_HINT). worker 의 'ready'
//       라인을 기다려 resolve(STARTING -> IDLE). pid 를 in-memory 레지스트리에 등록.
//   - attach(session): 새 프로세스 없이 기존 활성 프로세스 공유(멀티 클라이언트 fan-out).
//   - suspend(session): 자식에 SIGTERM, 레지스트리에서 제거. 샌드박스 디렉토리는 보존(삭제 금지).
//   - resume: SUSPENDED 샌드박스에 대한 새 spawn(디렉토리가 이미 존재할 뿐 동일 코드 경로).
//
// 보안(CRITICAL, CLAUDE.md/TRD §8):
//   - apiKey 는 ENV 로만 주입한다. 절대 로그/스냅샷/이벤트에 넣지 않는다.
//   - spawn 정보를 로그할 땐 redactSpawnEnv() 로 키를 마스킹한 객체만 사용한다.
//   - context/history/summary 는 런타임 책임(TRD §5.3) — 서버는 관리하지 않는다.

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sandbox, AgentSession } from '@prisma/client';
import { getLlmRuntimeConfig } from './config.js';
import type { AgentRuntime, EmitFn, SpawnResult } from './runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** stub worker 절대경로. .ts(src) 환경에서도 같은 디렉토리의 .mjs 를 가리킨다. */
const WORKER_PATH = path.join(__dirname, 'piWorker.mjs');

/** worker 가 ready 를 알릴 때까지 기다리는 상한(ms). 테스트/PoC 는 짧게. */
const READY_TIMEOUT_MS = Number(process.env.AGENT_READY_TIMEOUT_MS) || 5000;

/** in-memory 세션 레지스트리: sandboxId -> 활성 프로세스 핸들. */
interface RuntimeHandle {
  child: ChildProcess;
  pid: number;
  sessionRef: string;
}

const handles = new Map<string, RuntimeHandle>();

/**
 * 주입 env 를 구성한다. apiKey 는 OPENAI_API_KEY/PI_API_KEY 로만 들어가고,
 * 로그용으로는 절대 이 객체를 직접 쓰지 말 것(redactSpawnEnv 사용).
 */
function buildInjectedEnv(langHint: string): NodeJS.ProcessEnv {
  const rt = getLlmRuntimeConfig();
  return {
    ...process.env,
    // OpenAI-compatible 표준 이름.
    OPENAI_BASE_URL: rt.baseURL,
    OPENAI_API_KEY: rt.apiKey,
    OPENAI_MODEL: rt.model,
    // pi 별칭(런타임이 PI_* 를 읽는 경우).
    PI_BASE_URL: rt.baseURL,
    PI_API_KEY: rt.apiKey,
    PI_MODEL: rt.model,
    // 응답 언어 힌트(TRD §5).
    LANG_HINT: langHint,
  };
}

/**
 * 로그/스냅샷 안전용 env redactor. apiKey 류는 항상 마스킹한다.
 * spawn 정보를 로그해야 할 때 반드시 이 함수의 반환값만 사용한다.
 */
export function redactSpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const isSecret = (k: string) => /API_KEY|TOKEN|SECRET|PASSWORD/i.test(k);
  const out: Record<string, string> = {};
  for (const k of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'PI_BASE_URL', 'PI_MODEL', 'LANG_HINT', 'OPENAI_API_KEY', 'PI_API_KEY']) {
    const v = env[k];
    if (v === undefined) continue;
    out[k] = isSecret(k) ? '[REDACTED]' : v;
  }
  return out;
}

/**
 * 진단/테스트용: 실제로 주입될 env 의 redacted 스냅샷을 반환한다.
 * apiKey 평문은 절대 포함되지 않는다(키는 [REDACTED]).
 */
export function describeSpawn(langHint = 'en'): { workerPath: string; env: Record<string, string> } {
  return {
    workerPath: WORKER_PATH,
    env: redactSpawnEnv(buildInjectedEnv(langHint)),
  };
}

class PiRuntime implements AgentRuntime {
  async spawn(
    sandbox: Pick<Sandbox, 'id' | 'path'>,
    langHint = 'en',
  ): Promise<SpawnResult> {
    const env = buildInjectedEnv(langHint);

    const child = spawn(process.execPath, [WORKER_PATH], {
      cwd: sandbox.path,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const sessionRef = `pi:${sandbox.id}:${Date.now()}`;

    return await new Promise<SpawnResult>((resolve, reject) => {
      let settled = false;
      let buf = '';

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* noop */ }
        reject(new Error('agent worker did not signal ready in time'));
      }, READY_TIMEOUT_MS);

      const onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const pid = child.pid;
        if (pid == null) {
          reject(new Error('agent worker spawned without a pid'));
          return;
        }
        handles.set(sandbox.id, { child, pid, sessionRef });
        // 프로세스가 예기치 않게 죽으면 레지스트리에서 정리.
        child.once('exit', () => {
          const h = handles.get(sandbox.id);
          if (h && h.child === child) handles.delete(sandbox.id);
        });
        resolve({ pid, sessionRef });
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.includes('ready')) onReady();
      });

      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.once('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`agent worker exited before ready (code ${code})`));
      });
    });
  }

  async attach(session: Pick<AgentSession, 'id' | 'sandboxId'>): Promise<void> {
    // 멀티 클라이언트 fan-out: 새 프로세스 없이 기존 핸들을 공유한다.
    // 활성 핸들이 없으면(드문 경우) 호출부가 spawn 으로 떨어지도록 throw.
    const h = handles.get(session.sandboxId);
    if (!h) {
      throw new Error('no active runtime process to attach to');
    }
    // 이미 살아있는 프로세스를 그대로 사용 — no-op.
  }

  async sendInput(
    _session: Pick<AgentSession, 'id' | 'sandboxId'>,
    _input: string,
    _lang: string,
    _emit: EmitFn,
  ): Promise<void> {
    // M3 stub. 풀 턴 스트리밍은 M4(AR-TURN).
  }

  async interrupt(
    _session: Pick<AgentSession, 'id' | 'sandboxId'>,
    _steer?: string,
  ): Promise<void> {
    // M3 stub. M4 에서 현재 턴 인터럽트/스티어링 구현.
  }

  async suspend(session: Pick<AgentSession, 'id' | 'sandboxId'>): Promise<void> {
    const h = handles.get(session.sandboxId);
    if (!h) return; // 이미 내려갔거나 attach 만 한 클라이언트 — 멱등.
    handles.delete(session.sandboxId);
    try {
      h.child.kill('SIGTERM');
    } catch {
      // 이미 종료된 프로세스 — 무해.
    }
    // 디렉토리는 보존한다(삭제 금지). resume = SUSPENDED 샌드박스에 대한 새 spawn.
  }

  /** 테스트/진단용: 해당 샌드박스의 활성 pid(없으면 null). */
  getPid(sandboxId: string): number | null {
    return handles.get(sandboxId)?.pid ?? null;
  }
}

export const piRuntime = new PiRuntime();
