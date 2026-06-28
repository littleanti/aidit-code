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
import { config } from '../config.js';
import type { AgentRuntime, SpawnResult } from './runtime.js';

/**
 * 한 턴에 동봉되는 이미지 참조(Feature A 비전). 워커가 absPath 를 업로드 디렉토리 가드 후 읽어
 * data-url 로 인코딩해 OpenAI multimodal content 로 넣는다. 키 없음.
 */
export interface TurnImage {
  /** 호스트 절대경로(업로드 디렉토리 내부 — imageRef.resolveImageRef 가 보장). */
  absPath: string;
  /** image/png|jpeg|webp|gif. */
  mime: string;
}

/** 한 턴의 옵션(이미지/추론강도). 둘 다 선택. */
export interface TurnOptions {
  image?: TurnImage;
  /** Feature B: 'low'|'medium'|'high'. 워커가 reasoning_effort 로 전달(값 있을 때만). */
  reasoningEffort?: string;
}

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
  /** worker 가 방출한 도구 의도. toolBridge 가 실제 실행 후 ackTool 로 worker 를 진행시킨다. */
  onTool: (intent: ToolIntent) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/** worker 가 방출하는 도구 실행 의도(piWorker.mjs 의 {type:'tool', ...} 라인). */
export interface ToolIntent {
  kind: 'SHELL' | 'FILE_WRITE' | 'FILE_DELETE' | 'FILE_READ' | 'PACKAGE' | 'OTHER';
  name: string;
  command?: string;
  relPath?: string;
  content?: string;
  /** OpenAI function-calling 의 tool_call id(있으면 worker 가 결과를 이 id 로 LLM 에 되먹임). */
  callId?: string;
}

/** 도구 실행 결과를 worker 로 되먹이는 ack 페이로드(LLM function-calling 루프용). */
export interface ToolAckResult {
  /** ToolCall 성공 여부. */
  ok: boolean;
  /** LLM tool 메시지로 넣을 출력(파일 내용/쉘 출력/상태). 키 없음. */
  output: string;
  /** 대응하는 tool_call id(worker 가 어떤 호출의 결과인지 매칭). */
  callId?: string;
}

/**
 * 큐에 대기 중인(아직 시작 전) 한 턴. send() 가 적재하고 pumpQueue() 가 꺼내 활성화한다.
 * 같은 샌드박스의 동시 요청을 인터럽트(선점)하지 않고 FIFO 로 직렬화하기 위한 단위다.
 */
interface QueuedTurn {
  input: string;
  lang: string;
  onToken: (delta: string) => void;
  onTool?: (intent: ToolIntent) => void;
  options?: TurnOptions;
  /** 이 턴의 send() Promise 를 마감하는 settler(done→resolve / error·종료→reject). */
  resolve: () => void;
  reject: (err: Error) => void;
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
  /** 진행 중 턴이 끝나길 기다리는 FIFO 대기열(선점 대신 순차 처리). */
  queue: QueuedTurn[];
}

/**
 * 대기열에서 다음 턴을 꺼내 활성화한다(진행 중 턴이 없을 때만).
 * worker 는 1턴씩 처리하므로, 각 턴의 done/error(pumpTurnLines 가 activeTurn=null 로 만든 뒤
 * sink.onDone/onError 호출) 시점에 다시 호출되어 큐를 한 칸씩 전진시킨다.
 */
function pumpQueue(h: RuntimeHandle): void {
  if (h.activeTurn) return; // 턴 진행 중 — 끝나면 onDone/onError 에서 재호출된다.
  const next = h.queue.shift();
  if (!next) return; // 대기열 비어있음.
  const sink: TurnSink = {
    onToken: (delta) => next.onToken(delta),
    onTool: (intent) => next.onTool?.(intent),
    onDone: () => {
      next.resolve();
      pumpQueue(h); // 다음 대기 턴 진행.
    },
    onError: (message) => {
      next.reject(new Error(message));
      pumpQueue(h);
    },
  };
  h.activeTurn = sink;
  try {
    // Feature A/B: image{absPath,mime}·reasoningEffort 를 턴 프로토콜에 동봉(값 있을 때만).
    const payload: {
      type: 'input';
      text: string;
      lang: string;
      image?: TurnImage;
      reasoningEffort?: string;
    } = { type: 'input', text: next.input, lang: next.lang };
    if (next.options?.image) payload.image = next.options.image;
    if (next.options?.reasoningEffort) payload.reasoningEffort = next.options.reasoningEffort;
    h.child.stdin?.write(JSON.stringify(payload) + '\n');
  } catch (err) {
    h.activeTurn = null;
    next.reject(err instanceof Error ? err : new Error('failed to write input'));
    pumpQueue(h); // 쓰기 실패한 턴은 건너뛰고 다음을 시도.
  }
}

const handles = new Map<string, RuntimeHandle>();

