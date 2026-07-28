// backend/src/agent/toolExec.ts
// 도구 실행기 + 경로 가드(TRD §6.2·§6.3, PLAN §M5 BE-ISO).
//
// 샌드박스 루트(sandbox.path) 안에서 도구 요청을 안전하게 실행한다.
//   - FILE_WRITE/FILE_DELETE/FILE_READ: pathGuard.resolveInsideRoot 로 대상 경로를 해석한다.
//       '..'/절대경로/symlink 탈출은 PathEscapeError → 실패(exitCode≠0, result='path violation').
//   - SHELL/PACKAGE: child_process.spawn(cwd = sandbox.path). stdout+stderr 를 onChunk 로 스트리밍,
//       종료코드를 캡처한다. (PoC §6.2: 샌드박스 내부는 모든 permission 허용 — 경계는 경로 탈출뿐.)
//
// 보안(CLAUDE.md/TRD §8): 이 모듈은 명령/경로/출력만 다루며 LLM 키를 절대 참조/출력하지 않는다.
//   shell 자식의 env 는 process.env 를 그대로 물려받되(샌드박스 내부 허용), 출력 청크는 그대로
//   상위로 흘릴 뿐 키를 주입하지 않는다(주입은 pi.ts 의 worker 전용).

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, readFile, rm, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideRoot, PathEscapeError } from '../sandbox/pathGuard.js';
import type { ToolKindValue, FileChangeKind } from '../realtime/events.js';
import { config } from '../config.js';
import {
  attachToolTimeout,
  tryAcquireProc,
  releaseProc,
  TOOL_TIMEOUT_RESULT,
  PROC_CAP_RESULT,
} from '../sandbox/limits.js';

/** path violation 시 사용하는 결과 문구(이벤트/행에 남는 일반 문구 — 민감정보 아님). */
export const PATH_VIOLATION_RESULT = 'path violation';

/** 빈 relPath 시 사용하는 결과 문구. 빈 경로는 resolveInsideRoot 가 루트(디렉토리) 자체를
 *  반환해 writeFile 이 EISDIR 로 터지므로, 실행 전에 명시적으로 거른다(2중 방어 — worker 의
 *  parseToolArgs 게이트가 1차, 수동 '!write' 컨벤션 경로까지 이 가드가 커버). */
export const INVALID_PATH_RESULT = 'invalid path: empty relPath';

/**
 * 파일 변경 알림 콜백(M6 RT-FILEEV).
 *   - FILE_WRITE 성공: change='CREATED'(이전에 없던 경우)|'MODIFIED'(있던 경우), size=기록 바이트.
 *   - FILE_DELETE 성공: change='DELETED'(size 생략).
 *   - relPath 는 루트 상대(정규화는 makeFileChangedEvent 가 담당). 호출부가 publishToPost 로 잇는다.
 * SHELL/PACKAGE 유발 변경은 추적하지 않는다(PoC 범위 — 단일 파일 도구 효과만 관측).
 */
export type FileChangeSink = (change: {
  relPath: string;
  change: FileChangeKind;
  size?: number;
}) => void;

/** 도구 실행 요청. relPath 는 FILE_* 전용, command 는 SHELL/PACKAGE 전용. */
export interface ToolExecRequest {
  kind: ToolKindValue;
  /** 도구/명령 이름(예: 'bash', 'write_file'). */
  name: string;
  /** SHELL/PACKAGE: 실행할 명령 문자열. */
  command?: string;
  /** FILE_*: 루트 상대 경로. */
  relPath?: string;
  /** FILE_WRITE: 기록할 내용. */
  content?: string;
}

/** 격리 하드닝 옵션(M7 XC-ISO). 미지정 시 config.isolation 기본값을 따른다. */
export interface ToolExecOptions {
  /** per-sandbox child-process cap 적용 키(없으면 cap 미적용). */
  sandboxId?: string;
  /** SHELL/PACKAGE 벽시계 타임아웃(ms). 미지정 시 config.isolation.toolTimeoutMs. */
  timeoutMs?: number;
}

/** 도구 실행 결과(toolBridge 가 finalizeToolCall 로 넘긴다). */
export interface ToolExecResult {
  status: 'SUCCEEDED' | 'FAILED';
  exitCode: number | null;
  /** 최종 결과 본문(없으면 누적 출력 유지를 위해 undefined). */
  result?: string;
}

