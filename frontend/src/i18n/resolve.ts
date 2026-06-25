// src/i18n/resolve.ts — shared resolution logic for useT (React) and tn (non-React).
import { DICTS, type Lang } from './index';

type Vars = Record<string, string | number>;

/** Resolve a `ns.sub` key for the given language. Order: DICTS[ns][lang][sub] → ko fallback → raw key. */
export function resolveKey(lang: Lang, key: string, vars?: Vars): string {
  const [ns, sub] = key.split(/\.(.+)/); // split on first dot only
  const dict = (DICTS as Record<string, Record<Lang, Record<string, string>>>)[ns];
  const value = dict?.[lang]?.[sub] ?? dict?.['ko']?.[sub] ?? key;
  if (import.meta.env.DEV && value === key) {
    console.warn(`[i18n] missing key: "${key}"`);
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}