/**
 * 핸들의 자식이 아직 살아있는지 검사한다(멱등 spawn 가드용).
 * child.exitCode/signalCode 가 모두 null 이고 kill 되지 않았으면 살아있다고 본다.
 */
function isHandleLive(h: RuntimeHandle): boolean {
  const c = h.child;
  // 종료 코드/시그널이 잡혔으면 이미 죽음. killed 플래그도 확인.
  if (c.exitCode !== null || c.signalCode !== null || c.killed) return false;
  return true;
}

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
    let msg: {
      type?: string;
      delta?: string;
      message?: string;
      kind?: string;
      name?: string;
      command?: string;
      relPath?: string;
      content?: string;
      callId?: string;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 비-JSON(예: 'ready' 잔여)은 무시.
    }
    const sink = handle.activeTurn;
    if (!sink) continue;
    if (msg.type === 'token') {
      sink.onToken(typeof msg.delta === 'string' ? msg.delta : '');
    } else if (msg.type === 'tool') {
      sink.onTool({
        kind: (msg.kind as ToolIntent['kind']) ?? 'OTHER',
        name: typeof msg.name === 'string' ? msg.name : 'tool',
        command: typeof msg.command === 'string' ? msg.command : undefined,
        relPath: typeof msg.relPath === 'string' ? msg.relPath : undefined,
        content: typeof msg.content === 'string' ? msg.content : undefined,
        callId: typeof msg.callId === 'string' ? msg.callId : undefined,
      });
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
    // 업로드 디렉토리(Feature A 비전) — 워커가 이미지 파일을 읽기 전 경로 가드 기준.
    UPLOAD_DIR: config.uploadDir,
  };
}

/**
 * 로그/스냅샷 안전용 env redactor. apiKey 류는 항상 마스킹한다.
 * spawn 정보를 로그해야 할 때 반드시 이 함수의 반환값만 사용한다.
 */