/** 실행 중 발생하는 출력 청크 콜백(stdout/stderr 통합 스트림). */
export type ToolChunkSink = (chunk: string) => void;

/**
 * 실행 중인 shell 자식들을 추적(테스트 afterEach 정리·서버 종료 시 일괄 kill 용).
 */
const liveChildren = new Set<ChildProcess>();

// ─────────────────────────────────────────────────────────────────────────────
// XC-ENV — 샌드박스 셸 ENV 화이트리스트 (CLAUDE.md L1 / TRD §8)
//
//   과거 결함: spawn 에 env 를 주지 않으면 자식이 process.env 를 통째로 상속한다.
//   config.ts 의 loadDotenv() 가 .env(API_KEY/BASE_URL/JWT_SECRET/DATABASE_URL)를
//   process.env 에 싣기 때문에, 에이전트가 `echo $API_KEY` 를 실행하면 그 출력이
//   TOOL_RESULT 버블로 스레드 참가자 전원에게 SSE 스트리밍됐다.
//
//   방침: **기본 거부(deny-by-default)**. 아래 화이트리스트에 있는 변수만 자식에 전달한다.
//   워커(pi.ts→piWorker.mjs)는 LLM 호출 주체라 키 주입을 유지하지만, 워커는 셸을 띄우지
//   않는다(도구 실행은 전부 이 모듈이 담당) — 그래서 경계가 여기 하나로 모인다.
// ─────────────────────────────────────────────────────────────────────────────

/** 플랫폼 공통 허용 변수(셸·툴체인 동작에 필요한 비민감 항목만). */
const ENV_ALLOW_COMMON = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
] as const;

/** Windows 셸(cmd)·툴체인이 없으면 아예 못 도는 항목들. */
const ENV_ALLOW_WIN = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
] as const;

/**
 * 이름만으로 비밀로 간주해 **무조건 제거**하는 패턴. 화이트리스트·운영자 passthrough 보다
 * 우선한다(설정 실수로도 키가 새지 않도록 하는 최후 방어선).
 */
const ENV_DENY_PATTERN = /(^|_)(API_KEY|BASE_URL|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)S?$|^(API_KEY|BASE_URL|DATABASE_URL|JWT_SECRET|OPENAI_API_KEY|PI_API_KEY)$/i;

/** 운영자 확장 훅: SANDBOX_ENV_PASSTHROUGH="FOO,BAR" 로 허용 항목 추가(denylist 는 못 뚫는다). */
function passthroughNames(): string[] {
  return (process.env.SANDBOX_ENV_PASSTHROUGH || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 샌드박스 셸 자식에게 넘길 ENV 를 만든다(화이트리스트 + 명시 주입).
 * export 하는 이유: 보안 테스트가 spawn 없이도 결과를 직접 단언할 수 있게 하기 위함.
 */
export function sandboxChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allow = new Set<string>([
    ...ENV_ALLOW_COMMON,
    ...(process.platform === 'win32' ? ENV_ALLOW_WIN : []),
    ...passthroughNames(),
  ]);

  const out: NodeJS.ProcessEnv = {};
  for (const name of allow) {
    // denylist 가 화이트리스트를 이긴다(passthrough 오설정 방어).
    if (ENV_DENY_PATTERN.test(name)) continue;
    const v = source[name];
    if (typeof v === 'string' && v.length > 0) out[name] = v;
  }

  // 명시 주입(상속 아님): 파이썬 워크로드 출력 인코딩 고정 — 데모 pytest 한글 출력 깨짐 방지.
  out.PYTHONIOENCODING = 'utf-8';
  out.PYTHONUTF8 = '1';
  // 샌드박스임을 자식이 인지할 수 있게(디버깅·워크로드 분기용 비민감 마커).
  out.AIDIT_SANDBOX = '1';

  return out;
}

/** 추적 중인 모든 자식에게 SIGTERM. 멱등. 테스트/종료 훅에서 사용. */
export function killAllToolChildren(): void {
  for (const child of [...liveChildren]) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* noop */
    }
    liveChildren.delete(child);
  }
}

/**
 * 도구 요청을 샌드박스 루트 안에서 실행한다.
 * 출력은 onChunk 로 점진 스트리밍하고, 최종 status/exitCode/result 를 반환한다.
 * 경로 탈출(PathEscapeError)은 throw 하지 않고 FAILED(exitCode 1, result='path violation')로 표현한다.
 */
