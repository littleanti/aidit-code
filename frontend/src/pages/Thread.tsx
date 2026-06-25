// src/pages/Thread.tsx
// M4: live collaborative agent-session thread.
// Loads the post + initial messages, starts/attaches a session, mounts the SSE
// stream, and renders the bubble list + Composer + sandbox/session status.
// Mobile-first; touch targets >=44px. Uses ONLY term-* tokens; labels via t().
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { getPost, getMessages, startSession, ApiError } from '../api/rest';
import { relativeTime } from '../lib/time';
import StatusBadge from '../components/StatusBadge';
import ChatBubble from '../components/ChatBubble';
import Composer from '../components/Composer';
import { useThreadStream } from '../stream/useThreadStream';
import { useThreadStore } from '../stores/threadStore';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import type { Post } from '../api/types';

export default function Thread() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const token = useAuthStore((s) => s.token);
  const openLogin = useUiStore((s) => s.openLogin);

  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingSession, setStartingSession] = useState(false);

  const hydrate = useThreadStore((s) => s.hydrate);
  const reset = useThreadStore((s) => s.reset);
  const setActiveSession = useThreadStore((s) => s.setActiveSession);
  const messages = useThreadStore((s) => s.messages);
  const activeSession = useThreadStore((s) => s.activeSession);
  const sandboxStatus = useThreadStore((s) => s.sandboxStatus);

  const { status: streamStatus } = useThreadStream(id);

  const bottomRef = useRef<HTMLDivElement>(null);

  // Load post + initial messages, then hydrate the store (seq-ascending).
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [p, page] = await Promise.all([getPost(id), getMessages(id)]);
      setPost(p);
      hydrate({
        messages: page.items,
        session: p.session ?? null,
        sandboxStatus: p.sandbox?.status ?? null,
      });
    } catch (e) {
      setError(e instanceof ApiError ? t('errors.generic') : t('errors.networkError'));
    } finally {
      setLoading(false);
    }
  }, [id, t, hydrate]);

  useEffect(() => {
    load();
    return () => reset();
  }, [load, reset]);

  // Auto-scroll to the newest bubble as messages/tokens arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const handleStartSession = useCallback(async () => {
    if (!id) return;
    if (!token) {
      openLogin();
      return;
    }
    setStartingSession(true);
    setError(null);
    try {
      const { session } = await startSession(id);
      setActiveSession(session);
    } catch (e) {
      setError(e instanceof ApiError ? t('errors.sessionFailed') : t('errors.networkError'));
    } finally {
      setStartingSession(false);
    }
  }, [id, token, openLogin, setActiveSession, t]);

  const sessionActive =
    !!activeSession &&
    activeSession.status !== 'STOPPED' &&
    activeSession.status !== 'ERROR';

  return (
    <div className="flex flex-col" style={{ minHeight: 'calc(100vh - 7rem)' }}>
      {/* Header: back + sandbox badge + reconnect indicator */}
      <div className="mb-3 flex items-center gap-2">
        <Link
          to="/"
          aria-label={t('common.back')}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center font-mono text-term-dim hover:text-term-fg-bright"
        >
          ‹
        </Link>
        <StatusBadge status={sandboxStatus ?? post?.sandbox?.status} />
        {streamStatus === 'reconnecting' && (
          <span className="font-mono text-[10px] tracking-wider text-term-dim" role="status">
            ⟳ {t('thread.reconnecting')}
          </span>
        )}
        {sessionActive && (
          <span className="ml-auto font-mono text-[10px] tracking-wider text-term-amber">
            ● {t('thread.sessionRunning')}
          </span>
        )}
      </div>

      {loading && (
        <p className="py-8 text-center font-mono text-sm text-term-dim">
          ⟳ {t('common.loading')}
        </p>
      )}

      {error && (
        <p className="py-3 text-center font-mono text-sm text-term-red" role="alert">
          {error}
        </p>
      )}

      {post && (
        <>
          {/* Original post */}
          <article className="mb-3 rounded-[3px] border border-term-line bg-term-panel p-4">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-term-faint">
              📌 {t('post.originalPost')}
            </div>
            <h1 className="mb-2 font-mono text-lg text-term-fg-bright">{post.title}</h1>
            <div className="mb-3 font-mono text-xs text-term-dim">
              {post.author?.username ?? ''} · {relativeTime(post.createdAt)}
            </div>
            <p className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-term-fg">
              {post.body}
            </p>
          </article>

          {/* Start-session affordance when no active session */}
          {!sessionActive && (
            <div className="mb-3 flex justify-center">
              <button
                type="button"
                onClick={handleStartSession}
                disabled={startingSession}
                className="min-h-[44px] rounded-[3px] border border-term-amber-line px-4 font-mono text-sm text-term-amber disabled:opacity-50"
              >
                {startingSession ? t('thread.startingSession') : t('thread.startSession')}
              </button>
            </div>
          )}

          {/* Bubble list */}
          <div className="flex flex-1 flex-col gap-2 pb-2">
            {messages.length === 0 ? (
              <p className="py-6 text-center font-mono text-xs text-term-dim">
                {t('thread.empty')}
              </p>
            ) : (
              messages.map((m) => (
                <ChatBubble
                  key={m.id}
                  message={m}
                  // Known author name only for the post author's own messages;
                  // other participants' names aren't loaded in this M4 cut.
                  authorName={
                    m.type === 'HUMAN' && m.authorId === post.authorId
                      ? post.author?.username
                      : undefined
                  }
                />
              ))
            )}
            <div ref={bottomRef} />
          </div>

          {/* Composer pinned at the bottom of the column */}
          <div className="sticky bottom-0">
            <Composer postId={post.id} />
          </div>
        </>
      )}
    </div>
  );
}
