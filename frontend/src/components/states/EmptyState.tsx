// src/components/states/EmptyState.tsx — reusable empty placeholder (부모 Aidit 이식).
// 모바일-퍼스트 가운데 정렬 블록: 선택 아이콘 + 제목 + 선택 힌트 + 선택 CTA.
// CTA 는 `action`(노드)로 받아 호출부가 <Link>/<button> 을 그대로 넣는다(라우팅 비소유).
// term-* 토큰만(term-border→term-line 매핑).
import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** 주 메시지(예: "아직 인기글이 없어요."). */
  title: string;
  /** 선택 보조 힌트 줄. */
  hint?: string;
  /** 선택 장식 글리프(제목 위). */
  icon?: ReactNode;
  /** 선택 CTA 노드(Link/button). */
  action?: ReactNode;
  className?: string;
}

export default function EmptyState({
  title,
  hint,
  icon,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-[2px] border border-dashed border-term-line py-16 text-center font-mono ${className}`}
    >
      {icon && (
        <span aria-hidden className="text-3xl">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-term-dim">{title}</p>
      {hint && <p className="-mt-1 text-sm text-term-faint">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