export async function executeTool(
  sandboxRoot: string,
  req: ToolExecRequest,
  onChunk: ToolChunkSink,
  onFileChange?: FileChangeSink,
  opts: ToolExecOptions = {},
): Promise<ToolExecResult> {
  switch (req.kind) {
    case 'FILE_WRITE':
      return await runFileWrite(sandboxRoot, req, onChunk, onFileChange);
    case 'FILE_READ':
      return await runFileRead(sandboxRoot, req, onChunk);
    case 'FILE_DELETE':
      return await runFileDelete(sandboxRoot, req, onChunk, onFileChange);
    case 'SHELL':
    case 'PACKAGE':
      return await runShell(sandboxRoot, req, onChunk, opts);
    default:
      onChunk(`unsupported tool kind: ${req.kind}`);
      return { status: 'FAILED', exitCode: 1, result: `unsupported tool kind: ${req.kind}` };
  }
}

/** FILE_WRITE — 경로 가드 통과 시 파일 기록. 성공 시 file.changed(CREATED|MODIFIED). */
async function runFileWrite(
  root: string,
  req: ToolExecRequest,
  onChunk: ToolChunkSink,
  onFileChange?: FileChangeSink,
): Promise<ToolExecResult> {
  const relPath = req.relPath ?? '';
  if (!relPath.trim()) {
    onChunk(INVALID_PATH_RESULT + '\n');
    return { status: 'FAILED', exitCode: 1, result: INVALID_PATH_RESULT };
  }
  let abs: string;
  try {
    abs = resolveInsideRoot(root, relPath);
  } catch (err) {
    return pathViolation(err, onChunk);
  }
  // 변경 종류 판정용: 기록 전에 대상이 이미 존재했는지 확인(존재→MODIFIED, 부재→CREATED).
  let existed = false;
  try {
    await access(abs);
    existed = true;
  } catch {
    existed = false;
  }
  try {
    // 부모 디렉토리를 보장(루트 안에서만 — abs 는 이미 경로 가드를 통과했다).
    await mkdir(path.dirname(abs), { recursive: true });
    const bytes = Buffer.byteLength(req.content ?? '', 'utf8');
    await writeFile(abs, req.content ?? '', 'utf8');
    const msg = `wrote ${relPath} (${bytes} bytes)`;
    onChunk(msg + '\n');
    // file.changed 알림(루트 상대 경로 + 바이트 수). 정규화는 makeFileChangedEvent.
    onFileChange?.({ relPath, change: existed ? 'MODIFIED' : 'CREATED', size: bytes });
    return { status: 'SUCCEEDED', exitCode: 0, result: msg };
  } catch (err) {
    const msg = `write failed: ${errText(err)}`;
    onChunk(msg + '\n');
    return { status: 'FAILED', exitCode: 1, result: msg };
  }
}

/** FILE_READ — 경로 가드 통과 시 파일 내용을 출력으로 스트리밍. */
async function runFileRead(
  root: string,
  req: ToolExecRequest,
  onChunk: ToolChunkSink,
): Promise<ToolExecResult> {
  const relPath = req.relPath ?? '';
  if (!relPath.trim()) {
    onChunk(INVALID_PATH_RESULT + '\n');
    return { status: 'FAILED', exitCode: 1, result: INVALID_PATH_RESULT };
  }
  let abs: string;
  try {
    abs = resolveInsideRoot(root, relPath);
  } catch (err) {
    return pathViolation(err, onChunk);
  }
  try {
    const content = await readFile(abs, 'utf8');
    onChunk(content);
    return { status: 'SUCCEEDED', exitCode: 0, result: content };
  } catch (err) {
    const msg = `read failed: ${errText(err)}`;
    onChunk(msg + '\n');
    return { status: 'FAILED', exitCode: 1, result: msg };
  }
}

