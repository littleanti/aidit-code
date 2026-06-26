// src/layout/AppShell.tsx
// App frame: CRT overlays + header (Logo + LLM status + LangToggle + account)
// + bottom TabBar (inline-SVG icons). Mobile-first; touch targets >=44px.
// NO settings gear. NO LLM key ever surfaced. Only term-* tokens.
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import Logo from '../components/Logo';
import LangToggle from '../components/LangToggle';
import LlmStatusBadge from '../components/LlmStatusBadge';
import OfflineBanner from '../components/states/OfflineBanner';

function Header() {
  const t = useT();
  const token = useAuthStore((s) => s.token);
  const username = useAuthStore((s) => s.username);
  const openLogin = useUiStore((s) => s.openLogin);

  return (
    <header className="sticky top-0 z-20 border-b border-term-line bg-term-nav/95 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-2xl items-center justify-between gap-2 px-4">
        <Link to="/" aria-label={t('common.appName')} className="min-w-0">
          <Logo size="sm" />
        </Link>

        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <LlmStatusBadge />
          <LangToggle variant="header" />
          {token ? (
            <Link
              to="/me"
              title={username ?? ''}
              className="inline-flex min-h-[44px] max-w-[8rem] items-center px-1 font-mono text-sm text-term-dim hover:text-term-fg-bright"
            >
              <span aria-hidden="true" className="shrink-0">[&nbsp;</span>
              <span className="min-w-0 truncate">{username ?? ''}</span>
              <span aria-hidden="true" className="shrink-0">&nbsp;]</span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={openLogin}
              className="inline-flex min-h-[44px] items-center px-1 font-mono text-sm text-term-amber"
            >
              {`[ ${t('common.login')} ]`}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

// ── Tab icons — inline SVG ported from parent Aidit (22x22, stroke=currentColor,
// strokeWidth 1.6). Color follows the active/inactive text token via currentColor.
function IconHome() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 11 12 3l9 8" />
      <path d="M5 9.5V20h14V9.5" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}

function IconWrite() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 20l1-4L16 5l3 3L8 19z" />
      <path d="M14 7l3 3" />
    </svg>
  );
}

function IconProfile() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 20c0-3.6 2.9-5.5 6.5-5.5s6.5 1.9 6.5 5.5" />
    </svg>
  );
}

function TabBar() {
  const t = useT();
  const { pathname } = useLocation();

  const tabs = [
    {
      to: '/',
      Icon: IconHome,
      label: t('common.tabHome'),
      match: (p: string) => p === '/',
    },
    {
      to: '/create',
      Icon: IconWrite,
      label: t('common.tabCreate'),
      match: (p: string) => p.startsWith('/create'),
    },
    {
      to: '/me',
      Icon: IconProfile,
      label: t('common.tabProfile'),
      match: (p: string) => p.startsWith('/me'),
    },
  ];

  return (
    <nav
      className="sticky bottom-0 z-20 border-t border-term-line bg-term-nav/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="mx-auto flex h-14 max-w-2xl items-stretch justify-around">
        {tabs.map((tab) => {
          const active = tab.match(pathname);
          const Icon = tab.Icon;
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              aria-label={tab.label}
              className={[
                'inline-flex h-full flex-1 flex-col items-center justify-center gap-0.5 font-mono text-[10px]',
                active ? 'text-term-amber' : 'text-term-dim hover:text-term-fg-bright',
              ].join(' ')}
            >
              <span
                className="flex h-6 items-center justify-center leading-none"
                aria-hidden="true"
              >
                <Icon />
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

      <div
        className="flex min-h-screen flex-col bg-term-screen"
        style={{
          // Deterministic tab-bar height (incl. iOS safe area) shared with the
          // Thread composer so it can stick ABOVE the bar instead of behind it.
          ['--tabbar-h' as string]: 'calc(3.5rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <Header />
        <OfflineBanner />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-4">
          <Outlet />
        </main>
        <TabBar />
      </div>
    </>
  );
}
