// src/pages/Home.tsx
// Feed: 인기/최신 탭을 부모 Aidit 처럼 고정 상단바(PageHeaderBar)에 꽉 채워 배치
// (활성 = amber 밑줄 + 배경 틴트) + ShellPrompt + 무한 스크롤(usePagedList) + PostCard.
// 첫 로드는 LoadingState(skeleton), 비어 있으면 EmptyState(+ 첫 글 쓰기 CTA). term-* 토큰만.
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { getPosts, type PostSort } from '../api/rest';
import { usePagedList } from '../hooks/usePagedList';
import PostCard from '../components/PostCard';
import PageHeaderBar from '../components/PageHeaderBar';
import ShellPrompt from '../components/ShellPrompt';
import EmptyState from '../components/states/EmptyState';
import ErrorState from '../components/states/ErrorState';
import LoadingState from '../components/states/LoadingState';
import type { Post } from '../api/types';

export default function Home() {
  const t = useT();
  const [sort, setSort] = useState<PostSort>('hot');

  const fetcher = useCallback((cursor?: string) => getPosts(sort, cursor), [sort]);
  const { items, loading, done, error, sentinelRef, loadMore, reset } = usePagedList<Post>(
    fetcher,
    [sort]
  );

  const isEmpty = !loading && !error && done && items.length === 0;

  return (
    <div className="pb-4">
      {/* 인기/최신 탭 — 부모 동일: 고정 상단바를 꽉 채우고(h-full flex-1), 활성 탭은
          amber 밑줄 + 옅은 배경 틴트로 바 하단 보더와 정렬. */}
      <PageHeaderBar>
        <div className="flex h-full w-full" role="tablist">
          {(['hot', 'new'] as PostSort[]).map((s) => {
            const active = sort === s;
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSort(s)}
                className={`flex h-full flex-1 items-center justify-center border-b-2 text-base font-semibold transition ${
                  active
                    ? 'border-term-amber bg-[rgba(255,207,74,0.06)] text-term-amber'
                    : 'border-transparent text-term-dim hover:text-term-fg-bright'
                }`}
              >
                {s === 'hot' ? t('post.sortHot') : t('post.sortNew')}
              </button>
            );
          })}
        </div>
      </PageHeaderBar>

      {/* 쉘 프롬프트 — 고정바 바로 아래 16px(mt-4) */}
      <ShellPrompt
        command={`feed --sort=${sort === 'hot' ? 'popular' : 'new'}`}
        className="mt-4 mb-3"
      />

      {/* 첫 로드 스켈레톤 */}
      {loading && items.length === 0 && !error && (
        <LoadingState variant="skeleton" rows={5} />
      )}

      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          {items.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}

      {/* 빈 상태 — 제목 + "첫 글 쓰기" CTA */}
      {isEmpty && (
        <EmptyState
          title={sort === 'hot' ? t('post.emptyHot') : t('post.emptyNew')}
          action={
            <Link
              to="/create"
              className="inline-flex min-h-[44px] items-center rounded-[2px] border border-term-border bg-term-cta px-4 text-sm font-bold text-term-fg-bright transition hover:border-term-fg-bright"
            >
              {t('post.writeFirst')}
            </Link>
          }
        />
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

      {/* 페이지네이션 로딩(이미 목록이 있을 때) */}
      {loading && items.length > 0 && (
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
