// backend/src/realtime/events.ts
// 실시간 이벤트 스키마(TRD §7). post 채널로 fan-out 되는 모든 이벤트의 타입 단일 출처.
//
// 보안(TRD §8, CLAUDE.md): 이벤트 payload 는 LLM 키(apiKey/baseURL) 를 절대 담지 않는다.
//   - 클라이언트가 받는 것은 상태/토큰/툴/파일 변경뿐. 키 관련 필드를 추가하지 말 것.
//
// 확장 설계(M3~M6): RealtimeEvent 는 `type` 으로 판별하는 discriminated union 이다.
//   message.*, agent.token, tool.*, file.changed, session.status 는 후속 마일스톤에서
//   아래 union 에 멤버를 추가하기만 하면 된다(기존 멤버 변경 없이). M2 는 sandbox.status 만 필수.

/** TRD §3 SandboxStatus 와 1:1 (Prisma enum 과 동일 문자열). */
export type SandboxStatusValue =
  | 'CREATING'
  | 'READY'
  | 'RUNNING'
  | 'SUSPENDED'
  | 'ERROR';

/**
 * 샌드박스 상태 변화 이벤트(TRD §7).
 * payload: { sandboxId, status, lastActiveAt }. 키 필드 금지.
 */
export interface SandboxStatusEvent {
  type: 'sandbox.status';
  sandboxId: string;
  status: SandboxStatusValue;
  /** ISO8601 문자열(직렬화 안전). */
  lastActiveAt: string;
}

/** TRD §3 AgentSessionStatus 와 1:1 (Prisma enum 과 동일 문자열). */
export type AgentSessionStatusValue =
  | 'STARTING'
  | 'IDLE'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'STOPPED'
  | 'ERROR';

/**
 * 에이전트 세션 상태 변화 이벤트(TRD §7).
 * payload: { sessionId, status }. 키 필드 금지(apiKey/baseURL 등 절대 미포함).
 */
export interface SessionStatusEvent {
  type: 'session.status';
  sessionId: string;
  status: AgentSessionStatusValue;
}

/** TRD §3 MessageType 와 1:1 (Prisma enum 과 동일 문자열). */
export type MessageTypeValue =
  | 'HUMAN'
  | 'AGENT_REPLY'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'SYSTEM';

/** TRD §3 MessageStatus 와 1:1 (Prisma enum 과 동일 문자열). */
export type MessageStatusValue =
  | 'PENDING'
  | 'STREAMING'
  | 'COMPLETE'
  | 'FAILED';

/**
 * message.created 이벤트의 message payload(TRD §7, verbatim).
 * 키 필드 금지. createdAt 은 직렬화 안전한 ISO 문자열.
 */
export interface MessageCreatedPayload {
  id: string;
  type: MessageTypeValue;
  status: MessageStatusValue;
  body: string;
  authorId: string | null;
  seq: number;
  replyToId: string | null;
  toolCallId: string | null;
  createdAt: string;
}

/**
 * 새 버블 생성 이벤트(TRD §7).
 * payload: { message: { id, type, status, body, authorId, seq, replyToId, toolCallId, createdAt } }.
 */
export interface MessageCreatedEvent {
  type: 'message.created';
  message: MessageCreatedPayload;
}

/**
 * 에이전트 답변 토큰 스트림 이벤트(TRD §7).
 * payload: { messageId, seq, delta }. delta 는 에이전트 텍스트 조각만 — 키 절대 미포함.
 */
export interface AgentTokenEvent {
  type: 'agent.token';
  messageId: string;
  seq: number;
  delta: string;
}

/**
 * 버블 상태/본문 확정 이벤트(TRD §7).
 * payload: { id, body, status }. AGENT_REPLY STREAMING→COMPLETE/FAILED, 인터럽트 확정 등.
 */
export interface MessageUpdatedEvent {
  type: 'message.updated';
  id: string;
  body: string;
  status: MessageStatusValue;
}

/** TRD §3 ToolKind 와 1:1 (Prisma enum 과 동일 문자열). */
export type ToolKindValue =
  | 'SHELL'
  | 'FILE_WRITE'
  | 'FILE_DELETE'
  | 'FILE_READ'
  | 'PACKAGE'
  | 'OTHER';

/** TRD §3 ToolCallStatus 와 1:1 (Prisma enum 과 동일 문자열). */
export type ToolCallStatusValue = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/**
 * 도구 호출 시작 이벤트(TRD §7 tool.call).
 * payload(verbatim): { toolCallId, messageId, kind, name, args, status:'RUNNING', startedAt }.
 * messageId 는 연결된 TOOL_CALL 버블 id. args 는 JSON 직렬화 문자열(경로/명령 등) — 키 필드 금지.
 * 보안: apiKey/baseURL 류는 args/name/result 어디에도 절대 담지 않는다(toolBridge 가 보장).
 */
export interface ToolCallEvent {
  type: 'tool.call';
  toolCallId: string;
  messageId: string;
  kind: ToolKindValue;
  name: string;
  /** JSON 직렬화된 인자 문자열(명령/경로 등). 키 절대 미포함. */
  args: string;
  status: 'RUNNING';
  /** ISO8601 문자열(직렬화 안전). */
  startedAt: string;
}

/**
 * 도구 출력 청크 이벤트(TRD §7 tool.output).
 * payload(verbatim): { toolCallId, messageId, chunk }.
 * messageId 는 출력이 누적되는 TOOL_RESULT 버블 id. chunk 는 stdout/stderr 조각 — 키 절대 미포함.
 */
export interface ToolOutputEvent {
  type: 'tool.output';
  toolCallId: string;
  messageId: string;
  chunk: string;
}

