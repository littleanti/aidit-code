// src/pages/Profile.tsx
// /me profile: ShellPrompt header (whoami) + ⚙ settings link, two tabs [ posts | bookmarks ]
// (NO communities tab). Each tab owns an independent cursor and lazy-loads its first page on
// first activation (the tab's list component mounts only once activated). Infinite scroll via
// usePagedList + IntersectionObserver. Renders PostCard. Only term-* tokens; copy via i18n.
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { getUserPosts, getUserBookmarks } from '../api/rest';
import { usePagedList } from '../hooks/usePagedList';
import PostCard from '../components/PostCard';
import Avatar from '../components/Avatar';
import PageHeaderBar from '../components/PageHeaderBar';
import ShellPrompt from '../components/ShellPrompt';
import EmptyState from '../components/states/EmptyState';
import ErrorState from '../components/states/ErrorState';
import type { Post } from '../api/types';

type ProfileTab = 'posts' | 'bookmarks';

// 탭별 터미널 명령(번역 안 함 — 셸 관용구, KO/EN 동일). 부모 Aidit Profile 동일 패턴.
const TAB_COMMAND: Record<ProfileTab, string> = {
  posts: 'ls ~/posts',
  bookmarks: 'ls ~/bookmarks',
};

/**
 * One profile tab's infinite list. Mounted independently per tab so each keeps its own
 * cursor/items; mounting only on first activation gives lazy first-page loading.
 */
function TabList({ userId, tab }: { userId: string; tab: ProfileTab }) {
  const t = useT();
  const fetcher = useCallback(
    (cursor?: string) =>
      tab === 'posts' ? getUserPosts(userId, cursor) : getUserBookmarks(userId, cursor),
    [userId, tab]
  );
  const { items, loading, done, error, sentinelRef, loadMore, reset } = usePagedList<Post>(
    fetcher,
    [userId, tab]
  );

  const emptyMsg = tab === 'posts' ? t('profile.postsEmpty') : t('profile.bookmarksEmpty');

  return (
    <div>
      <div className="flex flex-col gap-2">
        {items.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>

      {error && (
        <ErrorState
          message={t('errors.networkError')}
          onRetry={() => {
            reset();
            loadMore();
          }}
        />
      )}

      {!loading && !error && done && items.length === 0 && <EmptyState title={emptyMsg} />}

      {loading && (
        <p className="py-4 text-center font-mono text-xs text-term-dim">
          ⟳ {t('common.loading')}
        </p>
      )}

      {done && items.length > 0 && (
        <p className="py-4 text-center font-mono text-xs text-term-dim-3">
          ─── {t('common.eof')} ───
        </p>
      )}

      {!done && !error && <div ref={sentinelRef} className="h-1" aria-hidden="true" />}
    </div>
  );
}

export default function Profile() {
  const t = useT();
  const userId = useAuthStore((s) => s.userId);
  const username = useAuthStore((s) => s.username);
  const token = useAuthStore((s) => s.token);
  const openLogin = useUiStore((s) => s.openLogin);

  const [tab, setTab] = useState<ProfileTab>('posts');
  // Track which tabs have been activated so each lazy-loads only once first shown.
  const [activated, setActivated] = useState<Record<ProfileTab, boolean>>({
    posts: true,
    bookmarks: false,
  });

  const selectTab = (next: ProfileTab) => {
    setTab(next);
    setActivated((prev) => (prev[next] ? prev : { ...prev, [next]: true }));
  };

  if (!token || !userId) {
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

  const TABS: ProfileTab[] = ['posts', 'bookmarks'];

  return (
    <div>
      {/* Header (부모 Aidit 동일 구조): 고정 상단바 — Avatar + username + [설정] 링크 */}
      <PageHeaderBar>
        <Avatar kind="user" seed={username} size="sm" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-term-glow">
          {username}
        </h1>
        <Link
          to="/me/settings"
          aria-label={t('profile.settingsLink')}
          className="inline-flex h-8 shrink-0 items-center rounded-[2px] border border-term-line px-3 text-sm font-semibold text-term-dim transition hover:border-term-fg-bright hover:text-term-fg-bright"
        >
          <span>{t('profile.settingsLabel')}</span>
        </Link>
      </PageHeaderBar>

      {/* 탭별 셸 프롬프트 — 활성 탭에 따라 ls ~/posts | ~/bookmarks */}
      <ShellPrompt command={TAB_COMMAND[tab]} className="mt-4 mb-3" />

      {/* Tabs [ posts | bookmarks ] — active underline term-amber */}
      <div className="flex gap-4 border-b border-term-line font-mono text-sm" role="tablist">
        {TABS.map((tb) => {
          const active = tab === tb;
          return (
            <button
              key={tb}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectTab(tb)}
              className={[
                'min-h-[44px] px-1',
                active
                  ? 'border-b-2 border-term-amber text-term-amber'
                  : 'text-term-dim hover:text-term-fg-bright',
              ].join(' ')}
            >
              {tb === 'posts' ? t('profile.tabPosts') : t('profile.tabBookmarks')}
            </button>
          );
        })}
      </div>

      {/* Tab panels: keep each activated tab mounted (independent cursor) but hide inactive. */}
      <div className="mt-3">
        {TABS.map((tb) =>
          activated[tb] ? (
            <div key={tb} hidden={tab !== tb}>
              <TabList userId={userId} tab={tb} />
            </div>
          ) : null
        )}
      </div>
    </div>
  );
}
