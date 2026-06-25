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
import { executeTool, type ToolExecRequest } from './toolExec.js';
import type { ToolIntent } from './pi.js';
import type { ToolKindValue } from '../realtime/events.js';

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

/**
 * 하나의 도구 의도를 끝까지 처리한다(create → exec(streaming) → finalize).
 * 도구 실행 자체가 실패해도 throw 하지 않고 ToolCall 을 FAILED 로 마감한다(턴은 계속 진행).
 * @returns 생성된 toolCallId(진단/테스트용).
 */
export async function runToolIntent(
  ctx: ToolBridgeContext,
  intent: ToolIntent,
): Promise<string> {
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
  const onChunk = (chunk: string): void => {
    appendChain = appendChain.then(() => appendToolOutput(toolCallId, chunk));
  };

  let result;
  try {
    result = await executeTool(ctx.sandboxRoot, req, onChunk);
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

  return toolCallId;
}
