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

  const header = variant === 'header';
  return (
    <div
      className={`inline-flex items-center whitespace-nowrap font-mono text-sm${
        header ? ' gap-1' : ''
      }`}
      role="group"
      aria-label="Language"
    >
      {/* [ KO | EN ] — Aidit-style brackets (decorative). */}
      {header && (
        <span aria-hidden="true" className="text-term-dim-3">
          [
        </span>
      )}
      {LANGS.map((l, i) => {
        const active = lang === l.code;
        return (
          <span
            key={l.code}
            className={`inline-flex items-center${header ? ' gap-1' : ''}`}
          >
            {i > 0 && (
              <span
                className={`text-term-dim-3${header ? '' : ' px-1'}`}
                aria-hidden="true"
              >
                |
              </span>
            )}
            <button
              type="button"
              aria-pressed={active}
              onClick={() => setLang(l.code)}
              className={[
                'inline-flex min-h-[44px] items-center',
                header ? '' : 'px-2',
                variant === 'setting' ? 'min-w-[44px] justify-center' : '',
                active
                  ? 'text-term-amber'
                  : 'text-term-dim hover:text-term-fg-bright',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {l.label}
            </button>
          </span>
        );
      })}
      {header && (
        <span aria-hidden="true" className="text-term-dim-3">
          ]
        </span>
      )}
    </div>
  );
}
