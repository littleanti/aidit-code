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
import type { AttributionEntry } from '../lib/threadSelectors';
import ToolCallBubble from './ToolCallBubble';
import ToolResultBubble from './ToolResultBubble';

interface ChatBubbleProps {
  message: Message;
  /** Author display name for peer HUMAN bubbles (optional). */
  authorName?: string;
  /** FE-MULTI: AGENT_REPLY / (상속) TOOL_* 버블의 귀속 정보. */
  attribution?: AttributionEntry;
  /** FE-MULTI: 2턴+ 동시 스트리밍 시 true(칩/라벨 위계 승격). */
  concurrent?: boolean;
  /** FE-MULTI: HUMAN 버블로 스크롤(본인 답글 앵커 점프). */
  onAnchorJump?: (humanMessageId: string) => void;
}

// WIREFRAME self-bubble text color (literal from the design table; not a token class).
const SELF_TEXT = '#c8ffe0';

export default function ChatBubble({
  message,
  authorName,
  attribution,
  concurrent,
  onAnchorJump,
}: ChatBubbleProps) {
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
    const pendingEmpty = status === 'PENDING' && !body;
    const attr = attribution;
    // 귀속 라벨 노출 규칙: 동시(concurrent)면 항상, 단일 턴이면 isMine 일 때만
    // (단일 턴 픽셀 동치 — 하위호환 안전).
    const showLabel = !!attr && (concurrent || attr.isMine);
    const labelText = attr ? `↳ @${attr.questionerName}` : '';
    const canAnchor = !!attr?.anchorHumanId && !!onAnchorJump;
    // 동시면 term-amber-line 박스 칩으로 위계 승격, 단일이면 term-dim 마이크로라벨.
    const labelClass = `mb-1 inline-block font-mono text-[10px] ${
      concurrent
        ? 'rounded-[2px] border border-term-amber-line px-1.5 py-0.5 text-term-amber'
        : 'text-term-dim'
    }`;

    const label = showLabel ? (
      canAnchor ? (
        <button
          type="button"
          onClick={() => onAnchorJump!(attr!.anchorHumanId!)}
          aria-label={t('thread.replyToAnchorAria')}
          className={labelClass}
        >
          {labelText}
        </button>
      ) : (
        <div className={labelClass}>{labelText}</div>
      )
    ) : null;

    return (
      <div className="flex justify-start">
        {/* 본인 질문 답글 → 좌보더 term-active 강조 */}
        <div className={`max-w-[78%] ${attr?.isMine ? 'border-l-2 border-term-active pl-2' : ''}`}>
          {label}
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-term-amber">
            ⚡ {t('thread.agentLabel')}
          </div>
          <div className="rounded-[3px] border border-term-amber-line bg-term-amber-bg px-3 py-2 font-mono text-sm leading-relaxed text-term-fg-bright">
            {pendingEmpty ? (
              <span className="text-term-dim">
                ✦ {t('thread.writing')}{' '}
                <span className="term-dots" aria-hidden="true">
                  •••
                </span>
              </span>
            ) : (
              <>
                <span className="whitespace-pre-wrap break-words">{body}</span>
                {streaming && (
                  <span className="term-cursor ml-0.5 align-text-bottom" aria-hidden="true">
                    &nbsp;
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── TOOL_CALL / TOOL_RESULT: dedicated terminal bubbles (M5) ───
  // 동시 모드에서만 귀속 마이크로라벨을 전달(단일 턴이면 생략 → 회귀 0).
  if (type === 'TOOL_CALL') {
    return <ToolCallBubble message={message} attribution={concurrent ? attribution : undefined} />;
  }
  if (type === 'TOOL_RESULT') {
    return (
      <ToolResultBubble message={message} attribution={concurrent ? attribution : undefined} />
    );
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
