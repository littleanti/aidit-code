// ───────────────────────────────────────────────────────────
// Aidit-Code frontend API contract (DTOs).
// Mirrors docs/TRD.md §3 (Prisma schema) + §4 (REST contracts).
//
// HARD RULE: NO LLM key fields anywhere. There is no apiKey / baseURL /
// model-secret field in any DTO. LLM keys live ONLY in the backend .env
// and are never sent to, stored by, or rendered in the client.
// ───────────────────────────────────────────────────────────

// ── Enums (string unions mirroring Prisma enums, TRD §3) ──

/** Sandbox.status — TRD §3 SandboxStatus. */
export type SandboxStatus =
  | 'CREATING'
  | 'READY'
  | 'RUNNING'
  | 'SUSPENDED'
  | 'ERROR';

/** AgentSession.status — TRD §3 AgentSessionStatus. */
export type AgentSessionStatus =
  | 'STARTING'
  | 'IDLE'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'STOPPED'
  | 'ERROR';

/** Message.type — TRD §3 MessageType. Drives bubble rendering. */
export type MessageType =
  | 'HUMAN'
  | 'AGENT_REPLY'
  | 'TOOL_CALL'
  | 'TOOL_RESULT'
  | 'SYSTEM';

/** Message.status — TRD §3 MessageStatus. */
export type MessageStatus = 'PENDING' | 'STREAMING' | 'COMPLETE' | 'FAILED';

/** ToolCall.status — TRD §3 ToolCallStatus. */
export type ToolCallStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/** ToolCall.kind — TRD §3 ToolKind. */
export type ToolKind =
  | 'SHELL'
  | 'FILE_WRITE'
  | 'FILE_DELETE'
  | 'FILE_READ'
  | 'PACKAGE'
  | 'OTHER';

// ── Auth (TRD §4: /auth/register · /auth/session · /auth/guest) ──

/** Returned by all auth endpoints. Client persists token + username only. */
export interface AuthResult {
  id: string;
  token: string;
  username: string;
}

// ── User (TRD §3 User; no key fields) ──

export interface User {
  id: string;
  username: string;
  createdAt: string; // ISO-8601
}

// ── Sandbox (TRD §3; 1:1 with Post). No path secrets exposed beyond status/runtime. ──

export interface Sandbox {
  id: string;
  status: SandboxStatus;
  runtime: string; // runtime identifier, e.g. "pi"
}

// ── AgentSession summary (TRD §3/§4 GET /posts/:id). No key fields. ──

export interface AgentSession {
  id: string;
  status: AgentSessionStatus;
  model: string; // active model name only — never a key
}

// ── ToolCall (TRD §3; linked to TOOL_CALL/TOOL_RESULT bubbles 1:1) ──

export interface ToolCall {
  id: string;
  kind: ToolKind;
  name: string; // e.g. "bash", "write_file"
  args: string; // JSON-serialized args (command string / paths)
  result: string | null; // stdout/stderr/summary (accumulated)
  exitCode: number | null;
  status: ToolCallStatus;
  startedAt: string;
  endedAt: string | null;
}

// ── Message (=bubble, TRD §3). seq is the single sort/replay SoT. ──

export interface Message {
  id: string;
  postId: string;
  sessionId: string | null;
  authorId: string | null; // human = userId; AGENT/TOOL/SYSTEM = null
  type: MessageType;
  status: MessageStatus;
  body: string;
  // 첨부 이미지의 정적 경로(/uploads/<uuid>.<ext>). 없으면 null/undefined.
  // (Feature A) 서버 직렬화가 항상 동봉; SSE message.created 페이로드에는 없으므로
  // 낙관 행은 localImagePreview(objectURL)로 즉시 표시 후 REST reconcile 로 정정.
  imageUrl?: string | null;
  // 낙관 전용: 업로드 완료 전 로컬 미리보기 objectURL(서버/스토어로는 절대 전송 안 함).
  localImagePreview?: string | null;
  replyToId: string | null;
  toolCallId: string | null;
  toolCall?: ToolCall | null; // linked summary when present
  seq: number; // monotonic per-post sort key
  clientId: string | null; // human-send idempotency key
  createdAt: string;
}

// ── Post (TRD §3/§4 feed card). Includes sandbox status summary. ──

