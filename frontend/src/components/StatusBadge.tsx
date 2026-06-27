// src/components/StatusBadge.tsx
// Sandbox status summary badge (WIREFRAME §2/§12) — 신호등 의미:
//   RUNNING = term-glow(초록) ●, SUSPENDED = term-red(빨강) ●, ERROR = term-red ✗,
//   READY = term-dim(무색) ○, CREATING = term-dim ⟳, none = term-dim-3(무색) ·.
// Uses ONLY term-* tokens.
import { useT } from '../i18n/useT';
import type { SandboxStatus } from '../api/types';

interface StatusBadgeProps {
  status: SandboxStatus | null | undefined;
  // `dot` 변형: 글리프만(라벨 없음) — sticky 상단바에서 세션 상태를 최소 면적으로
  // 항상 노출하기 위함. 색/글리프 매핑은 styleFor 단일 소스를 그대로 재사용한다.
  dot?: boolean;
}

interface BadgeStyle {
  glyph: string;
  color: string;
  labelKey: string;
}

function styleFor(status: SandboxStatus | null | undefined): BadgeStyle {
  switch (status) {
    case 'RUNNING':
      return { glyph: '●', color: 'text-term-glow', labelKey: 'post.statusRunning' };
    case 'READY':
      return { glyph: '○', color: 'text-term-dim', labelKey: 'post.statusReady' };
    case 'SUSPENDED':
      return { glyph: '●', color: 'text-term-red', labelKey: 'post.statusSuspended' };
    case 'ERROR':
      return { glyph: '✗', color: 'text-term-red', labelKey: 'post.statusError' };
    case 'CREATING':
      return { glyph: '⟳', color: 'text-term-dim', labelKey: 'post.statusCreating' };
    default:
      return { glyph: '·', color: 'text-term-dim-3', labelKey: 'post.statusNone' };
  }
}

export default function StatusBadge({ status, dot }: StatusBadgeProps) {
  const t = useT();
  const { glyph, color, labelKey } = styleFor(status);
  if (dot) {
    return (
      <span
        role="img"
        aria-label={t(labelKey)}
        title={t(labelKey)}
        className={`font-mono text-xs leading-none ${color}`}
      >
        {glyph}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-xs tracking-wider ${color}`}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{t(labelKey)}</span>
    </span>
  );
}
