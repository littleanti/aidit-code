// backend/src/agent/toolBridge.ts
// AR-TOOL — worker 도구 프로토콜 ↔ BE-TOOL(도메인) ↔ toolExec(실행) 연결(PLAN §M5).
//
// 흐름(worker 가 도구 의도를 방출 → 서버가 실제 실행):
//   1) worker 가 {type:'tool', kind, name, ...} 를 방출 → pi.ts 가 onTool 로 surface.
//   2) toolBridge.runToolIntent:
//        a. createToolCall  → ToolCall(RUNNING) + TOOL_CALL/TOOL_RESULT 버블 + tool.call 이벤트.
//        b. executeTool     → 실제 fs/shell 효과(경로 가드). stdout/stderr 청크마다 appendToolOutput
//                              → tool.output 이벤트.
//        c. finalizeToolCall → 종료 상태 확정 + tool.result 이벤트.
//   3) 완료 후 runtime.ackTool 로 worker 를 다음 의도/토큰으로 진행시킨다(턴 직렬화).
//
// 보안(CLAUDE.md/TRD §8): args/result/chunk 어디에도 LLM 키를 담지 않는다.
//   args 는 명령/경로만 JSON 직렬화한다. 실제 효과는 반드시 샌드박스 루트 안에서만(경로 가드).

import { createToolCall, appendToolOutput, finalizeToolCall } from '../domain/toolCall.js';
import { executeTool, type ToolExecRequest, type FileChangeSink } from './toolExec.js';
import type { ToolIntent } from './pi.js';
import type { ToolKindValue } from '../realtime/events.js';
import { publishToPost } from '../realtime/publish.js';
import { makeFileChangedEvent } from '../realtime/events.js';

/** 도구 의도 1건을 처리하는 데 필요한 컨텍스트. */
export interface ToolBridgeContext {
  postId: string;
  sessionId: string;
  /** 샌드박스 격리 루트(호스트 절대경로). 모든 fs/shell 효과의 cwd/경로 기준. */
  sandboxRoot: string;
}

/** 이벤트/행에 남길 args JSON 문자열을 구성한다(명령/경로만 — 키 없음). */
function buildArgs(intent: ToolIntent): string {
  const args: Record<string, string> = {};
  if (intent.command !== undefined) args.command = intent.command;
  if (intent.relPath !== undefined) args.relPath = intent.relPath;
  // content 는 잠재적으로 클 수 있고 args 표시용이므로 그대로 직렬화하되 키는 아님.
  if (intent.content !== undefined) args.content = intent.content;
  return JSON.stringify(args);
}

/** LLM 으로 되먹임할 도구 출력의 최대 길이(과도한 컨텍스트 방지). */
const TOOL_OUTPUT_CAP = 8000;

/** runToolIntent 결과: toolCallId(진단/테스트) + LLM 되먹임용 성공여부/출력. */
export interface ToolIntentOutcome {
  toolCallId: string;
  /** ToolCall 이 SUCCEEDED 인지. */
  ok: boolean;
  /** LLM 의 tool 메시지로 되먹일 출력(파일 내용/쉘 출력/상태 문구, 길이 캡). 키 없음. */
  output: string;
}

/**
 * 하나의 도구 의도를 끝까지 처리한다(create → exec(streaming) → finalize).
 * 도구 실행 자체가 실패해도 throw 하지 않고 ToolCall 을 FAILED 로 마감한다(턴은 계속 진행).
 * @returns toolCallId + LLM 되먹임용 ok/output(AR-TOOL function-calling 루프에서 사용).
 */
export async function runToolIntent(
  ctx: ToolBridgeContext,
  intent: ToolIntent,
): Promise<ToolIntentOutcome> {
  const kind = intent.kind as ToolKindValue;
  const args = buildArgs(intent);

  // a. ToolCall + 버블 + tool.call.
  const { toolCallId } = await createToolCall({
    postId: ctx.postId,
    sessionId: ctx.sessionId,
    kind,
    name: intent.name,
    args,
  });

  // b. 실제 실행 — 청크마다 appendToolOutput(tool.output). 직렬화 위해 append 를 await 큐로 잇는다.
  const req: ToolExecRequest = {
    kind,
    name: intent.name,
    command: intent.command,
    relPath: intent.relPath,
    content: intent.content,
  };

  // appendToolOutput 은 비동기(DB+publish)이므로, onChunk 콜백이 동기 호출되어도
  // 순서를 보존하기 위해 직렬 큐로 잇는다.
  let appendChain: Promise<void> = Promise.resolve();
  // LLM 되먹임용 출력 누적(SHELL 처럼 result 가 비는 경우 청크에서 모은다). 길이 캡.
  let outputBuf = '';
  const onChunk = (chunk: string): void => {
    if (outputBuf.length < TOOL_OUTPUT_CAP) {
      outputBuf = (outputBuf + chunk).slice(0, TOOL_OUTPUT_CAP);
    }
    appendChain = appendChain.then(() => appendToolOutput(toolCallId, chunk));
  };

  // file.changed(M6 RT-FILEEV): FILE_WRITE/FILE_DELETE 성공 시 루트 상대 경로로 전원 중계.
  //   path 정규화(역슬래시→슬래시)는 makeFileChangedEvent 가 담당. 키 필드 없음.
  const onFileChange: FileChangeSink = (fc) => {
    publishToPost(
      ctx.postId,
      makeFileChangedEvent({ path: fc.relPath, change: fc.change, size: fc.size }),
    );
  };

  let result;
  try {
    // M7 XC-ISO: per-sandbox proc cap + 벽시계 타임아웃. cap 키는 격리 루트(샌드박스당 유일).
    result = await executeTool(ctx.sandboxRoot, req, onChunk, onFileChange, {
      sandboxId: ctx.sandboxRoot,
    });
  } catch {
    // toolExec 가 던지는 예외(예상 외)는 FAILED 로 흡수.
    result = { status: 'FAILED' as const, exitCode: 1, result: 'tool execution error' };
  }

  // 누적 청크가 모두 반영될 때까지 대기(tool.output 순서/누적 보존).
  await appendChain;

  // c. 종료 확정 + tool.result.
  await finalizeToolCall(toolCallId, {
    status: result.status,
    exitCode: result.exitCode,
    result: result.result,
  });

  // LLM 되먹임용 출력: 명시 result 우선, 없으면 누적 청크, 그것도 없으면 상태 문구.
  const output =
    (result.result && result.result.length > 0
      ? result.result
      : outputBuf) || (result.status === 'SUCCEEDED' ? 'ok' : 'failed');
  return {
    toolCallId,
    ok: result.status === 'SUCCEEDED',
    output: output.slice(0, TOOL_OUTPUT_CAP),
  };
}
