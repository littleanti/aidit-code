// src/components/Composer.tsx
// FE-COMPOSER (M4): textarea + send (bg-term-cta), AI on/off toggle (on = term-amber),
// optimistic HUMAN insert, and an Interrupt control while an agent turn is STREAMING.
// All labels via i18n t(). Uses ONLY term-* tokens.
//
// HARD RULE: no key fields anywhere. Sends only { body, aiMode, clientId }.
import { useState } from 'react';
import { useT } from '../i18n/useT';
import { useLangStore } from '../stores/langStore';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { useThreadStore } from '../stores/threadStore';
import { sendMessage, interrupt as apiInterrupt, ApiError } from '../api/rest';
import type { Message } from '../api/types';

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

  async function handleSend() {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    if (!token || !userId) {
      openLogin();
      return;
    }

    const clientId = crypto.randomUUID();
    setError(null);

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
      replyToId: null,
      toolCallId: null,
      seq: -Date.now(), // negative + monotonic-ish: preserves local send order
      clientId,
      createdAt: new Date().toISOString(),
    };
    optimisticInsert(optimistic);
    setBody('');
    setSending(true);

    try {
      // Server assigns seq + fans out via SSE. The REST response carries the
      // created HUMAN message WITH its clientId (the SSE message.created payload
      // does not), so reconcile the optimistic temp row here — adopting the real
      // id + seq. A later replayed SSE message.created dedupes by id in the store.
      const { message } = await sendMessage(postId, { body: trimmed, aiMode, clientId, lang });
      reconcileByClientId(message);
    } catch (e) {
      setError(e instanceof ApiError ? t('errors.generic') : t('errors.networkError'));
    } finally {
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
          disabled={sending || !body.trim()}
          className="min-h-[44px] shrink-0 rounded-[3px] border border-term-active bg-term-cta px-4 font-mono text-sm text-term-fg-bright disabled:opacity-50"
        >
          {sending ? t('thread.sending') : t('thread.send')}
        </button>
      </div>
    </div>
  );
}
