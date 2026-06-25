// src/components/PostCard.tsx
// Feed card: sandbox status badge, title, author/meta, comment count, upvote with optimistic toggle.
// Upvote is a write action → opens the login modal when unauthenticated. Touch targets >=44px.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { upvote as apiUpvote, unupvote as apiUnupvote } from '../api/rest';
import { relativeTime, formatCount } from '../lib/time';
import StatusBadge from './StatusBadge';
import type { Post } from '../api/types';

interface PostCardProps {
  post: Post;
}

export default function PostCard({ post }: PostCardProps) {
  const t = useT();
  const token = useAuthStore((s) => s.token);
  const openLogin = useUiStore((s) => s.openLogin);

  const [voted, setVoted] = useState(Boolean(post.voted));
  const [score, setScore] = useState(post.score);
  const [pending, setPending] = useState(false);

  async function toggleVote(e: React.MouseEvent) {
    e.preventDefault(); // card is wrapped in a Link
    e.stopPropagation();
    if (!token) {
      openLogin();
      return;
    }
    if (pending) return;

    // Optimistic flip.
    const nextVoted = !voted;
    const prevVoted = voted;
    const prevScore = score;
    setVoted(nextVoted);
    setScore((s) => s + (nextVoted ? 1 : -1));
    setPending(true);
    try {
      const res = nextVoted ? await apiUpvote(post.id) : await apiUnupvote(post.id);
      setVoted(res.voted);
      setScore(res.score);
    } catch {
      // Roll back on failure.
      setVoted(prevVoted);
      setScore(prevScore);
    } finally {
      setPending(false);
    }
  }

  const author = post.author?.username ?? '';

  return (
    <Link
      to={`/posts/${post.id}`}
      className="block rounded-[3px] border border-term-line bg-term-panel p-3 transition-colors hover:border-term-border-dim"
    >
      <div className="mb-1.5">
        <StatusBadge status={post.sandbox?.status} />
      </div>

      <h2 className="mb-2 font-mono text-base leading-snug text-term-fg-bright">
        {post.title}
      </h2>

      <div className="flex items-center gap-3 font-mono text-xs text-term-dim">
        <button
          type="button"
          onClick={toggleVote}
          aria-pressed={voted}
          aria-label={t('post.upvote')}
          className={[
            'inline-flex min-h-[44px] items-center gap-1 px-1',
            voted ? 'text-term-amber' : 'text-term-dim hover:text-term-fg-bright',
          ].join(' ')}
        >
          <span aria-hidden="true">▲</span>
          <span>{formatCount(score)}</span>
        </button>

        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true">💬</span>
          <span>{formatCount(post.commentCount)}</span>
        </span>

        {author && <span className="text-term-dim-2">{author}</span>}
        <span className="text-term-dim-3">· {relativeTime(post.createdAt)}</span>
      </div>
    </Link>
  );
}
