// src/components/ToolResultBubble.tsx
// FE-TOOLRESULT (M5): the TOOL_RESULT bubble — a fixed-width terminal output
// pane (WIREFRAME §6.1 chat bubble table):
//   left, full-width, font-mono fixed-width output inside an overflow-x:auto
//   scroll container, bg-term-sunken.
//   running (RUNNING/STREAMING) → accumulating output;
//   success → term-fg + '[exit 0]' / ✓;
//   failure → term-red + border-term-red-line + bg-term-red-bg + '[exit N]'.
//
// HARD RULE: raw machine output is preserved verbatim — no translation, no
// letter-spacing, no key fields (result is stdout/stderr only).
import { useT } from '../i18n/useT';
import type { Message, ToolCallStatus } from '../api/types';

interface ToolResultBubbleProps {
  message: Message;
}

export default function ToolResultBubble({ message }: ToolResultBubbleProps) {
  const t = useT();
  const tc = message.toolCall ?? null;

  // ToolCall summary is authoritative; before tool.call lands, fall back to the
  // message body/status so the bubble still renders something coherent.
  const toolStatus: ToolCallStatus =
    tc?.status ?? (message.status === 'FAILED' ? 'FAILED' : 'RUNNING');
  const output = tc?.result ?? message.body ?? '';
  const exitCode = tc?.exitCode ?? null;

  const running = toolStatus === 'RUNNING';
  const failed = toolStatus === 'FAILED';

  // Status badge: [exit N] machine label (raw) + a glyph/word.
  let badge: string;
  if (running) {
    badge = t('thread.toolRunning');
  } else if (failed) {
    badge = `[exit ${exitCode ?? '?'}]`;
  } else {
    // success
    badge = `[exit ${exitCode ?? 0}] ✓`;
  }

  const shellClass = failed
    ? 'border-term-red-line bg-term-red-bg'
    : 'border-term-line bg-term-sunken';
  const bodyColor = failed ? 'text-term-red' : 'text-term-fg';
  const badgeColor = failed
    ? 'text-term-red'
    : running
      ? 'text-term-dim'
      : 'text-term-fg';

  return (
    <div className="flex justify-start">
      <div className={`w-full max-w-full rounded-[3px] border ${shellClass}`}>
        {/* Fixed-width output pane; horizontal scroll on overflow. */}
        <div className="max-w-full overflow-x-auto px-3 py-2">
          <pre
            className={`m-0 font-mono text-xs leading-relaxed whitespace-pre ${bodyColor}`}
            style={{ letterSpacing: 'normal' }}
          >
            {output}
            {running && (
              <span className="term-cursor align-text-bottom" aria-hidden="true">
                &nbsp;
              </span>
            )}
          </pre>
        </div>
        {/* Status footer: machine [exit N] label + glyph (success/fail) or running word. */}
        <div
          className={`border-t px-3 py-1 font-mono text-[11px] ${
            failed ? 'border-term-red-line' : 'border-term-line'
          } ${badgeColor}`}
        >
          {badge}
        </div>
      </div>
    </div>
  );
}
