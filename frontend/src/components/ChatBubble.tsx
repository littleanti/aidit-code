// src/components/ChatBubble.tsx
// FE-BUBBLE (M4): render a Message by type using ONLY term-* tokens
// (WIREFRAME §6.1 chat bubble table). seq ordering is handled by the store.
//
//   HUMAN (self)  → right; bg-term-cta + border-term-active + text #c8ffe0
//   HUMAN (peer)  → left;  bg-term-panel + border-term-border + text-term-fg, author label term-dim
//   AGENT_REPLY   → left;  amber tint + border-term-amber-line + text-term-fg-bright,
//                          '[AGENT] Aidit Agent' label term-amber; STREAMING → blinking .term-cursor
//   SYSTEM        → centered, text-term-dim-3
//   TOOL_CALL    → ToolCallBubble ('$ <cmd>' prompt-style, M5)
//   TOOL_RESULT  → ToolResultBubble (fixed-width terminal pane, M5)
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { assetUrl } from '../api/rest';
import type { Message } from '../api/types';
import ToolCallBubble from './ToolCallBubble';
import ToolResultBubble from './ToolResultBubble';

interface ChatBubbleProps {
  message: Message;
  /** Author display name for peer HUMAN bubbles (optional). */
  authorName?: string;
}

// WIREFRAME self-bubble text color (literal from the design table; not a token class).
const SELF_TEXT = '#c8ffe0';

export default function ChatBubble({ message, authorName }: ChatBubbleProps) {
  const t = useT();
  const currentUserId = useAuthStore((s) => s.userId);

  const { type, status, body } = message;

  // 첨부 이미지(Feature A): 서버 imageUrl 을 origin 해석하거나, 업로드 완료 전 낙관
  // 로컬 미리보기(objectURL)를 그대로 사용. term-* 프레이밍 + 반응형 max-width.
  const imgSrc = message.localImagePreview || assetUrl(message.imageUrl);
  const attachedImage = imgSrc ? (
    <img
      src={imgSrc}
      alt={t('thread.messageImageAlt')}
      className="mt-1 max-w-full rounded-[3px] border border-term-border"
      style={{ maxHeight: '20rem' }}
    />
  ) : null;

  // ── SYSTEM: centered micro-text band ───────────────────────────
  if (type === 'SYSTEM') {
    return (
      <div className="my-1 px-2 text-center font-mono text-[11px] leading-relaxed text-term-dim-3">
        {body}
      </div>
    );
  }

  // ── AGENT_REPLY: left, amber tint, [AGENT] label, streaming cursor ─
  if (type === 'AGENT_REPLY') {
    const streaming = status === 'STREAMING' || status === 'PENDING';
    return (
      <div className="flex justify-start">
        <div className="max-w-[78%]">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-term-amber">
            ⚡ {t('thread.agentLabel')}
          </div>
          <div className="rounded-[3px] border border-term-amber-line bg-term-amber-bg px-3 py-2 font-mono text-sm leading-relaxed text-term-fg-bright">
            <span className="whitespace-pre-wrap break-words">{body}</span>
            {streaming && (
              <span className="term-cursor ml-0.5 align-text-bottom" aria-hidden="true">
                &nbsp;
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── TOOL_CALL / TOOL_RESULT: dedicated terminal bubbles (M5) ───
  if (type === 'TOOL_CALL') {
    return <ToolCallBubble message={message} />;
  }
  if (type === 'TOOL_RESULT') {
    return <ToolResultBubble message={message} />;
  }

  // ── HUMAN: self (right) vs peer (left) ─────────────────────────
  const isSelf = !!currentUserId && message.authorId === currentUserId;

  if (isSelf) {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[78%] rounded-[3px] border border-term-active bg-term-cta px-3 py-2 font-mono text-sm leading-relaxed"
          style={{ color: SELF_TEXT }}
        >
          {body && <span className="whitespace-pre-wrap break-words">{body}</span>}
          {attachedImage}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[78%]">
        {authorName && (
          <div className="mb-1 font-mono text-[10px] text-term-dim">{authorName}</div>
        )}
        <div className="rounded-[3px] border border-term-border bg-term-panel px-3 py-2 font-mono text-sm leading-relaxed text-term-fg">
          {body && <span className="whitespace-pre-wrap break-words">{body}</span>}
          {attachedImage}
        </div>
      </div>
    </div>
  );
}
