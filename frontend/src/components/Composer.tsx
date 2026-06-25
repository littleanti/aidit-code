// src/components/Composer.tsx
// FE-COMPOSER (M4): textarea + send (bg-term-cta), AI on/off toggle (on = term-amber),
// optimistic HUMAN insert, and an Interrupt control while an agent turn is STREAMING.
// All labels via i18n t(). Uses ONLY term-* tokens.
//
// HARD RULE: no key fields anywhere. Sends only { body, aiMode, clientId, lang,
// imageUrl?, reasoningEffort? } — never an LLM key.
import { useRef, useState } from 'react';
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

// Feature A: 클라 측 1차 검증(서버가 권위). MIME 화이트리스트 + 5MB 캡 = 백엔드와 일치.
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Feature B: reasoning_effort 3분할. 기본 medium.
const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

interface ComposerProps {
  postId: string;
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
    if ((!trimmed && !imageFile) || sending) return;
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

  return (
    <div className="border-t border-term-line bg-term-nav p-2">
      {error && (
        <p className="mb-2 font-mono text-xs text-term-red" role="alert">
          {error}
        </p>
      )}

      {/* 첨부 이미지 미리보기 — 작은 썸네일 + 제거 버튼(term-*) */}
      {imagePreview && (
        <div className="mb-2 inline-flex items-start gap-2">
          <img
            src={imagePreview}
            alt={t('thread.attachPreviewAlt')}
            className="rounded-[3px] border border-term-border"
            style={{ maxHeight: '4rem', maxWidth: '8rem' }}
          />
          <button
            type="button"
            onClick={clearImage}
            aria-label={t('thread.removeImageAria')}
            className="min-h-[44px] min-w-[44px] rounded-[3px] border border-term-border-dim px-2 font-mono text-sm text-term-dim"
          >
            ×
          </button>
        </div>
      )}

      {/* reasoning_effort 선택기 — aiMode 켜졌을 때만 활성(기본 medium) */}
      {aiMode && (
        <div
          role="group"
          aria-label={t('thread.reasoningEffortAria')}
          className="mb-2 inline-flex overflow-hidden rounded-[3px] border border-term-amber-line"
        >
          {REASONING_EFFORTS.map((eff) => {
            const labelKey =
              eff === 'low'
                ? 'thread.reasoningEffortLow'
                : eff === 'medium'
                  ? 'thread.reasoningEffortMedium'
                  : 'thread.reasoningEffortHigh';
            const active = reasoningEffort === eff;
            return (
              <button
                key={eff}
                type="button"
                aria-pressed={active}
                onClick={() => setReasoningEffort(eff)}
                className={`min-h-[44px] px-3 font-mono text-xs tracking-wider ${
                  active ? 'bg-term-amber-bg text-term-amber' : 'text-term-dim'
                }`}
              >
                {t(labelKey)}
              </button>
            );
          })}
        </div>
      )}

      {/* Interrupt / steer row — only while an agent turn is streaming */}
      {agentStreaming && (
        <div className="mb-2 flex items-center gap-2">
          <input
            type="text"
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            placeholder={t('thread.steerPlaceholder')}
            className="min-h-[44px] flex-1 rounded-[3px] border border-term-amber-line bg-term-sunken px-3 font-mono text-sm text-term-fg-bright outline-none"
          />
          <button
            type="button"
            onClick={handleInterrupt}
            className="min-h-[44px] rounded-[3px] border border-term-amber-line px-3 font-mono text-sm text-term-amber"
          >
            ■ {t('thread.interrupt')}
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* AI on/off toggle — on = term-amber per wireframe */}
        <button
          type="button"
          aria-pressed={aiMode}
          onClick={() => setAiMode((v) => !v)}
          className={`min-h-[44px] shrink-0 rounded-[3px] border px-3 font-mono text-xs tracking-wider ${
            aiMode
              ? 'border-term-amber-line text-term-amber'
              : 'border-term-border-dim text-term-dim'
          }`}
        >
          {aiMode ? t('thread.aiToggleOn') : t('thread.aiToggleOff')}
        </button>

        {/* 이미지 첨부 — 숨김 file input + 버튼(≥44px, i18n aria) */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={onPickImage}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label={t('thread.attachImageAria')}
          className="min-h-[44px] min-w-[44px] shrink-0 rounded-[3px] border border-term-border px-3 font-mono text-sm text-term-dim"
        >
          🖼
        </button>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={t('thread.composerPlaceholder')}
          className="min-h-[44px] max-h-40 flex-1 resize-y rounded-[3px] border border-term-border bg-term-sunken px-3 py-2 font-mono text-sm text-term-fg outline-none"
        />

        <button
          type="button"
          onClick={handleSend}
          disabled={sending || (!body.trim() && !imageFile)}
          className="min-h-[44px] shrink-0 rounded-[3px] border border-term-active bg-term-cta px-4 font-mono text-sm text-term-fg-bright disabled:opacity-50"
        >
          {sending ? t('thread.sending') : t('thread.send')}
        </button>
      </div>
    </div>
  );
}
