// src/i18n/useT.ts — React hook. Re-renders when language changes (TRD §14.3).
import { useLangStore } from '../stores/langStore';
import { resolveKey } from './resolve';

export function useT() {
  const lang = useLangStore((s) => s.lang);
  return function t(key: string, vars?: Record<string, string | number>): string {
    return resolveKey(lang, key, vars);
  };
}
