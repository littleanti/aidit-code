// src/components/LlmStatusBadge.tsx
// Header LLM connectivity badge (retro green-phosphor LED + tiny label).
// Mirrors parent Aidit's GeminiStatusBadge, but probes GET /runtime → { model,
// baseURLHost } to derive reachability (model present = connected).
//
// HARD RULE (TRD §8): the runtime payload NEVER carries a key/secret. We only
// ever surface the model name + baseURL HOST in the title — never a key.
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import { getRuntime } from '../api/rest';
import type { RuntimeInfo } from '../api/types';

type Status = 'connected' | 'offline' | 'unknown';

const META: Record<
  Status,
  { glyph: string; dotClass: string; labelKey: string }
> = {
  // connected: solid LED, brightest phosphor + glow.
  connected: {
    glyph: '●',
    dotClass: 'text-term-fg-bright [text-shadow:0_0_4px_rgba(125,255,160,0.55)]',
    labelKey: 'common.llmConnected',
  },
  // offline: pulsing danger LED.
  offline: {
    glyph: '○',
    dotClass: 'text-term-red animate-pulse',
    labelKey: 'common.llmOffline',
  },
  // unknown: faint hollow LED while the first probe is in flight.
  unknown: {
    glyph: '○',
    dotClass: 'text-term-faint',
    labelKey: 'common.llmUnknown',
  },
};

export default function LlmStatusBadge() {
  const t = useT();
  const [status, setStatus] = useState<Status>('unknown');
  const [info, setInfo] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    let alive = true;

    const probe = () => {
      getRuntime()
        .then((rt) => {
          if (!alive) return;
          // Reachable + a model name present → connected.
          setInfo(rt);
          setStatus(rt?.model ? 'connected' : 'offline');
        })
        .catch(() => {
          if (!alive) return;
          setInfo(null);
          setStatus('offline');
        });
    };

    probe(); // on mount
    window.addEventListener('focus', probe);
    return () => {
      alive = false;
      window.removeEventListener('focus', probe);
    };
  }, []);

  const meta = META[status];
  const label = t(meta.labelKey);
  // Title shows model@host when known (HOST only — never a key). Falls back to
  // the localized status label while unknown/offline.
  const title =
    status === 'connected' && info?.model
      ? info.baseURLHost
        ? `${info.model}@${info.baseURLHost}`
        : info.model
      : label;

  return (
    <span
      role="status"
      aria-label={label}
      title={title}
      className="inline-flex select-none items-center gap-1"
    >
      <span aria-hidden className={`text-[10px] leading-none ${meta.dotClass}`}>
        {meta.glyph}
      </span>
      <span
        aria-hidden
        className="text-[10px] uppercase tracking-wider text-term-faint"
      >
        LLM
      </span>
    </span>
  );
}