export interface Post {
  id: string;
  authorId: string;
  author?: User;
  title: string;
  body: string;
  score: number;
  commentCount: number;
  hotScore: number;
  createdAt: string;
  sandbox: Sandbox | null; // status summary for the card badge
  session?: AgentSession | null; // active session summary (GET /posts/:id)
  voted?: boolean; // computed when optionally authenticated
  bookmarked?: boolean;
}

// ── Cursor-paginated feed envelope (TRD §4.2) ──

export interface PostsPage {
  items: Post[];
  nextCursor: string | null;
}

// ── Workspace files (TRD §4 GET /posts/:id/files · /files/content). No key fields. ──

/** Directory entry from GET /posts/:id/files?path= (path is root-relative). */
export interface FileEntry {
  name: string;
  path: string; // root-relative path within the sandbox
  type: 'file' | 'dir';
  size?: number;
}

/**
 * Single-file payload from GET /posts/:id/files/content?path=.
 * Binary files are rejected with a meta-only response (binary:true, no content);
 * large files are truncated (truncated:true) carrying a prefix of the content.
 */
export interface FileContent {
  path: string; // root-relative
  size: number;
  content?: string; // omitted when binary
  binary?: boolean;
  truncated?: boolean;
}

// ── Runtime read-only info (TRD §4 GET /runtime). NEVER includes a key. ──
// Field name mirrors the backend payload exactly (getPublicRuntimeInfo →
// { model, baseURLHost }). Host only — never the full key/url with secrets.

export interface RuntimeInfo {
  model: string; // active model name
  baseURLHost?: string; // host only — never the full key/url with secrets
}

// ── Messages page (TRD §4 GET /posts/:id/messages?afterSeq=). seq ascending. ──

export interface MessagesPage {
  items: Message[];
}

// ───────────────────────────────────────────────────────────
// SSE event payloads (TRD §7 event table — shapes FROZEN/verbatim).
// HARD RULE: agent.token deltas carry agent TEXT only — never a key.
// No payload here contains apiKey / baseURL / model-secret fields.
// ───────────────────────────────────────────────────────────

/** message.created — new bubble. seq is the sort/replay key. */
export interface MessageCreatedPayload {
  message: {
    id: string;
    type: MessageType;
    status: MessageStatus;
    body: string;
    authorId: string | null;
    seq: number;
    replyToId: string | null;
    toolCallId: string | null;
    createdAt: string;
  };
}

/** agent.token — AGENT_REPLY token stream; accumulate delta into message.body. */
export interface AgentTokenPayload {
  messageId: string;
  seq: number;
  delta: string;
}

/** message.updated — finalize bubble body/status. */
export interface MessageUpdatedPayload {
  id: string;
  body: string;
  status: MessageStatus;
}

/** session.status — agent session lifecycle change. */
export interface SessionStatusPayload {
  sessionId: string;
  status: AgentSessionStatus;
}

/** sandbox.status — sandbox lifecycle change. */
export interface SandboxStatusPayload {
  sandboxId: string;
  status: SandboxStatus;
  lastActiveAt?: string;
}

/** tool.call — M5; tolerated now. */
export interface ToolCallPayload {
  toolCallId: string;
  messageId: string;
  kind: ToolKind;
  name: string;
  args: string;
  status: 'RUNNING';
  startedAt: string;
}

/** tool.output — M5; tolerated now. */
export interface ToolOutputPayload {
  toolCallId: string;
  messageId: string;
  chunk: string;
}

/** tool.result — M5; tolerated now. */
export interface ToolResultPayload {
  toolCallId: string;
  messageId: string;
  status: 'SUCCEEDED' | 'FAILED';
  exitCode: number | null;
  result: string;
}

/** file.changed — M5; tolerated now. */
export interface FileChangedPayload {
  path: string;
  change: 'CREATED' | 'MODIFIED' | 'DELETED';
  size?: number;
}

/** Discriminated map of SSE event name → payload (TRD §7). */
export interface SseEventMap {
  'message.created': MessageCreatedPayload;
  'agent.token': AgentTokenPayload;
  'message.updated': MessageUpdatedPayload;
  'session.status': SessionStatusPayload;
  'sandbox.status': SandboxStatusPayload;
  'tool.call': ToolCallPayload;
  'tool.output': ToolOutputPayload;
  'tool.result': ToolResultPayload;
  'file.changed': FileChangedPayload;
}

export type SseEventName = keyof SseEventMap;
