// src/components/states/ErrorState.tsx — reusable error placeholder with optional retry.
// term-* tokens only; all copy via i18n. Uses term-red for the alert tone.
import { useT } from '../../i18n/useT';

interface ErrorStateProps {
  /** Pre-resolved error message; defaults to common.errorTitle. */
  message?: string;
  /** When provided, renders a [ retry ] button. */
  onRetry?: () => void;
}

export default function ErrorState({ message, onRetry }: ErrorStateProps) {
  const t = useT();
  return (
    <div className="py-10 text-center" role="alert">
      <p className="mb-3 font-mono text-sm text-term-red">
        <span aria-hidden="true" className="mr-1">
          ✕
        </span>
        {message ?? t('common.errorTitle')}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[44px] rounded-[2px] border border-term-border px-4 font-mono text-sm text-term-amber hover:text-term-fg-bright"
        >
          [ {t('common.retry')} ]
        </button>
      )}
    </div>
  );
}
