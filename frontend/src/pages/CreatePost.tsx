// src/pages/CreatePost.tsx
// Title + body (작업 지시) form. 두 가지 모드:
//   - 작성: submit → createPost → /posts/:id 로 이동(새 샌드박스 생성).
//   - 편집: Thread 의 ⋯ 메뉴가 state.editPostId 로 진입(부모 Aidit 패리티) →
//           기존 글 prefill → submit 시 patchPost → /posts/:id 로 복귀.
// Login gate: no hard redirect — shows a notice + opens the login modal. Only term-* tokens.
import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { createPost, getPost, patchPost, ApiError } from '../api/rest';

export default function CreatePost() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const token = useAuthStore((s) => s.token);
  const openLogin = useUiStore((s) => s.openLogin);

  // 편집 모드: Thread 의 작성자 전용 ⋯ 메뉴가 `state={{ editPostId }}` 로 진입.
  const editPostId =
    (location.state as { editPostId?: string } | null)?.editPostId ?? null;
  const isEdit = Boolean(editPostId);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingPost, setLoadingPost] = useState(isEdit);

  // 편집 진입 시 기존 글을 불러와 제목/본문을 prefill.
  useEffect(() => {
    if (!editPostId) return;
    let alive = true;
    setLoadingPost(true);
    getPost(editPostId)
      .then((p) => {
        if (!alive) return;
        setTitle(p.title);
        setBody(p.body);
      })
      .catch(() => {
        if (alive) setError(t('post.editLoadError'));
      })
      .finally(() => {
        if (alive) setLoadingPost(false);
      });
    return () => {
      alive = false;
    };
  }, [editPostId, t]);

  // Live ShellPrompt: post --new / post --edit ["<title>"]
  const cmd = isEdit ? 'post --edit' : 'post --new';
  const prompt = title.trim() ? `${cmd} "${title.trim()}"` : cmd;

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
      if (isEdit && editPostId) {
        await patchPost(editPostId, { title: title.trim(), body });
        navigate(`/posts/${editPostId}`);
      } else {
        const { post } = await createPost(title.trim(), body);
        navigate(`/posts/${post.id}`);
      }
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
      <h1 className="mb-2 font-mono text-base text-term-fg-bright">
        {isEdit ? t('post.editTitle') : t('post.createTitle')}
      </h1>

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

        {/* 새 글에만 샌드박스 안내(편집은 기존 샌드박스 유지). */}
        {!isEdit && (
          <p className="font-mono text-xs text-term-dim">! {t('post.sandboxNotice')}</p>
        )}

        {error && (
          <p className="font-mono text-xs text-term-red" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!title.trim() || busy || loadingPost}
          className="min-h-[44px] w-full rounded-[2px] border border-term-border bg-term-cta font-mono text-sm text-term-fg-bright disabled:opacity-40"
        >
          {isEdit
            ? busy
              ? t('post.saving')
              : t('post.save')
            : busy
              ? t('post.publishing')
              : t('post.publish')}
        </button>
      </form>
    </div>
  );
}
