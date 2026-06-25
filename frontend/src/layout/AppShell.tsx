// src/layout/AppShell.tsx
// App frame: CRT overlays + header (wordmark, LangToggle, Login/⚙) + bottom TabBar.
// NO GEMINI badge. Mobile-first; touch targets >=44px. Only term-* tokens.
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import LangToggle from '../components/LangToggle';

function Header() {
  const t = useT();
  const token = useAuthStore((s) => s.token);
  const openLogin = useUiStore((s) => s.openLogin);

  return (
    <header className="sticky top-0 z-20 border-b border-term-line bg-term-nav/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
        <Link
          to="/"
          className="font-mono text-sm font-bold tracking-[0.2em] text-term-glow"
        >
          {t('common.appName')}
        </Link>

        <div className="flex items-center gap-3">
          <LangToggle variant="header" />
          {token ? (
            <Link
              to="/me/settings"
              aria-label={t('common.settings')}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center font-mono text-term-dim hover:text-term-fg-bright"
            >
              ⚙
            </Link>
          ) : (
            <button
              type="button"
              onClick={openLogin}
              className="inline-flex min-h-[44px] items-center px-2 font-mono text-sm text-term-amber"
            >
              {t('common.login')}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function TabBar() {
  const t = useT();
  const { pathname } = useLocation();

  const tabs = [
    { to: '/', glyph: '🏠', label: t('common.tabHome'), match: (p: string) => p === '/' },
    {
      to: '/create',
      glyph: '＋',
      label: t('common.tabCreate'),
      match: (p: string) => p.startsWith('/create'),
    },
    {
      to: '/me',
      glyph: '👤',
      label: t('common.tabProfile'),
      match: (p: string) => p.startsWith('/me'),
    },
  ];

  return (
    <nav className="sticky bottom-0 z-20 border-t border-term-line bg-term-nav/95 backdrop-blur">
      <div className="mx-auto flex max-w-2xl items-stretch justify-around">
        {tabs.map((tab) => {
          const active = tab.match(pathname);
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              aria-label={tab.label}
              className={[
                'inline-flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 py-2 font-mono text-[10px]',
                active ? 'text-term-amber' : 'text-term-dim hover:text-term-fg-bright',
              ].join(' ')}
            >
              <span className="text-base leading-none" aria-hidden="true">
                {tab.glyph}
              </span>
              <span>{tab.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

export default function AppShell() {
  return (
    <>
      {/* CRT overlays (WIREFRAME §12.3) — non-interactive */}
      <div className="term-scanlines" aria-hidden="true" />
      <div className="term-vignette" aria-hidden="true" />

      <div className="flex min-h-screen flex-col bg-term-screen">
        <Header />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-4">
          <Outlet />
        </main>
        <TabBar />
      </div>
    </>
  );
}
