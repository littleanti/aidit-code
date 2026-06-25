// src/components/states/EmptyState.tsx — reusable empty placeholder (WIREFRAME states).
// term-* tokens only; all copy via i18n. Centered terminal-style micro text.
import { useT } from '../../i18n/useT';

interface EmptyStateProps {
  /** Optional pre-resolved message; defaults to common.emptyTitle. */
  message?: string;
  /** Optional small glyph/icon prefix. */
  glyph?: string;
}

export default function EmptyState({ message, glyph = '∅' }: EmptyStateProps) {
  const t = useT();
  return (
    <div className="py-10 text-center" role="status">
      <p className="font-mono text-sm text-term-dim">
        <span aria-hidden="true" className="mr-1 text-term-dim-3">
          {glyph}
        </span>
        {message ?? t('common.emptyTitle')}
      </p>
    </div>
  );
}
