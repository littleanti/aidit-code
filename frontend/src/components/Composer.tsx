// src/components/Composer.tsx
// FE-COMPOSER (M4): Aidit-structured composer.
//   Layout (top→bottom): [error] · [image preview row] · [interrupt/steer row while
//   STREAMING] · [MAIN ROW]. MAIN ROW = attach button (outside) + input wrapper
//   ('>' prefix + auto-grow textarea + AI chip opening a popover ABOVE) + send button
//   (outside, term-cta gradient). The AI popover holds the aiMode ON/OFF toggle and
//   the 3 reasoning_effort options (낮음/중간/높음 · low/medium/high, default medium);
//   effort options are disabled when aiMode is off.
//
// All user-facing labels via i18n t(). Uses ONLY term-* tokens.
//
// HARD RULE: no key fields anywhere. Sends only { body, aiMode, clientId, lang,
// imageUrl?, reasoningEffort? } — never an LLM key.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import { useLangStore } from '../stores/langStore';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { useThreadStore } from '../stores/threadStore';
import {
  sendMessage,
  uploadImage,
  interrupt as apiInterrupt,
  ApiError,
  type ReasoningEffort,
} from '../api/rest';
import type { Message } from '../api/types';
import { hasMyActiveTurn } from '../lib/threadSelectors';

// Feature A: 클라 측 1차 검증(서버가 권위). MIME 화이트리스트 + 5MB 캡 = 백엔드와 일치.
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Feature B: reasoning_effort 3분할. 기본 medium.
const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

interface ComposerProps {
  postId: string;
}

