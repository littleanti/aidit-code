// src/components/states/OfflineBanner.tsx — sticky banner shown when the browser is offline.
// Subscribes to window online/offline events. term-* tokens only; copy via i18n.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n/useT';

export default function OfflineBanner() {
  const t = useT();
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );

  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="border-b border-term-amber-line bg-term-amber-bg px-4 py-1.5 text-center font-mono text-xs text-term-amber"
    >
      ⚠ {t('common.offline')}
    </div>
  );
}
