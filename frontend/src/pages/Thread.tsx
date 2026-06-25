// src/pages/Thread.tsx
// M1 placeholder: shows post title/body + sandbox status badge. Full agent-session chat is M4.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { getPost, ApiError } from '../api/rest';
import { relativeTime } from '../lib/time';
import StatusBadge from '../components/StatusBadge';
import type { Post } from '../api/types';

export default function Thread() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getPost(id)
      .then(setPost)
      .catch((e) => setError(e instanceof ApiError ? t('errors.generic') : t('errors.networkError')))
      .finally(() => setLoading(false));
  }, [id, t]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Link
          to="/"
          aria-label={t('common.back')}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center font-mono text-term-dim hover:text-term-fg-bright"
        >
          ‹
        </Link>
        {post && <StatusBadge status={post.sandbox?.status} />}
      </div>

      {loading && (
        <p className="py-8 text-center font-mono text-sm text-term-dim">
          ⟳ {t('common.loading')}
        </p>
      )}

      {error && (
        <p className="py-8 text-center font-mono text-sm text-term-red" role="alert">
          {error}
        </p>
      )}

      {post && (
        <article className="rounded-[3px] border border-term-line bg-term-panel p-4">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-term-faint">
            📌 {t('post.originalPost')}
          </div>
          <h1 className="mb-2 font-mono text-lg text-term-fg-bright">{post.title}</h1>
          <div className="mb-3 font-mono text-xs text-term-dim">
            {post.author?.username ?? ''} · {relativeTime(post.createdAt)}
          </div>
          <p className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-term-fg">
            {post.body}
          </p>

          <p className="mt-4 border-t border-term-line pt-3 font-mono text-xs text-term-dim">
            {t('post.threadComingSoon')}
          </p>
        </article>
      )}
    </div>
  );
}
