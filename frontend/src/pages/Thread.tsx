// src/pages/Thread.tsx
// M4: live collaborative agent-session thread.
// Loads the post + initial messages, starts/attaches a session, mounts the SSE
// stream, and renders the bubble list + Composer + sandbox/session status.
// Mobile-first; touch targets >=44px. Uses ONLY term-* tokens; labels via t().
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/useT';
import {
  getPost,
  getMessages,
  startSession,
  suspendSession,
  deletePost,
  upvote as apiUpvote,
  unupvote as apiUnupvote,
  ApiError,
} from '../api/rest';
import { relativeTime, formatCount } from '../lib/time';
import SafeMarkdown from '../lib/SafeMarkdown';
import Avatar from '../components/Avatar';
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
  const [stoppingSession, setStoppingSession] = useState(false);
  const [tab, setTab] = useState<WorkspaceTab>('chat');
  const [deleting, setDeleting] = useState(false);
  // Owner-only ⋯ popover menu (edit / 2-step delete confirm) — parent Aidit parity.
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const ownerMenuRef = useRef<HTMLDivElement>(null);
  // Optimistic upvote on the original post (seeded from the loaded post below).
  const [voted, setVoted] = useState(false);
  const [postScore, setPostScore] = useState(0);
  const [votePending, setVotePending] = useState(false);

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

  // ── Jump chip (ported from Aidit, adapted to window scroll) ──
  // A single square chip at the composer's top-right that follows scroll
  // DIRECTION: ↑ while scrolling up (jump to top), ↓ while scrolling down
  // (jump to bottom). Fades in only during active scroll, fades out after 1s
  // idle. `isProgrammatic` blocks our own scrollTo from re-arming the chip.
  const [activeChip, setActiveChip] = useState<'none' | 'top' | 'bottom'>('none');
  const lastScrollYRef = useRef(0);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const isProgrammaticRef = useRef(false);

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
  // Also drives the jump chip: direction from the scrollY delta (>2px deadzone),
  // fading out 1s after scrolling stops. Skipped while a programmatic jump runs.
  useEffect(() => {
    const SCROLL_DIR_DEADZONE = 2;
    const onScroll = () => {
      const doc = document.documentElement;
      const y = window.scrollY;
      pinnedRef.current = window.innerHeight + y >= doc.scrollHeight - 120;

      if (isProgrammaticRef.current) return;
      const dY = y - lastScrollYRef.current;
      lastScrollYRef.current = y;
      if (dY < -SCROLL_DIR_DEADZONE) setActiveChip('top');
      else if (dY > SCROLL_DIR_DEADZONE) setActiveChip('bottom');
      // Below the deadzone (jitter): keep whatever chip is currently showing.
      if (scrollIdleTimerRef.current) window.clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = window.setTimeout(() => setActiveChip('none'), 1000);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (scrollIdleTimerRef.current) window.clearTimeout(scrollIdleTimerRef.current);
    };
  }, []);

  // Jump to the top / bottom of the window. Blocks our own scroll events from
  // re-arming the chip, hides it instantly, and re-pins when jumping to bottom.
  const jumpTo = useCallback((edge: 'top' | 'bottom') => {
    isProgrammaticRef.current = true;
    setActiveChip('none');
    pinnedRef.current = edge === 'bottom';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({
      top: edge === 'top' ? 0 : document.documentElement.scrollHeight,
      behavior: reduce ? 'auto' : 'smooth',
    });
    window.setTimeout(
      () => {
        isProgrammaticRef.current = false;
        lastScrollYRef.current = window.scrollY;
      },
      reduce ? 0 : 700
    );
  }, []);

  // Auto-scroll to the newest bubble as messages/tokens arrive. The user's own
  // freshly-sent message always re-pins and follows; streaming tokens follow
  // only while pinned (instant), brand-new bubbles ease in (smooth).
  useEffect(() => {
    // Don't consume the one-shot guard on the empty pre-hydrate render — wait
    // until there are real messages so `firstRun` maps to the actual hydrate.
    if (messages.length === 0) return;

    const last = messages[messages.length - 1];
    const lastId = last?.id ?? null;
    const isNewBubble = lastId !== prevLastIdRef.current;
    prevLastIdRef.current = lastId;

    const selfSent =
      isNewBubble && last?.type === 'HUMAN' && last.authorId === userId;
    if (selfSent) {
      pinnedRef.current = true; // I just sent — always follow.
    }
    // One-shot guard: the FIRST real (post-hydrate) run per thread always lands
    // at the TOP (show the original post first) — UNLESS that very first event
    // is my own send, which must still follow. Explicitly scrollTo(0,0) here so
    // browser scroll-restoration or a false-positive "pinned" can't drag entry
    // to the bottom. Subsequent runs follow normally while pinned.
    const firstRun = !hasAutoScrolledRef.current;
    hasAutoScrolledRef.current = true;
    if (firstRun && !selfSent) {
      // Clear any false-positive "pinned" (the scroll listener can set it true
      // while the pre-hydrate content is shorter than the viewport). Without
      // this, the first SSE token after entry would scrollIntoView to bottom.
      pinnedRef.current = false;
      window.scrollTo(0, 0);
      return;
    }
    if (!pinnedRef.current) return;
    // Scroll to the TRUE document bottom (not the anchor's viewport-bottom).
    // The composer is `sticky bottom-[var(--tabbar-h)]` and overlays the lower
    // ~150px of the viewport, so scrollIntoView({block:'end'}) stops short and
    // tucks the last bubble behind the composer. scrollTo(scrollHeight) reveals
    // the composer's in-flow height and lands the last bubble just above it —
    // identical to the ↓ jump chip. New bubbles ease in (smooth); streaming
    // tokens snap (auto); reduced-motion always snaps.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: reduce || !isNewBubble ? 'auto' : 'smooth',
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

  // Stop/suspend the running session (session → STOPPED, sandbox → SUSPENDED).
  // After this sessionActive becomes false → the chip flips back to Start and
  // the composer disconnect warning reappears. We do NOT auto-restart (the user
  // chose to stop; autoAttachedRef is already consumed for this thread).
  const handleStopSession = useCallback(async () => {
    if (!id || !token) return;
    setStoppingSession(true);
    setError(null);
    try {
      const { session } = await suspendSession(id);
      setActiveSession(session);
    } catch (e) {
      setError(e instanceof ApiError ? t('errors.sessionFailed') : t('errors.networkError'));
    } finally {
      setStoppingSession(false);
    }
  }, [id, token, setActiveSession, t]);

  const isAuthor = !!post && !!userId && post.authorId === userId;

  // Seed the upvote state from the loaded post; re-seed only when the post id
  // changes (an optimistic toggle updates local state without a refetch).
  useEffect(() => {
    if (post) {
      setVoted(Boolean(post.voted));
      setPostScore(post.score);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post?.id]);

  // Owner menu: close on outside click / Escape; reset the delete confirm when closed.
  useEffect(() => {
    if (!ownerMenuOpen) {
      setConfirmingDelete(false);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (ownerMenuRef.current && !ownerMenuRef.current.contains(e.target as Node)) {
        setOwnerMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOwnerMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [ownerMenuOpen]);

  // Optimistic upvote toggle on the original post (mirrors PostCard). Write
  // action → opens the login modal when unauthenticated; rolls back on failure.
  const handleToggleVote = useCallback(async () => {
    if (!post) return;
    if (!token) {
      openLogin();
      return;
    }
    if (votePending) return;
    const nextVoted = !voted;
    const prevVoted = voted;
    const prevScore = postScore;
    setVoted(nextVoted);
    setPostScore((s) => s + (nextVoted ? 1 : -1));
    setVotePending(true);
    try {
      const res = nextVoted ? await apiUpvote(post.id) : await apiUnupvote(post.id);
      setVoted(res.voted);
      setPostScore(res.score);
    } catch {
      setVoted(prevVoted);
      setPostScore(prevScore);
    } finally {
      setVotePending(false);
    }
  }, [post, token, openLogin, votePending, voted, postScore]);

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
      setOwnerMenuOpen(false);
      setConfirmingDelete(false);
    }
  }, [id, navigate, t]);

  const sessionActive =
    !!activeSession &&
    activeSession.status !== 'STOPPED' &&
    activeSession.status !== 'ERROR';

  // Auto-connect on entry: when an authenticated user opens a post, connect the
  // agent session automatically (start it if none is active, or attach to an
  // existing one — the backend startOrAttach does the right thing incl. stale
  // RUNNING normalization). Gates:
  //  ① auth: token present (guests never auto-trigger; openLogin() is NEVER
  //     called on entry — they keep read-only browsing + the click→login flow);
  //  ② sandbox readiness: only fire when the sandbox is READY/SUSPENDED/RUNNING.
  //     While CREATING (provisioning) we DON'T consume the guard, so the effect
  //     retries once sandbox.status updates; ERROR never auto-starts;
  //  ③ already active → just consume the guard (the badge already shows);
  //  ④ StrictMode/re-render dedupe: autoAttachedRef fires this at most ONCE
  //     per thread (reset on id change above). loading/startingSession guards
  //     avoid racing the initial load and the manual button.
  useEffect(() => {
    if (autoAttachedRef.current) return;
    if (loading || !token || startingSession) return;
    if (sessionActive) {
      autoAttachedRef.current = true; // already connected — nothing to start
      return;
    }
    const sb = sandboxStatus ?? post?.sandbox?.status ?? null;
    if (sb !== 'READY' && sb !== 'SUSPENDED' && sb !== 'RUNNING') return; // wait (CREATING) / skip (ERROR)
    autoAttachedRef.current = true;
    void handleStartSession();
  }, [loading, token, sessionActive, startingSession, sandboxStatus, post, handleStartSession]);

  // Surface terminal session/sandbox ERROR as a user-facing SYSTEM-style notice (TRD §11).
  // Sandbox error takes precedence (it blocks any session work).
  const sandboxErrKey = sandboxStatus ? errorKeyForSandbox(sandboxStatus) : null;
  const sessionErrKey = activeSession ? errorKeyForSession(activeSession.status) : null;
  const statusErrorKey = sandboxErrKey ?? sessionErrKey;

  // Session-aware sandbox badge: a sandbox can linger in RUNNING after the agent
  // session ends (stale state). Don't show "Running" top-left while the session
  // is not active — surface it as SUSPENDED so it agrees with the disconnect
  // warning. Other states (CREATING/READY/ERROR/SUSPENDED) pass through as-is.
  const rawSandboxStatus = sandboxStatus ?? post?.sandbox?.status ?? null;
  const badgeStatus =
    !sessionActive && rawSandboxStatus === 'RUNNING' ? 'SUSPENDED' : rawSandboxStatus;

  return (
    <div className="-mb-4 flex flex-col" style={{ minHeight: 'calc(100vh - 7rem)' }}>
      {/* Header: back + sandbox badge + reconnect indicator */}
      <div className="mb-3 flex items-center gap-2">
        <Link
          to="/"
          aria-label={t('common.back')}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center font-mono text-term-dim hover:text-term-fg-bright"
        >
          ‹
        </Link>
        <StatusBadge status={badgeStatus} />
        {streamStatus === 'reconnecting' && (
          <span className="font-mono text-[10px] tracking-wider text-term-dim" role="status">
            ⟳ {t('thread.reconnecting')}
          </span>
        )}
        {/* Session toggle chip (top-right): [Start Session] when not connected,
            [Stop Session] when running. Stays visible in both states. */}
        <button
          type="button"
          onClick={sessionActive ? handleStopSession : handleStartSession}
          disabled={startingSession || stoppingSession}
          className={`ml-auto inline-flex min-h-[28px] items-center rounded-[2px] border px-2 font-mono text-[11px] tracking-wider disabled:opacity-50 ${
            sessionActive
              ? 'border-term-red-line text-term-red hover:bg-term-red-bg' // [Stop Session] — match the Delete button
              : 'border-term-amber-line text-term-amber'
          }`}
        >
          {sessionActive
            ? `[${stoppingSession ? t('thread.stoppingSession') : t('thread.stopSession')}]`
            : `[${startingSession ? t('thread.startingSession') : t('thread.startSession')}]`}
        </button>
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
          {/* Original post — 부모 Aidit 패리티(커뮤니티 제외). 코너 태그 + 제목 +
              본문 + (아바타 · 작성자 · 작성시간) + Upvote · 댓글수 · ⋯ 작성자 메뉴. */}
          <article className="relative mb-3 rounded-[3px] border border-term-line bg-term-panel px-4 py-3">
            {/* 코너 태그 — 상단 보더 위로 살짝 겹쳐 라벨처럼 */}
            <span
              aria-hidden="true"
              className="absolute -top-1 left-[13px] bg-term-panel px-1 font-mono text-[9px] tracking-wider text-term-amber"
            >
              {t('post.originalPostTag')}
            </span>

            <h1 className="mt-1.5 font-mono text-base font-bold leading-snug text-term-glow [text-shadow:0_0_4px_rgba(125,255,160,0.45)]">
              {post.title}
            </h1>

            {post.body && (
              <SafeMarkdown
                text={post.body}
                className="mt-2 break-words font-mono text-sm leading-relaxed text-term-dim"
              />
            )}

            <div className="mt-3 flex items-center gap-2 font-mono text-xs text-term-faint">
              <Avatar kind="user" seed={post.author?.username ?? ''} size="sm" />
              <span className="truncate">
                u/{post.author?.username ?? t('thread.anonymous')} ·{' '}
                {relativeTime(post.createdAt)}
              </span>
              <span className="ml-auto flex items-center gap-2">
                {/* Upvote — 낙관적 토글, 활성 시 amber */}
                <button
                  type="button"
                  aria-pressed={voted}
                  aria-label={t('post.upvote')}
                  onClick={handleToggleVote}
                  className={`inline-flex items-center gap-0.5 rounded-[2px] transition hover:text-term-amber ${
                    voted ? 'text-term-amber' : ''
                  }`}
                >
                  <span aria-hidden="true">▲</span>
                  <span>{formatCount(postScore)}</span>
                </button>
                {/* 댓글 수(HUMAN + AGENT_REPLY) */}
                <span className="inline-flex items-center gap-0.5">
                  <span aria-hidden="true">💬</span>
                  <span>{formatCount(post.commentCount)}</span>
                </span>
                {/* 작성자 전용 ⋯ 팝오버(편집 / 2단계 삭제 확인) */}
                {isAuthor && (
                  <div ref={ownerMenuRef} className="relative">
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={ownerMenuOpen}
                      aria-label={t('thread.moreActionsAria')}
                      title={t('thread.moreActionsAria')}
                      onClick={() => setOwnerMenuOpen((v) => !v)}
                      className={`flex h-7 w-7 items-center justify-center rounded-[2px] text-base leading-none transition hover:bg-term-hover hover:text-term-fg-bright ${
                        ownerMenuOpen ? 'text-term-fg-bright' : 'text-term-dim'
                      }`}
                    >
                      ⋯
                    </button>
                    {ownerMenuOpen && (
                      <div
                        role="menu"
                        aria-label={t('thread.ownerMenuAria')}
                        className="absolute right-0 top-full z-30 mt-1 flex w-36 flex-col rounded-[2px] border border-term-border bg-term-panel py-1 shadow-glow-soft"
                      >
                        {confirmingDelete ? (
                          <>
                            <span className="px-3 py-1 font-mono text-xs text-term-red">
                              {t('thread.deleteConfirm')}
                            </span>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={deleting}
                              onClick={handleDelete}
                              className="flex min-h-[44px] items-center gap-2 px-3 font-mono text-xs text-term-red transition hover:bg-term-hover disabled:opacity-50"
                            >
                              {deleting ? t('thread.deleting') : t('thread.deleteYes')}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              disabled={deleting}
                              onClick={() => setConfirmingDelete(false)}
                              className="flex min-h-[44px] items-center gap-2 px-3 font-mono text-xs text-term-dim transition hover:bg-term-hover hover:text-term-fg-bright disabled:opacity-50"
                            >
                              {t('thread.deleteNo')}
                            </button>
                          </>
                        ) : (
                          <>
                            <Link
                              to="/create"
                              state={{ editPostId: post.id }}
                              role="menuitem"
                              onClick={() => setOwnerMenuOpen(false)}
                              className="flex min-h-[44px] items-center gap-2 px-3 font-mono text-xs text-term-dim transition hover:bg-term-hover hover:text-term-fg-bright"
                            >
                              {t('thread.editPost')}
                            </Link>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => setConfirmingDelete(true)}
                              className="flex min-h-[44px] items-center gap-2 px-3 font-mono text-xs text-term-red transition hover:bg-term-hover"
                            >
                              {t('thread.deletePost')}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </span>
            </div>
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
              </div>

              {/* Composer pinned ABOVE the bottom TabBar (both were sticky
                  bottom-0 and overlapped, hiding the composer's lower edge).
                  -mx-4 cancels <main>'s px-4 so the composer is full-bleed
                  (edge-to-edge) like Aidit; inner rows keep their own px-3. */}
              <div className="sticky bottom-[var(--tabbar-h)] z-10 -mx-4">
                {/* Jump chip (Aidit parity): floats just above the composer,
                    bottom-right; follows scroll direction, fades when idle. */}
                <div className="pointer-events-none absolute bottom-full right-3 mb-2">
                  <button
                    type="button"
                    onClick={() => jumpTo(activeChip === 'top' ? 'top' : 'bottom')}
                    aria-label={t(
                      activeChip === 'top' ? 'thread.jumpTopAria' : 'thread.jumpBottomAria'
                    )}
                    title={t(
                      activeChip === 'top' ? 'thread.jumpTopAria' : 'thread.jumpBottomAria'
                    )}
                    aria-hidden={activeChip === 'none'}
                    tabIndex={activeChip === 'none' ? -1 : 0}
                    className={`grid h-10 w-10 place-items-center rounded-[2px] border border-term-border bg-term-panel/85 text-term-dim backdrop-blur transition hover:border-term-fg-bright hover:text-term-fg-bright hover:[box-shadow:0_0_8px_rgba(125,255,160,0.25)] active:scale-95 ${
                      activeChip !== 'none'
                        ? 'pointer-events-auto opacity-100'
                        : 'pointer-events-none opacity-0'
                    }`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="square"
                      aria-hidden="true"
                    >
                      <path d={activeChip === 'top' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
                    </svg>
                  </button>
                </div>
                {!sessionActive && !statusErrorKey && (
                  <div
                    role="alert"
                    className="border-t border-term-red-line bg-term-red-bg px-3 py-1.5 font-mono text-[11px] leading-relaxed text-term-red"
                  >
                    {t('thread.sessionDisconnected')}
                  </div>
                )}
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