/** FILE_DELETE — 경로 가드 통과 시 파일/디렉토리 삭제. 성공 시 file.changed(DELETED). */
async function runFileDelete(
  root: string,
  req: ToolExecRequest,
  onChunk: ToolChunkSink,
  onFileChange?: FileChangeSink,
): Promise<ToolExecResult> {
  const relPath = req.relPath ?? '';
  if (!relPath.trim()) {
    onChunk(INVALID_PATH_RESULT + '\n');
    return { status: 'FAILED', exitCode: 1, result: INVALID_PATH_RESULT };
  }
  let abs: string;
  try {
    abs = resolveInsideRoot(root, relPath);
  } catch (err) {
    return pathViolation(err, onChunk);
  }
  try {
    await rm(abs, { recursive: true, force: true });
    const msg = `deleted ${relPath}`;
    onChunk(msg + '\n');
    // file.changed 알림(DELETED — size 생략). 정규화는 makeFileChangedEvent.
    onFileChange?.({ relPath, change: 'DELETED' });
    return { status: 'SUCCEEDED', exitCode: 0, result: msg };
  } catch (err) {
    const msg = `delete failed: ${errText(err)}`;
    onChunk(msg + '\n');
    return { status: 'FAILED', exitCode: 1, result: msg };
  }
}

/**
 * SHELL/PACKAGE — cwd=sandboxRoot 에서 셸을 통해 명령을 실행한다.
 * stdout+stderr 를 onChunk 로 스트리밍하고 exitCode 를 캡처한다.
 */
function runShell(
  root: string,
  req: ToolExecRequest,
  onChunk: ToolChunkSink,
  opts: ToolExecOptions = {},
): Promise<ToolExecResult> {
  const command = req.command ?? '';
  if (!command.trim()) {
    onChunk('empty command\n');
    return Promise.resolve({ status: 'FAILED', exitCode: 1, result: 'empty command' });
  }

  // (b) per-sandbox child-process cap(M7 XC-ISO). 초과 시 자식을 스폰하지 않고 FAILED.
  if (!tryAcquireProc(opts.sandboxId)) {
    onChunk(PROC_CAP_RESULT + '\n');
    return Promise.resolve({ status: 'FAILED', exitCode: 1, result: PROC_CAP_RESULT });
  }

  const timeoutMs = opts.timeoutMs ?? config.isolation.toolTimeoutMs;

  return new Promise<ToolExecResult>((resolve) => {
    // 플랫폼별 셸: Windows=cmd /c, POSIX=sh -c. cwd 격리(루트 밖 접근은 OS 권한/경로 가드 밖이나
    // PoC §6.2 는 샌드박스 내부 모든 permission 허용 — 경계는 경로 가드가 담당하는 FILE_* 뿐).
    const isWin = process.platform === 'win32';
    // XC-ENV: process.env 통째 상속 금지 — 화이트리스트 ENV 만 넘긴다(운영자 LLM 키 유출 차단).
    const env = sandboxChildEnv();
    // windowsHide: 콘솔 창 미할당(부모 콘솔/스테이션 의존도↓, 0xC0000142 내성). 비Windows 무시.
    const child = isWin
      ? spawn(command, { cwd: root, shell: true, windowsHide: true, env })
      : spawn('sh', ['-c', command], { cwd: root, windowsHide: true, env });

    liveChildren.add(child);

    // (a) 벽시계 타임아웃(M7 XC-ISO). 초과 시 child kill → FAILED 'timeout'.
    const guard = attachToolTimeout(child, timeoutMs, () => {
      onChunk(TOOL_TIMEOUT_RESULT + '\n');
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => onChunk(c));
    child.stderr?.on('data', (c: string) => onChunk(c));

    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      guard.clear();
      releaseProc(opts.sandboxId);
      liveChildren.delete(child);
      // 타임아웃으로 죽은 경우: exitCode 와 무관하게 FAILED 'timeout'.
      if (guard.timedOut()) {
        resolve({ status: 'FAILED', exitCode: exitCode ?? 1, result: TOOL_TIMEOUT_RESULT });
        return;
      }
      const status: 'SUCCEEDED' | 'FAILED' = exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
      resolve({ status, exitCode });
    };

    child.on('error', (err) => {
      onChunk(`spawn error: ${errText(err)}\n`);
      finish(1);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

/** PathEscapeError → FAILED(exitCode 1, result='path violation'). 그 외 에러는 재throw. */
function pathViolation(err: unknown, onChunk: ToolChunkSink): ToolExecResult {
  if (err instanceof PathEscapeError) {
    onChunk(PATH_VIOLATION_RESULT + '\n');
    return { status: 'FAILED', exitCode: 1, result: PATH_VIOLATION_RESULT };
  }
  throw err;
}

/** 에러를 일반 문구로 변환(키/원문 민감정보 미포함 — 시스템 에러 메시지만). */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
