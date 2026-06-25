// src/pages/Home.tsx
// Feed: hot/new tab toggle (active underline = term-amber) + infinite scroll (IntersectionObserver
// sentinel via usePagedList) rendering PostCard. Live ShellPrompt header. Only term-* tokens.
import { useCallback, useState } from 'react';
import { useT } from '../i18n/useT';
import { getPosts, type PostSort } from '../api/rest';
import { usePagedList } from '../hooks/usePagedList';
import PostCard from '../components/PostCard';
import EmptyState from '../components/states/EmptyState';
import ErrorState from '../components/states/ErrorState';
import type { Post } from '../api/types';

export default function Home() {
  const t = useT();
  const [sort, setSort] = useState<PostSort>('hot');

  const fetcher = useCallback(
    (cursor?: string) => getPosts(sort, cursor),
    [sort]
  );

  const { items, loading, done, error, sentinelRef, loadMore, reset } = usePagedList<Post>(
    fetcher,
    [sort]
  );

  const promptSort = sort === 'hot' ? 'popular' : 'new';

  return (
    <div>
      {/* hot/new tab toggle */}
      <div className="mb-2 flex gap-4 font-mono text-sm" role="tablist">
        {(['hot', 'new'] as PostSort[]).map((s) => {
          const active = sort === s;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSort(s)}
              className={[
                'min-h-[44px] px-1',
                active
                  ? 'border-b-2 border-term-amber text-term-amber'
                  : 'text-term-dim hover:text-term-fg-bright',
              ].join(' ')}
            >
              {s === 'hot' ? t('post.sortHot') : t('post.sortNew')}
            </button>
          );
        })}
      </div>

      {/* Live ShellPrompt */}
      <div className="mb-3 font-mono text-xs text-term-dim">
        aidit@web:~$ feed --sort={promptSort}
        <span className="term-cursor ml-1 align-middle">&nbsp;</span>
      </div>

      <div className="flex flex-col gap-2">
        {items.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>

      {/* empty state */}
      {!loading && !error && done && items.length === 0 && (
        <EmptyState message={t('post.feedEmpty')} />
      )}

      {error && (
        <ErrorState
          message={t('errors.networkError')}
          onRetry={() => {
            reset();
            loadMore();
          }}
        />
      )}

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

      {/* sentinel for infinite scroll */}
      {!done && <div ref={sentinelRef} className="h-1" aria-hidden="true" />}
    </div>
  );
}
