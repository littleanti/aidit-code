// src/pages/CreatePost.tsx
// Title + body (작업 지시) form. Submit → createPost → navigate to /posts/:id.
// Login gate: no hard redirect — shows a notice + opens the login modal. Only term-* tokens.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { createPost, ApiError } from '../api/rest';

export default function CreatePost() {
  const t = useT();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const openLogin = useUiStore((s) => s.openLogin);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live ShellPrompt: post --new ["<title>"]
  const prompt = title.trim()
    ? `post --new "${title.trim()}"`
    : 'post --new';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      openLogin();
      return;
    }
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { post } = await createPost(title.trim(), body);
      navigate(`/posts/${post.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        openLogin();
      } else {
        setError(t('errors.generic'));
      }
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full rounded-[2px] border border-term-border-dim bg-term-sunken px-3 py-2 font-mono text-sm text-term-fg-bright placeholder:text-term-faint focus:border-term-active';

  return (
    <div>
      <h1 className="mb-2 font-mono text-base text-term-fg-bright">{t('post.createTitle')}</h1>

      <div className="mb-3 font-mono text-xs text-term-dim">
        aidit@web:~$ {prompt}
        <span className="term-cursor ml-1 align-middle">&nbsp;</span>
      </div>

      {!token && (
        <div className="mb-3 rounded-[2px] border border-term-amber-line bg-term-amber-bg p-3 font-mono text-xs text-term-amber">
          {t('post.loginToPost')}{' '}
          <button
            type="button"
            onClick={openLogin}
            className="ml-1 min-h-[44px] underline"
          >
            [ {t('common.login')} ]
          </button>
        </div>
      )}

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="mb-1 block font-mono text-xs text-term-dim">
            {t('post.titleLabel')}
          </label>
          <input
            className={inputCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('post.titlePlaceholder')}
          />
        </div>

        <div>
          <label className="mb-1 block font-mono text-xs text-term-dim">
            {t('post.bodyLabel')}
          </label>
          <textarea
            className={`${inputCls} min-h-[8rem] resize-y`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('post.bodyPlaceholder')}
          />
        </div>

        <p className="font-mono text-xs text-term-dim">! {t('post.sandboxNotice')}</p>

        {error && (
          <p className="font-mono text-xs text-term-red" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!title.trim() || busy}
          className="min-h-[44px] w-full rounded-[2px] border border-term-border bg-term-cta font-mono text-sm text-term-fg-bright disabled:opacity-40"
        >
          {busy ? t('post.publishing') : t('post.publish')}
        </button>
      </form>
    </div>
  );
}
