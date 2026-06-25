// src/components/StatusBadge.tsx
// Sandbox status summary badge (WIREFRAME §2/§12):
//   RUNNING = term-amber, READY/SUSPENDED = term-dim, ERROR = term-red, CREATING = term-dim + ⟳.
// Uses ONLY term-* tokens.
import { useT } from '../i18n/useT';
import type { SandboxStatus } from '../api/types';

interface StatusBadgeProps {
  status: SandboxStatus | null | undefined;
}

interface BadgeStyle {
  glyph: string;
  color: string;
  labelKey: string;
}

function styleFor(status: SandboxStatus | null | undefined): BadgeStyle {
  switch (status) {
    case 'RUNNING':
      return { glyph: '●', color: 'text-term-amber', labelKey: 'post.statusRunning' };
    case 'READY':
      return { glyph: '○', color: 'text-term-dim', labelKey: 'post.statusReady' };
    case 'SUSPENDED':
      return { glyph: '○', color: 'text-term-dim', labelKey: 'post.statusSuspended' };
    case 'ERROR':
      return { glyph: '✗', color: 'text-term-red', labelKey: 'post.statusError' };
    case 'CREATING':
      return { glyph: '⟳', color: 'text-term-dim', labelKey: 'post.statusCreating' };
    default:
      return { glyph: '·', color: 'text-term-dim-3', labelKey: 'post.statusNone' };
  }
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const t = useT();
  const { glyph, color, labelKey } = styleFor(status);
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-xs tracking-wider ${color}`}
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{t(labelKey)}</span>
    </span>
  );
}