/** Robot "AI" glyph shared by the trailing chip + the popover toggle. */
function RobotIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="5" y="8" width="14" height="11" rx="1" />
      <path d="M12 8V4M9 4h6" />
      <circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function Composer({ postId }: ComposerProps) {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const token = useAuthStore((s) => s.token);
  const userId = useAuthStore((s) => s.userId);
  const openLogin = useUiStore((s) => s.openLogin);

  const optimisticInsert = useThreadStore((s) => s.optimisticInsert);
  const reconcileByClientId = useThreadStore((s) => s.reconcileByClientId);
  // An agent turn is active when any AGENT_REPLY is PENDING/STREAMING.
  const agentStreaming = useThreadStore((s) =>
    s.messages.some(
      (m) => m.type === 'AGENT_REPLY' && (m.status === 'STREAMING' || m.status === 'PENDING')
    )
  );
  // FE-MULTI: '내 턴' 게이팅(self-concurrency=1). 내 활성 턴이 inflight 인 동안만
  // 내 Composer 를 잠근다. 남의 활성 턴은 비차단(HOL blocking 제거).
  const myTurnBusy = useThreadStore((s) => hasMyActiveTurn(s.messages, userId));

  const [body, setBody] = useState('');
  const [aiMode, setAiMode] = useState(true);
  const [steer, setSteer] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Feature A: 첨부 이미지 상태(파일 + 미리보기 objectURL). 세션 한정.
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Feature B: per-message reasoning_effort. 기본 medium. aiMode 켜졌을 때만 활성.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');

  // Aidit layout: AI options live in a popover ABOVE the trailing AI chip.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea up to its max (max-h-28 ≈ 7rem) — Aidit affordance.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [body]);

  // Close the AI popover on outside click or Escape (Aidit dismiss behavior).
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function clearImage() {
    // objectURL 메모리 해제(누수 방지) 후 상태/인풋 초기화.
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // 타입 화이트리스트 + 5MB 캡(서버가 최종 권위지만 즉시 피드백).
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setError(t('thread.unsupportedImageFormat'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(t('thread.imageTooLarge'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    // 직전 미리보기 해제 후 교체.
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setError(null);
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  async function handleSend() {
    const trimmed = body.trim();
    // 이미지-only 전송 허용: 텍스트가 비어도 첨부가 있으면 보낸다(둘 다 없으면 무시).
    if ((!trimmed && !imageFile) || sending || myTurnBusy) return;
    if (!token || !userId) {
      openLogin();
      return;
    }

    const clientId = crypto.randomUUID();
    setError(null);

    // 낙관 행에 넘길 로컬 미리보기를 떼어 두고(여기선 revoke 하지 않음 — 버블이 사용 중),
    // 컴포저 상태는 즉시 비운다. reconcile 직후/실패 시 한 번만 revoke.
    const pendingFile = imageFile;
    const localPreview = imagePreview;

    // Optimistic HUMAN row: temp id = clientId, seq < 0 so it sinks to the bottom
    // until the server message.created reconciles it (matched by clientId).
    const optimistic: Message = {
      id: clientId,
      postId,
      sessionId: null,
      authorId: userId,
      type: 'HUMAN',
      status: 'PENDING',
      body: trimmed,
      imageUrl: null,
      // 업로드 완료 전이라도 즉시 미리보기를 보여준다(reconcile 시 서버 imageUrl 로 교체).
      localImagePreview: localPreview,
      replyToId: null,
      toolCallId: null,
      seq: -Date.now(), // negative + monotonic-ish: preserves local send order
      clientId,
      createdAt: new Date().toISOString(),
    };
    optimisticInsert(optimistic);
    setBody('');
    // 컴포저 입력 초기화(미리보기 objectURL 은 낙관 버블이 쓰므로 여기선 revoke 안 함).
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setSending(true);

    try {
      // 첨부가 있으면 먼저 업로드 → /uploads/<uuid>.<ext> 를 받아 메시지에 동봉.
      let imageUrl: string | undefined;
      if (pendingFile) {
        const up = await uploadImage(pendingFile);
        imageUrl = up.imageUrl;
      }

      // Server assigns seq + fans out via SSE. The REST response carries the
      // created HUMAN message WITH its clientId (the SSE message.created payload
      // does not), so reconcile the optimistic temp row here — adopting the real
      // id + seq. A later replayed SSE message.created dedupes by id in the store.
      const { message } = await sendMessage(postId, {
        body: trimmed,
        aiMode,
        clientId,
        lang,
        ...(imageUrl ? { imageUrl } : {}),
        // aiMode 일 때만 의미 있음(백엔드는 aiMode 아니면 무시). 항상 보내도 안전.
        ...(aiMode ? { reasoningEffort } : {}),
      });
      reconcileByClientId(message);
    } catch (e) {
      setError(e instanceof ApiError ? t('errors.generic') : t('errors.networkError'));
    } finally {
      // 서버 imageUrl 이 자리잡았으므로(또는 실패) 로컬 objectURL 해제(누수 방지).
      if (localPreview) URL.revokeObjectURL(localPreview);
      setSending(false);
    }
  }

  async function handleInterrupt() {
    const steerText = steer.trim();
    try {
      await apiInterrupt(postId, steerText || undefined);
      setSteer('');
    } catch (e) {
      setError(e instanceof ApiError ? t('errors.generic') : t('errors.networkError'));
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline (desktop affordance).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const canSend = (body.trim().length > 0 || imageFile != null) && !sending && !myTurnBusy;

  return (
    <div className="shrink-0 border-t border-term-border bg-term-bg font-mono">
      {error && (
        <p className="mx-3 mb-1 mt-2 font-mono text-xs text-term-red" role="alert">
          {error}
        </p>
      )}

      {/* FE-MULTI: 내 활성 턴 진행 중 안내(self-concurrency=1). 남의 턴은 비차단. */}
      {myTurnBusy && (
        <p role="status" className="mx-3 mb-1 mt-2 font-mono text-xs text-term-dim">
          {t('thread.myTurnBusy')}
        </p>
      )}

      {/* 첨부 이미지 미리보기 — h-16 w-16 썸네일 + × 제거(절대 위치) */}
      {imagePreview && (
        <div className="flex items-center gap-2 px-3 pt-2">
          <div className="relative inline-block">
            <img
              src={imagePreview}
              alt={t('thread.attachPreviewAlt')}
              className="h-16 w-16 rounded-[2px] border border-term-border object-cover"
            />
            <button
              type="button"
              onClick={clearImage}
              aria-label={t('thread.removeImageAria')}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-[2px] border border-term-border bg-term-bg text-xs font-bold text-term-fg-bright active:scale-95"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="square"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Interrupt / steer row — only while an agent turn is streaming (기존 동작 보존) */}
      {agentStreaming && (
        <div className="flex items-center gap-2 px-3 pt-2">
          <input
            type="text"
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            placeholder={t('thread.steerPlaceholder')}
            className="min-h-[44px] flex-1 rounded-[2px] border border-term-amber-line bg-term-sunken px-3 font-mono text-sm text-term-fg-bright outline-none"
          />
          <button
            type="button"
            onClick={handleInterrupt}
            className="min-h-[44px] rounded-[2px] border border-term-amber-line px-3 font-mono text-sm text-term-amber"
          >
            ■ {t('thread.interrupt')}
          </button>
        </div>
      )}

      {/* MAIN ROW */}
      <div className="flex items-end gap-2 px-3 py-2">
        {/* (a) attach button OUTSIDE the input — opens the native image picker */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={onPickImage}
        />
        <button
          type="button"
          aria-label={t('thread.attachImageAria')}
          onClick={() => fileInputRef.current?.click()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[2px] border border-term-border text-term-fg-bright hover:bg-term-border active:scale-95"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="square"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>

        {/* (b) input wrapper — '>' prefix + auto-grow textarea + AI chip (popover ABOVE) */}
        <div
          className={`flex max-h-32 min-h-[44px] flex-1 items-end gap-2 rounded-[2px] border bg-term-bg px-3 py-1 ${
            aiMode
              ? 'border-term-amber focus-within:border-term-amber'
              : 'border-term-border focus-within:border-term-active'
          }`}
        >
          {/* terminal prompt prefix (decorative) */}
          <span aria-hidden className="select-none self-center text-sm text-term-faint">
            &gt;
          </span>
          <textarea
            ref={taRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={t('thread.composerPlaceholder')}
            aria-label={t('thread.composerPlaceholder')}
            className="max-h-28 flex-1 resize-none bg-transparent py-1.5 font-mono text-sm leading-relaxed text-term-fg-bright outline-none placeholder:text-term-faint"
          />
          {/* trailing AI chip — opens the popover (aiMode toggle + reasoning_effort). */}
          <div ref={menuRef} className="relative shrink-0 self-center">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              aria-label={t('thread.aiMenuAria')}
              onClick={() => setMenuOpen((v) => !v)}
              className={`flex h-9 items-center gap-1 rounded-[2px] border px-2 text-xs font-bold transition ${
                aiMode
                  ? 'border-term-amber text-term-amber'
                  : 'border-term-border text-term-dim hover:text-term-fg-bright'
              }`}
            >
              <RobotIcon />
              <span>AI</span>
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-2.5 w-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="square"
              >
                <path d={menuOpen ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'} />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="dialog"
                aria-label={t('thread.aiMenuAria')}
                className={`absolute bottom-full right-0 z-30 mb-2 flex w-[19rem] max-w-[calc(100vw-2.5rem)] flex-col gap-2 rounded-[2px] border bg-term-panel p-2 ${
                  aiMode ? 'border-term-amber' : 'border-term-border'
                }`}
              >
                {/* one row: [AI] toggle | divider | reasoning_effort segments */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={aiMode}
                    aria-label={aiMode ? t('thread.aiToggleOn') : t('thread.aiToggleOff')}
                    onClick={() => setAiMode((v) => !v)}
                    className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-[2px] border px-2.5 text-xs font-bold transition ${
                      aiMode
                        ? 'border-term-amber text-term-amber'
                        : 'border-term-border text-term-dim hover:text-term-fg-bright'
                    }`}
                  >
                    <RobotIcon />
                    <span>AI</span>
                  </button>
                  <div
                    role="radiogroup"
                    aria-label={t('thread.reasoningEffortAria')}
                    className={`flex flex-1 items-center gap-1.5 border-l border-term-border pl-2 ${
                      aiMode ? '' : 'opacity-40'
                    }`}
                  >
                    {REASONING_EFFORTS.map((eff) => {
                      const labelKey =
                        eff === 'low'
                          ? 'thread.reasoningEffortLow'
                          : eff === 'medium'
                            ? 'thread.reasoningEffortMedium'
                            : 'thread.reasoningEffortHigh';
                      const label = t(labelKey);
                      const active = aiMode && reasoningEffort === eff;
                      return (
                        <button
                          key={eff}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={!aiMode}
                          onClick={() => setReasoningEffort(eff)}
                          className={`flex min-h-[44px] flex-1 select-none items-center justify-center rounded-[2px] border px-1 text-xs font-bold transition ${
                            active
                              ? 'border-term-amber text-term-amber'
                              : 'border-term-border text-term-dim'
                          } ${aiMode ? 'hover:text-term-fg-bright' : 'cursor-not-allowed'}`}
                        >
                          {active ? `[${label}]` : label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* (c) send button OUTSIDE — term-cta gradient, up-arrow icon */}
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          aria-label={t('thread.sendAria')}
          title={sending ? t('thread.sending') : t('thread.send')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[2px] border border-term-active bg-term-cta text-lg font-bold text-term-fg-bright transition active:scale-95 disabled:opacity-40"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="square"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
