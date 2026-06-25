// src/lib/time.ts — relative time formatting using Intl, locale from langStore (TRD §14.7).
import { useLangStore } from '../stores/langStore';

/** Short relative time (e.g. "2h", "5d") for feed meta. Uses Intl.RelativeTimeFormat. */
export function relativeTime(iso: string): string {
  const lang = useLangStore.getState().lang;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = then - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
    numeric: 'auto',
    style: 'narrow',
  });
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (abs < hr) return rtf.format(Math.round(diffMs / min), 'minute');
  if (abs < day) return rtf.format(Math.round(diffMs / hr), 'hour');
  return rtf.format(Math.round(diffMs / day), 'day');
}

/** Locale-aware integer formatting for counts. */
export function formatCount(n: number): string {
  const lang = useLangStore.getState().lang;
  return new Intl.NumberFormat(lang === 'ko' ? 'ko-KR' : 'en-US').format(n);
}
