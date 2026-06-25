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

/** POST /posts — create post (title, body) → { post, sandbox }. Requires Bearer. */
export function createPost(
  title: string,
  body: string
): Promise<{ post: Post; sandbox: Sandbox }> {
  return request<{ post: Post; sandbox: Sandbox }>('/posts', {
    method: 'POST',
    body: { title, body },
  });
}

/** PATCH /posts/:id — edit post (author only). */
export function patchPost(id: string, body: { title?: string; body?: string }): Promise<Post> {
  return request<Post>(`/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body });
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
  payload: { body: string; aiMode: boolean; clientId: string; lang?: Lang }
): Promise<{ message: Message }> {
  return request<{ message: Message }>(`/posts/${encodeURIComponent(postId)}/messages`, {
    method: 'POST',
    body: payload,
  });
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
