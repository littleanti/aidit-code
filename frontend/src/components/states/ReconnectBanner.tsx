// src/components/states/ReconnectBanner.tsx — SSE reconnect banner.
// Rendered when useThreadStream reports the 'reconnecting' state (TRD §11 states).
// term-* tokens only; copy via i18n.
import { useT } from '../../i18n/useT';

interface ReconnectBannerProps {
  /** Show the banner when true (wire to streamStatus === 'reconnecting'). */
  show: boolean;
}

export default function ReconnectBanner({ show }: ReconnectBannerProps) {
  const t = useT();
  if (!show) return null;
  return (
    <div
      role="status"
      className="mb-2 rounded-[3px] border border-term-amber-line bg-term-amber-bg px-3 py-1.5 text-center font-mono text-xs text-term-amber"
    >
      ⟳ {t('common.reconnecting')}
    </div>
  );
}