export function redactSpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const isSecret = (k: string) => /API_KEY|TOKEN|SECRET|PASSWORD/i.test(k);
  const out: Record<string, string> = {};
  for (const k of ['OPENAI_BASE_URL', 'OPENAI_MODEL', 'PI_BASE_URL', 'PI_MODEL', 'LANG_HINT', 'UPLOAD_DIR', 'OPENAI_API_KEY', 'PI_API_KEY']) {
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
    // 멱등 가드(Race A/D): 이미 이 sandbox 에 살아있는 자식이 있으면 새로 띄우지 않고 기존 핸들을 재사용한다.
    //   (mutex 가 같은 sandbox 호출을 직렬화하므로 통상 여기에 도달하지 않지만, 다른 경로의 직접 spawn 호출에도 안전.)
    //   죽은 핸들이 남아있으면 아래 정상 경로로 떨어져 교체한다(set 직전에 stale 핸들을 정리).
    const prior = handles.get(sandbox.id);
    if (prior && isHandleLive(prior)) {
      return { pid: prior.pid, sessionRef: prior.sessionRef };
    }

    const env = buildInjectedEnv(langHint);

    const child = spawn(process.execPath, [WORKER_PATH], {
      cwd: sandbox.path,
      env,
      // stdin = pipe: M4 턴 프로토콜({type:'input'|'interrupt'})을 worker stdin 으로 기록한다.
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: 콘솔 창을 만들지 않는다. 서버가 부모 콘솔/윈도우 스테이션에 묶이지 않은
      // 상태(예: 런치 콘솔이 종료된 detached 서버)에서도 자식 생성이 0xC0000142
      // (STATUS_DLL_INIT_FAILED)로 깨지지 않도록 하는 하드닝. 비Windows에선 무시됨.
      windowsHide: true,
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
        // set 직전 멱등 재확인(Race A/D): onReady 시점에 다른 live 자식이 이미 등록돼 있으면,
        // 방금 띄운 이 자식을 loser 로 보고 SIGTERM 한 뒤 기존 핸들을 그대로 반환한다(고아 방지).
        const existing = handles.get(sandbox.id);
        if (existing && existing.child !== child && isHandleLive(existing)) {
          try { child.kill('SIGTERM'); } catch { /* noop */ }
          resolve({ pid: existing.pid, sessionRef: existing.sessionRef });
          return;
        }
        const handle: RuntimeHandle = {
          child,
          pid,
          sessionRef,
          stdoutBuf: '',
          activeTurn: null,
          queue: [],
        };
        handles.set(sandbox.id, handle);
        // ready 라인 이후 같은 청크에 턴 데이터가 붙어왔을 수 있으니 잔여를 펌프로 넘긴다.
        // 'ready\n' 한 줄만 제거하고 나머지를 턴 파서로 흘린다.
        const afterReady = buf.replace(/^[\s\S]*?ready\n/, '');
        // 펌프 핸들러를 등록(이후 모든 stdout 라인은 턴 프로토콜로 해석).
        child.stdout?.removeAllListeners('data');
        child.stdout?.on('data', (c: string) => pumpTurnLines(handle, c));
        if (afterReady) pumpTurnLines(handle, afterReady);
        // 프로세스가 예기치 않게 죽으면 레지스트리에서 정리하고 진행 턴 + 대기열을 에러로 마감.
        child.once('exit', () => {
          const h = handles.get(sandbox.id);
          if (h && h.child === child) {
            handles.delete(sandbox.id);
            // 대기열을 먼저 비운다: 활성 턴 onError 가 트리거하는 pumpQueue 가 죽은 stdin 에
            // 다음 입력을 쓰지 않도록(빈 큐 → no-op). 비운 항목은 아래에서 일괄 reject.
            const pending = h.queue.splice(0);
            const sink = h.activeTurn;
            if (sink) {
              h.activeTurn = null;
              sink.onError('agent process exited');
            }
            for (const q of pending) q.reject(new Error('agent process exited'));
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
    onTool?: (intent: ToolIntent) => void,
    options?: TurnOptions,
  ): Promise<void> {
    const h = handles.get(session.sandboxId);
    if (!h) {
      throw new Error('no active runtime process to send input to');
    }

    // 같은 샌드박스의 동시 요청은 인터럽트(선점)하지 않고 FIFO 큐로 직렬화한다.
    //   진행 중 턴이 있으면 대기열에 적재되고, 현재 턴이 done/error 로 끝나면 pumpQueue 가
    //   다음 턴을 자동 시작한다. image 의 absPath 는 라우트(imageRef.resolveImageRef)가
    //   업로드 디렉토리 내부로 검증한 경로다.
    return await new Promise<void>((resolve, reject) => {
      h.queue.push({ input, lang, onToken, onTool, options, resolve, reject });
      pumpQueue(h);
    });
  }

  /**
   * 부모(toolBridge)가 직전 도구 의도의 실행을 마쳤음을 worker 에 알린다.
   * worker 는 이 ack 를 받아 다음 도구 의도/토큰으로 진행한다(턴 직렬화).
   * 멱등: 활성 핸들이 없으면 no-op.
   */
  ackTool(session: Pick<AgentSession, 'sandboxId'>, result?: ToolAckResult): void {
    const h = handles.get(session.sandboxId);
    if (!h) return;
    try {
      // result(ok/output/callId)는 LLM function-calling 루프 되먹임용. 키 없음(toolBridge 보장).
      h.child.stdin?.write(JSON.stringify({ type: 'tool-done', result }) + '\n');
    } catch {
      /* noop — 이미 종료된 프로세스 */
    }
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
    //   worker 는 인터럽트된 턴의 stale done/error 를 억제하므로(piWorker), 아래 pumpQueue 가
    //   다음 대기 턴을 안전하게 시작해도 취소된 턴의 done 이 그 턴을 조기 resolve 하지 않는다.
    h.activeTurn = null;
    if (steer && steer.trim()) {
      // steer 가 곧바로 활성 작업이 되므로 큐는 펌프하지 않고 취소한다(인터럽트+steer+큐 = 드문 조합).
      //   매달림 방지를 위해 대기 턴은 reject(취소).
      try {
        h.child.stdin?.write(
          JSON.stringify({ type: 'input', text: steer, lang: 'en' }) + '\n',
        );
      } catch {
        /* noop */
      }
      const pending = h.queue.splice(0);
      for (const q of pending) q.reject(new Error('agent turn interrupted'));
      return;
    }
    // steer 가 없으면 대기 중인 후속 질문을 이어서 처리한다(A안 — 대기 질문 보존).
    pumpQueue(h);
  }

  /**
   * 해당 샌드박스에 활성 턴이 있거나 대기열이 비어있지 않으면 true(직렬 큐 진행 중).
   * 큐의 활성↔대기 전이는 단일 스레드에서 원자적이라 "처리 중인데 false" 인 틈은 없다.
   */
  isBusy(session: Pick<AgentSession, 'sandboxId'>): boolean {
    const h = handles.get(session.sandboxId);
    if (!h) return false;
    return h.activeTurn !== null || h.queue.length > 0;
  }

  async suspend(session: Pick<AgentSession, 'id' | 'sandboxId'>): Promise<void> {
    const h = handles.get(session.sandboxId);
    if (!h) return; // 이미 내려갔거나 attach 만 한 클라이언트 — 멱등.
    handles.delete(session.sandboxId);
    // 대기열을 정리한다: 프로세스를 내리므로 더는 진행 불가 — 매달림 방지로 일괄 reject.
    //   (handles 에서 먼저 제거했으므로 child 'exit' 핸들러는 이 큐를 보지 못한다.)
    const pending = h.queue.splice(0);
    for (const q of pending) q.reject(new Error('agent runtime suspended'));
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
