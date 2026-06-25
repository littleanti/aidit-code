// src/pages/Profile.tsx
// M1 placeholder: ShellPrompt header (whoami) + settings entry. posts/bookmarks tabs land in a later
// stage; unauthenticated shows a login prompt. Only term-* tokens.
import { Link } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';

export default function Profile() {
  const t = useT();
  const username = useAuthStore((s) => s.username);
  const token = useAuthStore((s) => s.token);
  const openLogin = useUiStore((s) => s.openLogin);

  if (!token) {
    return (
      <div className="py-10 text-center">
        <p className="mb-3 font-mono text-sm text-term-dim">{t('common.loginRequired')}</p>
        <button
          type="button"
          onClick={openLogin}
          className="min-h-[44px] rounded-[2px] border border-term-border px-4 font-mono text-sm text-term-amber"
        >
          [ {t('common.login')} ]
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div className="font-mono text-xs text-term-dim">
          aidit@web:~$ whoami
          <div className="mt-1 text-base text-term-amber">&gt; {username}</div>
        </div>
        <Link
          to="/me/settings"
          aria-label={t('common.settings')}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center font-mono text-term-dim hover:text-term-fg-bright"
        >
          ⚙
        </Link>
      </div>

      <div className="mt-4 flex gap-4 border-b border-term-line font-mono text-sm">
        <span className="min-h-[44px] border-b-2 border-term-amber px-1 text-term-amber">
          {t('profile.tabPosts')}
        </span>
        <span className="min-h-[44px] px-1 text-term-dim">{t('profile.tabBookmarks')}</span>
      </div>

      <p className="py-8 text-center font-mono text-sm text-term-dim">
        {t('profile.postsEmpty')}
      </p>
    </div>
  );
}
