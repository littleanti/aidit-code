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
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideRoot, PathEscapeError } from '../sandbox/pathGuard.js';
import type { ToolKindValue } from '../realtime/events.js';

/** path violation 시 사용하는 결과 문구(이벤트/행에 남는 일반 문구 — 민감정보 아님). */
export const PATH_VIOLATION_RESULT = 'path violation';

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
): Promise<ToolExecResult> {
  switch (req.kind) {
    case 'FILE_WRITE':
      return await runFileWrite(sandboxRoot, req, onChunk);
    case 'FILE_READ':
      return await runFileRead(sandboxRoot, req, onChunk);
    case 'FILE_DELETE':
      return await runFileDelete(sandboxRoot, req, onChunk);
    case 'SHELL':
    case 'PACKAGE':
      return await runShell(sandboxRoot, req, onChunk);
    default:
      onChunk(`unsupported tool kind: ${req.kind}`);
      return { status: 'FAILED', exitCode: 1, result: `unsupported tool kind: ${req.kind}` };
  }
}

/** FILE_WRITE — 경로 가드 통과 시 파일 기록. */
async function runFileWrite(
  root: string,
  req: ToolExecRequest,
  onChunk: ToolChunkSink,
): Promise<ToolExecResult> {
  const relPath = req.relPath ?? '';
  let abs: string;
  try {
    abs = resolveInsideRoot(root, relPath);
  } catch (err) {
    return pathViolation(err, onChunk);
  }
  try {
    // 부모 디렉토리를 보장(루트 안에서만 — abs 는 이미 경로 가드를 통과했다).
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, req.content ?? '', 'utf8');
    const msg = `wrote ${relPath} (${Buffer.byteLength(req.content ?? '', 'utf8')} bytes)`;
    onChunk(msg + '\n');
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

/** FILE_DELETE — 경로 가드 통과 시 파일/디렉토리 삭제. */
async function runFileDelete(
  root: string,
  req: ToolExecRequest,
  onChunk: ToolChunkSink,
): Promise<ToolExecResult> {
  const relPath = req.relPath ?? '';
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
): Promise<ToolExecResult> {
  const command = req.command ?? '';
  if (!command.trim()) {
    onChunk('empty command\n');
    return Promise.resolve({ status: 'FAILED', exitCode: 1, result: 'empty command' });
  }

  return new Promise<ToolExecResult>((resolve) => {
    // 플랫폼별 셸: Windows=cmd /c, POSIX=sh -c. cwd 격리(루트 밖 접근은 OS 권한/경로 가드 밖이나
    // PoC §6.2 는 샌드박스 내부 모든 permission 허용 — 경계는 경로 가드가 담당하는 FILE_* 뿐).
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn(command, { cwd: root, shell: true })
      : spawn('sh', ['-c', command], { cwd: root });

    liveChildren.add(child);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => onChunk(c));
    child.stderr?.on('data', (c: string) => onChunk(c));

    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
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
