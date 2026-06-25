// src/i18n/useT.ts — React hook. Re-renders when language changes (TRD §14.3).
import { useCallback } from 'react';
import { useLangStore } from '../stores/langStore';
import { resolveKey } from './resolve';

export function useT() {
  const lang = useLangStore((s) => s.lang);
  // Memoize so `t` keeps a STABLE identity across renders (changes only when the
  // language changes). Without this, every render returns a new function, which
  // breaks consumers that put `t` in a useCallback/useEffect dependency array
  // (e.g. Thread.load) — causing an infinite effect-rerun loop.
  return useCallback(
    (key: string, vars?: Record<string, string | number>): string => resolveKey(lang, key, vars),
    [lang]
  );
}
