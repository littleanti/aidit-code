// src/api/rest.ts
// Same-origin fetch client (dev: routed through the vite proxy → Fastify :3001).
// Bearer interceptor reads the token from authStore. Throws typed ApiError(status).
//
// HARD RULE: NO LLM key fields are ever sent, stored, or read here.
import { getAuthToken } from '../stores/authStore';
import type {
  AgentSession,
  AuthResult,
  FileContent,
  FileEntry,
  Message,
  MessagesPage,
  Post,
  PostsPage,
  RuntimeInfo,
  Sandbox,
} from './types';
import type { Lang } from '../stores/langStore';

/** Typed error carrying the HTTP status (or 0 for network failure). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export type PostSort = 'hot' | 'new';

/** per-message reasoning_effort(Feature B). 백엔드 화이트리스트와 일치. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * 상대 정적 경로(/uploads/<uuid>.<ext>)를 표시 가능한 URL 로 해석한다.
 * - dev: vite 프록시(/uploads → Fastify)로 동일 origin 이므로 상대경로를 그대로 둔다.
 * - prod: VITE_API_ORIGIN 이 설정되어 있으면 그 origin 을 prefix(별도 호스트 배포 대비),
 *   미설정이면 동일 origin 배포로 보고 상대경로 유지. 절대 URL(http/https/data)은 그대로 통과.
 * 보안: API origin 이 아닌 임의 호스트로의 재작성은 하지 않는다(자기-소유 /uploads 경로 전제).
 */
export function assetUrl(p: string | null | undefined): string {
  if (!p) return '';
  // 이미 절대(URL/스킴) 이거나 data: 면 그대로.
  if (/^(https?:)?\/\//i.test(p) || p.startsWith('data:') || p.startsWith('blob:')) return p;
  const origin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/+$/, '');
  if (!origin) return p; // 동일 origin(dev 프록시 포함) — 상대경로 유지.
  return `${origin}${p.startsWith('/') ? '' : '/'}${p}`;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** When true, attach the Authorization header if a token exists. Default true. */
  auth?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Network-level failure (no response). status 0.
    throw new ApiError(0, e instanceof Error ? e.message : 'network error');
  }

  // Parse JSON if present; tolerate empty bodies (204 etc.).
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : undefined) ?? `request failed (${res.status})`;
    throw new ApiError(res.status, msg, parsed);
  }

  return parsed as T;
}

// ── Auth (TRD §4) ──────────────────────────────────────────────

/** POST /auth/register — new member (username + password). */
export function register(username: string, password: string): Promise<AuthResult> {
  return request<AuthResult>('/auth/register', {
    method: 'POST',
    auth: false,
    body: { username, password },
  });
}

/** POST /auth/session — login (existing member). */
export function session(username: string, password: string): Promise<AuthResult> {
  return request<AuthResult>('/auth/session', {
    method: 'POST',
    auth: false,
    body: { username, password },
  });
}

/** POST /auth/guest — guest entry (nickname only, no '#'; server assigns #hex4). */
export function guest(nickname: string): Promise<AuthResult> {
  return request<AuthResult>('/auth/guest', {
    method: 'POST',
    auth: false,
    body: { nickname },
  });
}

/** POST /auth/refresh — sliding token renewal (requires Bearer). */
export function refresh(): Promise<AuthResult> {
  return request<AuthResult>('/auth/refresh', { method: 'POST' });
}

// ── Posts / feed (TRD §4) ──────────────────────────────────────

/** GET /posts?sort=&cursor= — home feed (optional auth → voted/bookmarked). */
export function getPosts(sort: PostSort, cursor?: string): Promise<PostsPage> {
  const qs = new URLSearchParams({ sort });
  if (cursor) qs.set('cursor', cursor);
  return request<PostsPage>(`/posts?${qs.toString()}`);
}

/**
 * GET /posts/:id — the backend returns an ENVELOPE
 * `{ post, sandbox, voted, bookmarked, activeSession }`, so unwrap it into a
 * single Post (merging the meta) for callers. Reading the envelope as a Post
 * directly leaves id/title/body undefined.
 */
export async function getPost(id: string): Promise<Post> {
  const env = await request<{
    post: Post;
    sandbox?: Sandbox | null;
    voted?: boolean;
    bookmarked?: boolean;
    activeSession?: AgentSession | null;
  }>(`/posts/${encodeURIComponent(id)}`);
  return {
    ...env.post,
    sandbox: env.sandbox ?? env.post.sandbox ?? null,
    session: env.activeSession ?? null,
    voted: env.voted,
    bookmarked: env.bookmarked,
  };
}