/**
 * 도구 호출 종료 이벤트(TRD §7 tool.result).
 * payload(verbatim): { toolCallId, messageId, status:'SUCCEEDED'|'FAILED', exitCode, result }.
 * messageId 는 TOOL_RESULT 버블 id. result 는 누적 출력/요약 — 키 절대 미포함.
 */
export interface ToolResultEvent {
  type: 'tool.result';
  toolCallId: string;
  messageId: string;
  status: 'SUCCEEDED' | 'FAILED';
  exitCode: number | null;
  result: string;
}

/**
 * 모든 실시간 이벤트의 discriminated union.
 * M2: sandbox.status. M3: + session.status. M4: + message.created/agent.token/message.updated.
 * M5: + tool.call/tool.output/tool.result. file.changed(M6) 는 후속에서 멤버만 추가한다.
 */
export type RealtimeEvent =
  | SandboxStatusEvent
  | SessionStatusEvent
  | MessageCreatedEvent
  | AgentTokenEvent
  | MessageUpdatedEvent
  | ToolCallEvent
  | ToolOutputEvent
  | ToolResultEvent;

/**
 * sandbox.status 이벤트 빌더.
 * lastActiveAt 은 Date | string 모두 받아 ISO 문자열로 정규화한다.
 * 키 같은 부가 필드는 받지 않음으로써 누출 가능성을 구조적으로 차단한다.
 */
export function makeSandboxStatusEvent(args: {
  sandboxId: string;
  status: SandboxStatusValue;
  lastActiveAt: Date | string;
}): SandboxStatusEvent {
  const { sandboxId, status, lastActiveAt } = args;
  return {
    type: 'sandbox.status',
    sandboxId,
    status,
    lastActiveAt:
      lastActiveAt instanceof Date ? lastActiveAt.toISOString() : lastActiveAt,
  };
}

/**
 * session.status 이벤트 빌더(TRD §7).
 * sessionId + status 만 받음으로써 키 누출 가능성을 구조적으로 차단한다.
 */
export function makeSessionStatusEvent(args: {
  sessionId: string;
  status: AgentSessionStatusValue;
}): SessionStatusEvent {
  const { sessionId, status } = args;
  return {
    type: 'session.status',
    sessionId,
    status,
  };
}

/**
 * message.created 이벤트 빌더(TRD §7).
 * createdAt 은 Date | string 모두 받아 ISO 문자열로 정규화한다.
 * payload 는 명시 필드만 받음으로써 키 누출 가능성을 구조적으로 차단한다.
 */
export function makeMessageCreatedEvent(args: {
  id: string;
  type: MessageTypeValue;
  status: MessageStatusValue;
  body: string;
  authorId: string | null;
  seq: number;
  replyToId: string | null;
  toolCallId: string | null;
  createdAt: Date | string;
}): MessageCreatedEvent {
  const { createdAt, ...rest } = args;
  return {
    type: 'message.created',
    message: {
      ...rest,
      createdAt:
        createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    },
  };
}

/**
 * agent.token 이벤트 빌더(TRD §7).
 * delta 는 에이전트 텍스트 조각만 — 호출부가 키를 넣지 않도록 한다.
 */
export function makeAgentTokenEvent(args: {
  messageId: string;
  seq: number;
  delta: string;
}): AgentTokenEvent {
  const { messageId, seq, delta } = args;
  return { type: 'agent.token', messageId, seq, delta };
}

/**
 * message.updated 이벤트 빌더(TRD §7).
 * id + body + status 만 받음으로써 키 누출 가능성을 구조적으로 차단한다.
 */
export function makeMessageUpdatedEvent(args: {
  id: string;
  body: string;
  status: MessageStatusValue;
}): MessageUpdatedEvent {
  const { id, body, status } = args;
  return { type: 'message.updated', id, body, status };
}

/**
 * tool.call 이벤트 빌더(TRD §7).
 * startedAt 은 Date | string 모두 받아 ISO 문자열로 정규화한다.
 * 명시 필드만 받음으로써(키 필드 없음) 누출 가능성을 구조적으로 차단한다.
 */
export function makeToolCallEvent(args: {
  toolCallId: string;
  messageId: string;
  kind: ToolKindValue;
  name: string;
  args: string;
  startedAt: Date | string;
}): ToolCallEvent {
  const { toolCallId, messageId, kind, name, args: toolArgs, startedAt } = args;
  return {
    type: 'tool.call',
    toolCallId,
    messageId,
    kind,
    name,
    args: toolArgs,
    status: 'RUNNING',
    startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
  };
}

/**
 * tool.output 이벤트 빌더(TRD §7).
 * chunk 는 stdout/stderr 조각만 — 호출부가 키를 넣지 않도록 한다.
 */
export function makeToolOutputEvent(args: {
  toolCallId: string;
  messageId: string;
  chunk: string;
}): ToolOutputEvent {
  const { toolCallId, messageId, chunk } = args;
  return { type: 'tool.output', toolCallId, messageId, chunk };
}

/**
 * tool.result 이벤트 빌더(TRD §7).
 * 명시 필드만 받음으로써(키 필드 없음) 누출 가능성을 구조적으로 차단한다.
 */
export function makeToolResultEvent(args: {
  toolCallId: string;
  messageId: string;
  status: 'SUCCEEDED' | 'FAILED';
  exitCode: number | null;
  result: string;
}): ToolResultEvent {
  const { toolCallId, messageId, status, exitCode, result } = args;
  return { type: 'tool.result', toolCallId, messageId, status, exitCode, result };
}
