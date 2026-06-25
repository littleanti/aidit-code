// src/i18n/tn.ts — non-React translation (stores/, api/, lib/). Reads current lang without a hook.
import { useLangStore } from '../stores/langStore';
import { resolveKey } from './resolve';

export function tn(key: string, vars?: Record<string, string | number>): string {
  return resolveKey(useLangStore.getState().lang, key, vars);
}
