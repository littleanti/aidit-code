// src/stream/useThreadStream.ts
// FE-STREAM (M4): subscribe to GET /posts/:id/stream (SSE) and apply events to
// the threadStore. seq is the single source of truth — replayed events (after
// EventSource auto-reconnect sends Last-Event-ID) dedupe via seq/id in the store.
//
// Handles: message.created / agent.token / message.updated.
// Tolerates (no crash) future events: session.status / sandbox.status /
// tool.call / tool.output / tool.result / file.changed.
//
// HARD RULE: payloads never carry LLM keys; agent.token deltas are agent text only.
import { useEffect, useRef, useState } from 'react';
import { useThreadStore } from '../stores/threadStore';
import type {
  AgentTokenPayload,
  Message,
  MessageCreatedPayload,
  MessageUpdatedPayload,
  SandboxStatusPayload,
  SessionStatusPayload,
} from '../api/types';

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseThreadStreamResult {
  status: StreamStatus;
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Map a message.created payload (which lacks postId/sessionId/clientId) onto the
 * full Message shape the store holds. Missing relational fields default to null;
 * reconcileByClientId merges any optimistic row's clientId when ids differ.
 */
function toMessage(p: MessageCreatedPayload['message']): Message {
  return {
    id: p.id,
    postId: '', // not carried by the event; store keys by id/seq, not postId
    sessionId: null,
    authorId: p.authorId,
    type: p.type,
    status: p.status,
    body: p.body,
    replyToId: p.replyToId,
    toolCallId: p.toolCallId,
    seq: p.seq,
    clientId: null,
    createdAt: p.createdAt,
  };
}

/**
 * EventSource subscription for a post's live thread. Cleans up on unmount and
 * whenever postId changes. Tracks last seq purely for observability — the actual
 * replay-dedupe is enforced by the store (by id and by seq).
 */
export function useThreadStream(postId: string | undefined): UseThreadStreamResult {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const lastSeqRef = useRef<number>(-1);

  // Pull stable action references once (zustand actions are stable identities).
  const upsertMessage = useThreadStore((s) => s.upsertMessage);
  const appendToken = useThreadStore((s) => s.appendToken);
  const setMessageStatus = useThreadStore((s) => s.setMessageStatus);
  const setSessionStatus = useThreadStore((s) => s.setSessionStatus);
  const setSandboxStatus = useThreadStore((s) => s.setSandboxStatus);

  useEffect(() => {
    if (!postId) {
      setStatus('closed');
      return;
    }

    let closed = false;
    setStatus('connecting');

    const url = `/posts/${encodeURIComponent(postId)}/stream`;
    const es = new EventSource(url, { withCredentials: false });

    const trackSeq = (seq: number | undefined) => {
      if (typeof seq === 'number' && seq > lastSeqRef.current) lastSeqRef.current = seq;
    };

    es.onopen = () => {
      if (!closed) setStatus('open');
    };

    es.onerror = () => {
      // EventSource auto-reconnects (resending Last-Event-ID). Surface reconnecting
      // unless the connection has been permanently closed.
      if (closed) return;
      setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };

    // ── handled events ──────────────────────────────────────────
    es.addEventListener('message.created', (ev) => {
      const p = safeParse<MessageCreatedPayload>((ev as MessageEvent).data);
      if (!p?.message) return;
      const msg = toMessage(p.message);
      trackSeq(msg.seq);
      // Upsert (dedupe by id/seq handles replay after reconnect). Optimistic
      // HUMAN rows are reconciled by the Composer via the REST response's
      // clientId, since the SSE message.created payload does not carry clientId.
      upsertMessage(msg);
    });

    es.addEventListener('agent.token', (ev) => {
      const p = safeParse<AgentTokenPayload>((ev as MessageEvent).data);
      if (!p?.messageId) return;
      trackSeq(p.seq);
      appendToken(p.messageId, p.delta ?? '');
    });

    es.addEventListener('message.updated', (ev) => {
      const p = safeParse<MessageUpdatedPayload>((ev as MessageEvent).data);
      if (!p?.id) return;
      setMessageStatus(p.id, p.status, p.body);
    });

    // ── tolerated events (no crash; minimal handling) ───────────
    es.addEventListener('session.status', (ev) => {
      const p = safeParse<SessionStatusPayload>((ev as MessageEvent).data);
      if (p?.status) setSessionStatus(p.status);
    });

    es.addEventListener('sandbox.status', (ev) => {
      const p = safeParse<SandboxStatusPayload>((ev as MessageEvent).data);
      if (p?.status) setSandboxStatus(p.status);
    });

    // tool.* and file.changed are M5 — register no-op listeners so unknown
    // future events never bubble as errors. (EventSource ignores unregistered
    // named events anyway, but explicit no-ops document intent.)
    const noop = () => {};
    es.addEventListener('tool.call', noop);
    es.addEventListener('tool.output', noop);
    es.addEventListener('tool.result', noop);
    es.addEventListener('file.changed', noop);

    return () => {
      closed = true;
      es.close();
      setStatus('closed');
    };
  }, [
    postId,
    upsertMessage,
    appendToken,
    setMessageStatus,
    setSessionStatus,
    setSandboxStatus,
  ]);

  return { status };
}
