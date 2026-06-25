// src/components/LangToggle.tsx
// [ KO | EN ] segmented control. Active = term-amber, inactive = term-dim hover:term-fg-bright.
// variant: 'header' (compact) | 'setting' (settings page). aria-pressed for a11y. Touch target >=44px.
import { useLangStore, type Lang } from '../stores/langStore';

interface LangToggleProps {
  variant?: 'header' | 'setting';
}

const LANGS: { code: Lang; label: string }[] = [
  { code: 'ko', label: 'KO' },
  { code: 'en', label: 'EN' },
];

export default function LangToggle({ variant = 'header' }: LangToggleProps) {
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);

  return (
    <div
      className="inline-flex items-center font-mono text-sm"
      role="group"
      aria-label="Language"
    >
      {LANGS.map((l, i) => {
        const active = lang === l.code;
        return (
          <span key={l.code} className="inline-flex items-center">
            {i > 0 && <span className="px-1 text-term-dim-3" aria-hidden="true">|</span>}
            <button
              type="button"
              aria-pressed={active}
              onClick={() => setLang(l.code)}
              className={[
                'inline-flex min-h-[44px] items-center px-2',
                variant === 'setting' ? 'min-w-[44px] justify-center' : '',
                active
                  ? 'text-term-amber'
                  : 'text-term-dim hover:text-term-fg-bright',
              ].join(' ')}
            >
              {l.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}
