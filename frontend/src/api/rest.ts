// src/api/rest.ts
// Same-origin fetch client (dev: routed through the vite proxy → Fastify :3001).
// Bearer interceptor reads the token from authStore. Throws typed ApiError(status).
//
// HARD RULE: NO LLM key fields are ever sent, stored, or read here.
import { getAuthToken } from '../stores/authStore';
import type { AuthResult, Post, PostsPage, Sandbox } from './types';

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
    body: { username: nickname },
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

/** GET /posts/:id — post + meta (sandbox/session/voted/bookmarked). */
export function getPost(id: string): Promise<Post> {
  return request<Post>(`/posts/${encodeURIComponent(id)}`);
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
