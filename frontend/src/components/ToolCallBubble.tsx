// src/components/ToolCallBubble.tsx
// FE-TOOLCALL (M5): the TOOL_CALL bubble — a '$ <cmd>' prompt-style line
// (WIREFRAME §6.1 chat bubble table):
//   left, full-width, NO/term-line border, term-dim body, term-faint '$'/'▌'.
// Renders the tool kind/name + command summary. seq ordering is owned by store.
//
// HARD RULE: the ToolCall summary never carries an LLM key — args is the raw
// command/path JSON only. Nothing here is translated except the kind chip label.
import { useT } from '../i18n/useT';
import type { Message, ToolKind } from '../api/types';

interface ToolCallBubbleProps {
  message: Message;
}

/**
 * Best-effort human-readable command summary for the '$' prompt line.
 * SHELL tools carry the command in args (often a JSON string); other kinds
 * fall back to `name args`. We never translate machine command text.
 */
function commandSummary(name: string, kind: ToolKind, args: string): string {
  const raw = (args ?? '').trim();
  // args is a JSON-serialized value (string command, or an object of paths).
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (kind === 'SHELL') {
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const cmd = (parsed as Record<string, unknown>).command;
      if (typeof cmd === 'string') return cmd;
    }
  }

  // Non-shell kinds: show "name <arg-summary>".
  let argText = '';
  if (typeof parsed === 'string') argText = parsed;
  else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const path = o.path ?? o.file ?? o.name;
    if (typeof path === 'string') argText = path;
    else argText = raw;
  } else if (raw) {
    argText = raw;
  }
  return argText ? `${name} ${argText}` : name;
}

export default function ToolCallBubble({ message }: ToolCallBubbleProps) {
  const t = useT();
  const tc = message.toolCall ?? null;

  // Prefer the structured ToolCall summary; fall back to the message body
  // (e.g. before the tool.call event lands, message.created body holds it).
  const name = tc?.name ?? '';
  const kind = (tc?.kind ?? 'OTHER') as ToolKind;
  const args = tc?.args ?? '';
  const summary = tc ? commandSummary(name, kind, args) : message.body;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-full overflow-x-auto px-1 py-1 font-mono text-xs leading-relaxed text-term-dim">
        <span className="select-none text-term-faint" aria-hidden="true">
          ▌${' '}
        </span>
        {kind && tc && (
          <span className="mr-2 uppercase tracking-wider text-term-faint">
            [{t(`thread.toolKind.${kind}`)}]
          </span>
        )}
        <span className="whitespace-pre break-words">{summary}</span>
      </div>
    </div>
  );
}
