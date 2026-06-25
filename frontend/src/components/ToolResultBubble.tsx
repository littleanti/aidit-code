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
import type { Message } from '../api/types';

interface ToolResultBubbleProps {
  message: Message;
}

export default function ToolResultBubble({ message }: ToolResultBubbleProps) {
  const t = useT();
  const tc = message.toolCall ?? null;

  // A TOOL_RESULT bubble has no toolCall summary of its own (the toolCall is
  // linked to the TOOL_CALL bubble via toolCallId). Its authoritative lifecycle
  // is its OWN message.status, which the server finalizes to COMPLETE (success)
  // or FAILED via a message.updated event. tc is only a secondary signal.
  const failed = message.status === 'FAILED' || tc?.status === 'FAILED';
  const running =
    !failed &&
    (message.status === 'PENDING' || message.status === 'STREAMING') &&
    tc?.status !== 'SUCCEEDED';
  const succeeded = !running && !failed;
  const output = tc?.result ?? message.body ?? '';
  const exitCode = tc?.exitCode ?? null;

  // Status badge: glyph + word (+ raw machine [exit N] label when present).
  let badge: string;
  if (running) {
    badge = t('thread.toolRunning');
  } else if (failed) {
    badge =
      exitCode != null
        ? `✗ ${t('thread.toolFailed')} [exit ${exitCode}]`
        : `✗ ${t('thread.toolFailed')}`;
  } else {
    badge =
      exitCode != null
        ? `✓ ${t('thread.toolDone')} [exit ${exitCode}]`
        : `✓ ${t('thread.toolDone')}`;
  }

  const shellClass = failed
    ? 'border-term-red-line bg-term-red-bg'
    : 'border-term-line bg-term-sunken';
  const bodyColor = failed ? 'text-term-red' : 'text-term-fg';
  const badgeColor = failed
    ? 'text-term-red'
    : running
      ? 'text-term-dim'
      : succeeded
        ? 'text-term-fg'
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
