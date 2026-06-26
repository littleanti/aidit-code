// src/components/states/LoadingState.tsx — reusable loading state (부모 Aidit 이식).
// 기본은 가벼운 스피너. `variant="skeleton"` 이면 리스트용 시머 카드 플레이스홀더.
// term-* 토큰 매핑: term-border→term-line, term-card→term-panel, term-bright→term-fg-bright.
import { useT } from '../../i18n/useT';

interface LoadingStateProps {
  /** 스피너 아래 라벨(기본 common.loading). */
  label?: string;
  /** 'spinner'(기본) 가운데 스피너, 또는 'skeleton' 리스트 플레이스홀더. */
  variant?: 'spinner' | 'skeleton';
  /** skeleton 일 때 행 수. */
  rows?: number;
  className?: string;
}

export default function LoadingState({
  label,
  variant = 'spinner',
  rows = 4,
  className = '',
}: LoadingStateProps) {
  const t = useT();
  const resolvedLabel = label ?? t('common.loading');
  if (variant === 'skeleton') {
    return (
      <div
        className={`space-y-2 ${className}`}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="animate-pulse rounded-[2px] border border-term-line px-3 py-3"
          >
            <div className="h-4 w-2/3 rounded-[2px] bg-term-panel" />
            <div className="mt-2 h-3 w-full rounded-[2px] bg-term-hover" />
            <div className="mt-1 h-3 w-1/3 rounded-[2px] bg-term-hover" />
          </div>
        ))}
        <span className="sr-only">{resolvedLabel}</span>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 py-16 text-center font-mono ${className}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span
        aria-hidden
        className="h-6 w-6 animate-spin rounded-full border-2 border-term-line border-t-term-fg-bright"
      />
      <p className="text-sm text-term-faint">{resolvedLabel}</p>
    </div>
  );
}
