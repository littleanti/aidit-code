// src/pages/Thread.tsx
// M4: live collaborative agent-session thread.
// Loads the post + initial messages, starts/attaches a session, mounts the SSE
// stream, and renders the bubble list + Composer + sandbox/session status.
// Mobile-first; touch targets >=44px. Uses ONLY term-* tokens; labels via t().
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { getPost, getMessages, startSession, deletePost, ApiError } from '../api/rest';
import { relativeTime } from '../lib/time';
import StatusBadge from '../components/StatusBadge';
import ChatBubble from '../components/ChatBubble';
import Composer from '../components/Composer';
import FileTree from '../components/FileTree';
import FileView from '../components/FileView';
import { useThreadStream } from '../stream/useThreadStream';
import ReconnectBanner from '../components/states/ReconnectBanner';
import { errorKeyForSandbox, errorKeyForSession } from '../i18n/serverError';
import { useThreadStore } from '../stores/threadStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import type { Post } from '../api/types';

type WorkspaceTab = 'chat' | 'files';

export default function Thread() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const userId = useAuthStore((s) => s.userId);
  const openLogin = useUiStore((s) => s.openLogin);

  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingSession, setStartingSession] = useState(false);
  const [tab, setTab] = useState<WorkspaceTab>('chat');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const hydrate = useThreadStore((s) => s.hydrate);
  const reset = useThreadStore((s) => s.reset);
  const setActiveSession = useThreadStore((s) => s.setActiveSession);
  const messages = useThreadStore((s) => s.messages);
  const activeSession = useThreadStore((s) => s.activeSession);
  const sandboxStatus = useThreadStore((s) => s.sandboxStatus);

  const selectedPath = useWorkspaceStore((s) => s.selectedPath);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const resetWorkspace = useWorkspaceStore((s) => s.reset);

  const { status: streamStatus } = useThreadStream(id);

  const bottomRef = useRef<HTMLDivElement>(null);
  // Auto-scroll bookkeeping: stay "pinned" to the bottom unless the user
  // scrolls up to read history; the user's own new message always re-pins.
  // Start UNPINNED so entering a post lands at the TOP (📌 original post +
  // start of the conversation) instead of jumping to the bottom; the scroll
  // listener re-pins the moment the user scrolls within 120px of the bottom.
  const pinnedRef = useRef(false);
  const prevLastIdRef = useRef<string | null>(null);
  // One-shot guard: skip only the very first messages-driven scroll for a
  // thread (the initial hydrate), so live-follow still works afterwards.
  const hasAutoScrolledRef = useRef(false);
  // Lazy auto-attach guard: fire the entry auto-attach at most ONCE per thread
  // (id). React StrictMode double-invokes effects in dev and re-renders can
  // re-run it; this ref dedupes so we never call startSession twice on entry.
  // Reset on id change (the id-scoped effect below).
  const autoAttachedRef = useRef(false);

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
      // Seed the "last seen" id with the last hydrated message so the first
      // genuine change after entry is correctly detected as a NEW bubble (and
      // not as the initial render). The hasAutoScrolledRef guard below still
      // suppresses the very first messages-driven scroll regardless.
      prevLastIdRef.current = page.items[page.items.length - 1]?.id ?? null;
    } catch (e) {
      setError(e instanceof ApiError ? t('errors.generic') : t('errors.networkError'));
    } finally {
      setLoading(false);
    }
  }, [id, t, hydrate]);

  useEffect(() => {
    load();
    return () => {
      reset();
      resetWorkspace();
    };
  }, [load, reset, resetWorkspace]);

  // On entry / thread switch: reset the auto-scroll guards and land the window
  // at the TOP (the route may have retained scroll from a previous page) so the
  // reader starts at the 📌 original post, not wherever they last were.
  useEffect(() => {
    pinnedRef.current = false;
    hasAutoScrolledRef.current = false;
    prevLastIdRef.current = null;
    autoAttachedRef.current = false; // re-arm the entry auto-attach for the new thread
    window.scrollTo(0, 0);
  }, [id]);

  // Selecting a file from the tree switches to the file view on mobile.
  const handleSelectFile = useCallback(
    (path: string) => {
      selectFile(path);
    },
    [selectFile]
  );

  // Track whether the user is parked near the bottom (window scroll). When they
  // scroll up to read history we stop yanking them down on every new token.
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      pinnedRef.current =
        window.innerHeight + window.scrollY >= doc.scrollHeight - 120;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll to the newest bubble as messages/tokens arrive. The user's own
  // freshly-sent message always re-pins and follows; streaming tokens follow
  // only while pinned (instant), brand-new bubbles ease in (smooth).
  useEffect(() => {
    const last = messages[messages.length - 1];
    const lastId = last?.id ?? null;
    const isNewBubble = lastId !== prevLastIdRef.current;
    prevLastIdRef.current = lastId;

    const selfSent =
      isNewBubble && last?.type === 'HUMAN' && last.authorId === userId;
    if (selfSent) {
      pinnedRef.current = true; // I just sent — always follow.
    }
    // One-shot guard: skip ONLY the first messages-driven run per thread (the
    // initial hydrate) so entry lands at the TOP — UNLESS that very first event
    // is my own send, which must still follow (the guard never suppresses a
    // genuine HUMAN send). Subsequent runs follow normally while pinned.
    const firstRun = !hasAutoScrolledRef.current;
    hasAutoScrolledRef.current = true;
    if (firstRun && !selfSent) return;
    if (!pinnedRef.current) return;
    bottomRef.current?.scrollIntoView({
      block: 'end',
      behavior: isNewBubble ? 'smooth' : 'auto',
    });
  }, [messages, userId]);

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

  const isAuthor = !!post && !!userId && post.authorId === userId;

  const handleDelete = useCallback(async () => {
    if (!id) return;
    setDeleting(true);
    setError(null);
    try {
      await deletePost(id);
      navigate('/'); // post + sandbox dir gone → back to the feed
    } catch (e) {
      setError(e instanceof ApiError ? t('errors.generic') : t('errors.networkError'));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [id, navigate, t]);

  const sessionActive =
    !!activeSession &&
    activeSession.status !== 'STOPPED' &&
    activeSession.status !== 'ERROR';

  // Lazy auto-attach on entry: when an authenticated user opens a post that
  // ALREADY has an active session, silently attach (the backend treats this
  // as a cheap attach/no-op fan-out — it does NOT spawn a new process) so the
  // running badge appears without a manual click. Gates:
  //  ① auth: token present (guests never auto-trigger; openLogin() is NEVER
  //     called on entry — they keep read-only browsing + the click→login flow);
  //  ② active session: only when getPost returned one (sessionActive) — if
  //     there is NO active session we do NOT auto-spawn / do NOT call
  //     startSession; the manual button stays, and the first aiMode message
  //     spawns via the existing backend path (no-spawn-on-entry invariant);
  //  ③ StrictMode/re-render dedupe: autoAttachedRef fires this at most ONCE
  //     per thread (reset on id change above). loading/startingSession guards
  //     avoid racing the initial load and the manual button.
  useEffect(() => {
    if (autoAttachedRef.current) return;
    if (loading || !token || !sessionActive || startingSession) return;
    autoAttachedRef.current = true;
    void handleStartSession();
  }, [loading, token, sessionActive, startingSession, handleStartSession]);

  // Surface terminal session/sandbox ERROR as a user-facing SYSTEM-style notice (TRD §11).
  // Sandbox error takes precedence (it blocks any session work).
  const sandboxErrKey = sandboxStatus ? errorKeyForSandbox(sandboxStatus) : null;
  const sessionErrKey = activeSession ? errorKeyForSession(activeSession.status) : null;
  const statusErrorKey = sandboxErrKey ?? sessionErrKey;

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

      {/* Prominent SSE reconnect banner (in addition to the compact header indicator). */}
      <ReconnectBanner show={streamStatus === 'reconnecting'} />

      {/* Session/sandbox ERROR → SYSTEM-style inline notice (TRD §11). */}
      {statusErrorKey && (
        <div
          role="alert"
          className="mb-2 px-2 text-center font-mono text-[11px] leading-relaxed text-term-red"
        >
          {t(`errors.${statusErrorKey}`)}
        </div>
      )}

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
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-term-faint">
                📌 {t('post.originalPost')}
              </span>
              {isAuthor && (
                <span className="ml-auto flex items-center gap-1">
                  {!confirmDelete ? (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="min-h-[32px] rounded-[3px] border border-term-red-line px-2 font-mono text-[11px] text-term-red hover:bg-term-red-bg"
                    >
                      {t('thread.deletePost')}
                    </button>
                  ) : (
                    <>
                      <span className="font-mono text-[11px] text-term-red">
                        {t('thread.deleteConfirm')}
                      </span>
                      <button
                        type="button"
                        onClick={handleDelete}
                        disabled={deleting}
                        className="min-h-[32px] rounded-[3px] border border-term-red-line bg-term-red-bg px-2 font-mono text-[11px] text-term-red disabled:opacity-50"
                      >
                        {deleting ? t('thread.deleting') : t('thread.deleteYes')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        disabled={deleting}
                        className="min-h-[32px] rounded-[3px] border border-term-border-dim px-2 font-mono text-[11px] text-term-dim"
                      >
                        {t('thread.deleteNo')}
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
            <h1 className="mb-2 font-mono text-lg text-term-fg-bright">{post.title}</h1>
            <div className="mb-3 font-mono text-xs text-term-dim">
              {post.author?.username ?? ''} · {relativeTime(post.createdAt)}
            </div>
            <p className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-term-fg">
              {post.body}
            </p>
          </article>

          {/* Workspace tabs (mobile-first): Chat | Files */}
          <div className="mb-3 flex gap-1 border-b border-term-line" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'chat'}
              onClick={() => setTab('chat')}
              className={`min-h-[44px] px-3 font-mono text-xs uppercase tracking-wider ${
                tab === 'chat'
                  ? 'border-b-2 border-term-active text-term-fg-bright'
                  : 'text-term-dim hover:text-term-fg'
              }`}
            >
              {t('workspace.tabChat')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'files'}
              onClick={() => setTab('files')}
              className={`min-h-[44px] px-3 font-mono text-xs uppercase tracking-wider ${
                tab === 'files'
                  ? 'border-b-2 border-term-active text-term-fg-bright'
                  : 'text-term-dim hover:text-term-fg'
              }`}
            >
              {t('workspace.tabFiles')}
            </button>
          </div>

          {/* ── Chat tab ── */}
          {tab === 'chat' && (
            <>
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
                <div ref={bottomRef} style={{ scrollMarginBottom: '7rem' }} />
              </div>

              {/* Composer pinned ABOVE the bottom TabBar (both were sticky
                  bottom-0 and overlapped, hiding the composer's lower edge). */}
              <div className="sticky bottom-[var(--tabbar-h)] z-10">
                <Composer postId={post.id} />
              </div>
            </>
          )}

          {/* ── Files (workspace) tab ── */}
          {tab === 'files' && (
            <div
              className="flex flex-1 flex-col gap-2 pb-2 sm:flex-row"
              style={{ minHeight: '24rem' }}
            >
              <div className="sm:w-2/5 sm:min-w-[12rem]" style={{ minHeight: '12rem' }}>
                <FileTree
                  postId={post.id}
                  selectedPath={selectedPath}
                  onSelect={handleSelectFile}
                />
              </div>
              <div className="flex-1" style={{ minHeight: '12rem' }}>
                <FileView postId={post.id} path={selectedPath} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
