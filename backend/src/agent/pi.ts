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
import type { AgentRuntime, SpawnResult } from './runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** stub worker 절대경로. .ts(src) 환경에서도 같은 디렉토리의 .mjs 를 가리킨다. */
const WORKER_PATH = path.join(__dirname, 'piWorker.mjs');

/** worker 가 ready 를 알릴 때까지 기다리는 상한(ms). 테스트/PoC 는 짧게. */
const READY_TIMEOUT_MS = Number(process.env.AGENT_READY_TIMEOUT_MS) || 5000;

/**
 * 진행 중인 한 턴의 수신 콜백 묶음.
 * worker stdout 의 token/done/error JSON-line 이 여기로 디스패치된다.
 */
interface TurnSink {
  onToken: (delta: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/** in-memory 세션 레지스트리: sandboxId -> 활성 프로세스 핸들. */
interface RuntimeHandle {
  child: ChildProcess;
  pid: number;
  sessionRef: string;
  /** ready 이후 stdout 라인 파싱용 누적 버퍼. */
  stdoutBuf: string;
  /** 현재 활성 턴의 sink(없으면 null — 턴 외 라인은 무시). */
  activeTurn: TurnSink | null;
}

const handles = new Map<string, RuntimeHandle>();

/**
 * ready 이후 worker stdout 의 JSON-line(턴 프로토콜)을 파싱해 활성 턴 sink 로 디스패치한다.
 * 보안: delta/메시지는 에이전트 텍스트만 — 키를 절대 포함하지 않는다(worker 가 echo 안 함).
 */
function pumpTurnLines(handle: RuntimeHandle, chunk: string): void {
  handle.stdoutBuf += chunk;
  let nl: number;
  while ((nl = handle.stdoutBuf.indexOf('\n')) >= 0) {
    const line = handle.stdoutBuf.slice(0, nl).trim();
    handle.stdoutBuf = handle.stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg: { type?: string; delta?: string; message?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 비-JSON(예: 'ready' 잔여)은 무시.
    }
    const sink = handle.activeTurn;
    if (!sink) continue;
    if (msg.type === 'token') {
      sink.onToken(typeof msg.delta === 'string' ? msg.delta : '');
    } else if (msg.type === 'done') {
      handle.activeTurn = null;
      sink.onDone();
    } else if (msg.type === 'error') {
      handle.activeTurn = null;
      sink.onError(typeof msg.message === 'string' ? msg.message : 'agent turn failed');
    }
  }
}

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
      // stdin = pipe: M4 턴 프로토콜({type:'input'|'interrupt'})을 worker stdin 으로 기록한다.
      stdio: ['pipe', 'pipe', 'pipe'],
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
        const handle: RuntimeHandle = {
          child,
          pid,
          sessionRef,
          stdoutBuf: '',
          activeTurn: null,
        };
        handles.set(sandbox.id, handle);
        // ready 라인 이후 같은 청크에 턴 데이터가 붙어왔을 수 있으니 잔여를 펌프로 넘긴다.
        // 'ready\n' 한 줄만 제거하고 나머지를 턴 파서로 흘린다.
        const afterReady = buf.replace(/^[\s\S]*?ready\n/, '');
        // 펌프 핸들러를 등록(이후 모든 stdout 라인은 턴 프로토콜로 해석).
        child.stdout?.removeAllListeners('data');
        child.stdout?.on('data', (c: string) => pumpTurnLines(handle, c));
        if (afterReady) pumpTurnLines(handle, afterReady);
        // 프로세스가 예기치 않게 죽으면 레지스트리에서 정리하고 진행 턴을 에러로 마감.
        child.once('exit', () => {
          const h = handles.get(sandbox.id);
          if (h && h.child === child) {
            handles.delete(sandbox.id);
            const sink = h.activeTurn;
            if (sink) {
              h.activeTurn = null;
              sink.onError('agent process exited');
            }
          }
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

  /**
   * 사용자 입력을 worker 로 보내 한 턴을 스트리밍한다(TRD §5.1).
   * stdin 에 {type:'input', text, lang} 를 쓰고, worker 의 token 라인마다 onToken 콜백을 호출한다.
   * Promise 는 done 에서 resolve, error/프로세스 종료에서 reject.
   *
   * 시임 설계: pi.ts 는 messageId/seq 를 알지 못한다(AR-TURN 이 부여) — 토큰 delta(텍스트)만 흘린다.
   *   turn.ts 가 넘기는 onToken 콜백이 자신이 보유한 messageId/seq 로 agent.token 이벤트를 빌드/publish 한다.
   *   (EmitFn 시그니처를 유지하되, 토큰 전용 콜백을 4번째 인자로 받는다.)
   */
  async send(
    session: Pick<AgentSession, 'id' | 'sandboxId'>,
    input: string,
    lang: string,
    onToken: (delta: string) => void,
  ): Promise<void> {
    const h = handles.get(session.sandboxId);
    if (!h) {
      throw new Error('no active runtime process to send input to');
    }
    if (h.activeTurn) {
      // 동시 활성 세션 1개 권장(TRD §5.4): 이전 턴을 인터럽트하고 새 턴을 시작.
      try {
        h.child.stdin?.write(JSON.stringify({ type: 'interrupt' }) + '\n');
      } catch {
        /* noop */
      }
      h.activeTurn = null;
    }

    return await new Promise<void>((resolve, reject) => {
      const sink: TurnSink = {
        onToken: (delta) => onToken(delta),
        onDone: () => resolve(),
        onError: (message) => reject(new Error(message)),
      };
      h.activeTurn = sink;
      try {
        h.child.stdin?.write(
          JSON.stringify({ type: 'input', text: input, lang }) + '\n',
        );
      } catch (err) {
        h.activeTurn = null;
        reject(err instanceof Error ? err : new Error('failed to write input'));
      }
    });
  }

  /**
   * 진행 중 턴을 인터럽트한다(TRD §6.1 step4). worker 에 {type:'interrupt'} 를 보내
   * 남은 토큰 방출을 즉시 중단시킨다. steer 가 있으면 새 입력으로 주입(방향 전환).
   * 멱등: 활성 핸들/턴이 없어도 무해.
   */
  async interrupt(
    session: Pick<AgentSession, 'id' | 'sandboxId'>,
    steer?: string,
  ): Promise<void> {
    const h = handles.get(session.sandboxId);
    if (!h) return; // 멱등.
    try {
      h.child.stdin?.write(JSON.stringify({ type: 'interrupt' }) + '\n');
    } catch {
      /* noop — 이미 종료된 프로세스 */
    }
    // 진행 중 턴 sink 는 done 라인을 받지 못할 수 있으므로 정리(턴 Promise 는 turn.ts 가 race 로 마감).
    h.activeTurn = null;
    if (steer && steer.trim()) {
      try {
        h.child.stdin?.write(
          JSON.stringify({ type: 'input', text: steer, lang: 'en' }) + '\n',
        );
      } catch {
        /* noop */
      }
    }
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