/**
 * POST /posts — create post (title, body) → { post, sandbox }. Requires Bearer.
 * opts(부모 Aidit 패리티, 동작은 Aidit-Code 매핑):
 *   - autoReply: "게시 후 AI 1차 답변 받기"(기본 ON). false 면 게시만 하고 자동 에이전트 턴 생략.
 *   - reasoningEffort: 자동 첫 턴의 작업 강도(낮음/중간/높음). autoReply ON 일 때만 의미.
 */
export function createPost(
  title: string,
  body: string,
  opts?: { autoReply?: boolean; reasoningEffort?: ReasoningEffort }
): Promise<{ post: Post; sandbox: Sandbox }> {
  return request<{ post: Post; sandbox: Sandbox }>('/posts', {
    method: 'POST',
    body: {
      title,
      body,
      ...(opts?.autoReply !== undefined ? { autoReply: opts.autoReply } : {}),
      ...(opts?.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    },
  });
}

/** PATCH /posts/:id — edit post (author only). Server returns `{ post }`; unwrap. */
export async function patchPost(
  id: string,
  body: { title?: string; body?: string }
): Promise<Post> {
  const env = await request<{ post: Post }>(`/posts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
  return env.post;
}

/** DELETE /posts/:id — delete post + sandbox dir (author only). */
export function deletePost(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Profile: user posts / bookmarks (TRD §4.2) ─────────────────
// HARD RULE: NO key fields are ever sent or read here. Cursor pagination only.

/**
 * GET /users/:id/posts?cursor= — a user's authored posts.
 * Ordered createdAt DESC, id DESC; cursor-anchored on the POST row (TRD §4.2).
 */
export function getUserPosts(userId: string, cursor?: string): Promise<PostsPage> {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  const tail = qs.toString();
  return request<PostsPage>(
    `/users/${encodeURIComponent(userId)}/posts${tail ? `?${tail}` : ''}`
  );
}

/**
 * GET /users/:id/bookmarks?cursor= — a user's bookmarked posts.
 * Ordered/anchored on the BOOKMARK row createdAt DESC, id DESC (TRD §4.2).
 */
export function getUserBookmarks(userId: string, cursor?: string): Promise<PostsPage> {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  const tail = qs.toString();
  return request<PostsPage>(
    `/users/${encodeURIComponent(userId)}/bookmarks${tail ? `?${tail}` : ''}`
  );
}

// ── Bookmarks (TRD §4.2 — idempotent) ──────────────────────────

/** POST /posts/:id/bookmark — idempotent add. */
export function bookmark(id: string): Promise<{ bookmarked: boolean }> {
  return request<{ bookmarked: boolean }>(`/posts/${encodeURIComponent(id)}/bookmark`, {
    method: 'POST',
  });
}

/** DELETE /posts/:id/bookmark — idempotent removal. */
export function unbookmark(id: string): Promise<{ bookmarked: boolean }> {
  return request<{ bookmarked: boolean }>(`/posts/${encodeURIComponent(id)}/bookmark`, {
    method: 'DELETE',
  });
}

// ── Runtime read-only info (TRD §4 GET /runtime) ───────────────
// HARD RULE: response is { model, baseURLHost } — NEVER a key/secret.

/** GET /runtime — public runtime info for the read-only Settings row. */
export function getRuntime(): Promise<RuntimeInfo> {
  return request<RuntimeInfo>('/runtime');
}

// ── Votes (TRD §4) ─────────────────────────────────────────────

export interface VoteResult {
  id: string;
  score: number;
  hotScore: number;
  voted: boolean;
}

/** POST /posts/:id/upvote — idempotent upsert. */
export function upvote(id: string): Promise<VoteResult> {
  return request<VoteResult>(`/posts/${encodeURIComponent(id)}/upvote`, { method: 'POST' });
}

/** DELETE /posts/:id/upvote — idempotent removal. */
export function unupvote(id: string): Promise<VoteResult> {
  return request<VoteResult>(`/posts/${encodeURIComponent(id)}/upvote`, { method: 'DELETE' });
}

// ── Thread: messages / session / interrupt (TRD §4 + §4.1) ─────
// HARD RULE: no key fields are ever sent or read here.

/**
 * GET /posts/:id/messages?afterSeq= — bubble pagination, seq ascending.
 * Linked toolCall summaries are included by the server when present.
 */
export function getMessages(postId: string, afterSeq?: number): Promise<MessagesPage> {
  const qs = new URLSearchParams();
  if (afterSeq !== undefined) qs.set('afterSeq', String(afterSeq));
  const tail = qs.toString();
  return request<MessagesPage>(
    `/posts/${encodeURIComponent(postId)}/messages${tail ? `?${tail}` : ''}`
  );
}

/**
 * POST /posts/:id/messages — send a HUMAN message (TRD §4.1).
 * Body { body, aiMode, clientId, lang? }. Server assigns seq + fans out via SSE.
 * The optional UI-language hint (TRD §14) steers the agent's reply language.
 * Returns the created HUMAN message (clientId idempotent).
 */
export function sendMessage(
  postId: string,
  payload: {
    body: string;
    aiMode: boolean;
    clientId: string;
    lang?: Lang;
    // Feature A: 첨부 이미지 정적 경로(uploadImage 가 반환한 /uploads/<uuid>.<ext>).
    imageUrl?: string | null;
    // Feature B: per-message reasoning_effort(aiMode 시 컴포저에서 선택, 기본 medium).
    reasoningEffort?: ReasoningEffort;
  }
): Promise<{ message: Message }> {
  return request<{ message: Message }>(`/posts/${encodeURIComponent(postId)}/messages`, {
    method: 'POST',
    body: payload,
  });
}

/**
 * POST /uploads — 메시지 컴포저용 이미지 업로드(Feature A, multipart, Bearer).
 * 단일 파일을 FormData 로 보내고 { imageUrl: '/uploads/<uuid>.<ext>' } 를 받는다.
 * 서버가 권위(UUID 파일명/MIME 화이트리스트/5MB 캡): 400(비이미지)·413(초과)은 ApiError 로.
 * HARD RULE: 키 필드는 어디에도 싣지 않는다(Authorization Bearer 만).
 */
export async function uploadImage(file: File): Promise<{ imageUrl: string }> {
  const form = new FormData();
  form.append('file', file);

  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Content-Type 은 설정하지 않는다 — 브라우저가 multipart boundary 를 자동 부여.

  let res: Response;
  try {
    res = await fetch('/uploads', { method: 'POST', headers, body: form });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : 'network error');
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : undefined) ?? `upload failed (${res.status})`;
    throw new ApiError(res.status, msg, parsed);
  }

  return parsed as { imageUrl: string };
}

// ── Workspace files (TRD §4) ───────────────────────────────────
// HARD RULE: no key fields are ever sent or read here.

/**
 * GET /posts/:id/files?path= — directory entries (root-relative).
 * Omitting path lists the sandbox root. Path escape ('..'/absolute/symlink) → 400.
 */
export async function getFiles(postId: string, path?: string): Promise<FileEntry[]> {
  const qs = new URLSearchParams();
  if (path) qs.set('path', path);
  const tail = qs.toString();
  // Backend returns an envelope { path, entries }, not a bare array — unwrap it.
  const res = await request<{ path: string; entries: FileEntry[] }>(
    `/posts/${encodeURIComponent(postId)}/files${tail ? `?${tail}` : ''}`
  );
  return res.entries ?? [];
}

/**
 * GET /posts/:id/files/content?path= — single file content (root-relative).
 * Binary files come back meta-only (binary:true); large files are truncated.
 */
export function getFileContent(postId: string, path: string): Promise<FileContent> {
  const qs = new URLSearchParams({ path });
  return request<FileContent>(
    `/posts/${encodeURIComponent(postId)}/files/content?${qs.toString()}`
  );
}

/** POST /posts/:id/session — start/attach the agent session. */
export function startSession(postId: string): Promise<{ session: AgentSession }> {
  return request<{ session: AgentSession }>(`/posts/${encodeURIComponent(postId)}/session`, {
    method: 'POST',
  });
}

/** POST /posts/:id/session/suspend — stop/suspend the agent session (session STOPPED, sandbox SUSPENDED). */
export function suspendSession(postId: string): Promise<{ session: AgentSession }> {
  return request<{ session: AgentSession }>(
    `/posts/${encodeURIComponent(postId)}/session/suspend`,
    { method: 'POST' }
  );
}

/**
 * POST /posts/:id/interrupt — interrupt/steer the current agent turn.
 * Optional `steer` text is sent as the body when provided.
 */
export function interrupt(postId: string, steer?: string): Promise<void> {
  return request<void>(`/posts/${encodeURIComponent(postId)}/interrupt`, {
    method: 'POST',
    body: steer ? { steer } : undefined,
  });
}
