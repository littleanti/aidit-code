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
import { createPost, getPost, patchPost, ApiError, type ReasoningEffort } from '../api/rest';
import PageHeaderBar from '../components/PageHeaderBar';
import ShellPrompt from '../components/ShellPrompt';
import { formatPromptArg } from '../lib/shellArg';

// 작업 강도(낮음/중간/높음) = reasoning effort. Composer(Feature B)와 동일 어휘/순서.
const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

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
  // "게시 후 AI 1차 답변 받기"(기본 ON) + 자동 첫 턴의 작업 강도(reasoning effort, 기본 medium).
  const [firstAgent, setFirstAgent] = useState(true);
  const [effort, setEffort] = useState<ReasoningEffort>('medium');

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

  // Live ShellPrompt: post --new / post --edit ["<title>"] (부모와 동일 포맷터).
  const cmd = isEdit ? 'post --edit' : 'post --new';
  const promptCommand = title.trim() ? `${cmd} "${formatPromptArg(title)}"` : cmd;

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
        const { post } = await createPost(title.trim(), body, {
          autoReply: firstAgent,
          reasoningEffort: firstAgent ? effort : undefined,
        });
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
      <PageHeaderBar>
        <h1 className="truncate text-base font-semibold text-term-glow [text-shadow:0_0_4px_rgba(125,255,160,0.45)]">
          {isEdit ? t('post.editTitle') : t('post.createTitle')}
        </h1>
      </PageHeaderBar>
      <ShellPrompt command={promptCommand} className="mt-4 mb-3" />

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

        {/* 새 글에만: 샌드박스 안내 + "게시 후 AI 1차 답변 받기"(기본 ON) + 작업 강도(낮음/중간/높음).
            동작 매핑(부모 외형 / Aidit-Code 동작): 체크 OFF → 자동 에이전트 턴 생략(Thread 에서 수동 시작),
            강도 = reasoningEffort(Composer Feature B 와 동일 어휘). 편집 모드에선 숨김(재실행 방지). */}
        {!isEdit && (
          <div className="space-y-2">
            {/* 부모 Aidit PersonaEditor 힌트와 동일한 섹션 박스(테두리+info 배경). */}
            <p className="rounded-[2px] border border-term-border bg-term-modal px-3 py-2 font-mono text-xs leading-relaxed text-term-dim">
              ! {t('post.sandboxNotice')}
            </p>

            <label className="flex items-center gap-2 font-mono text-sm text-term-dim">
              <input
                type="checkbox"
                checked={firstAgent}
                onChange={(e) => setFirstAgent(e.target.checked)}
                disabled={busy}
                className="h-4 w-4 rounded-[2px] accent-[#3fa564]"
              />
              <span>{t('post.aiFirstReply')}</span>
            </label>

            {/* 작업 강도 — 체크 ON 일 때만. ACTIVE = amber 브래킷(Composer 동일 스타일). */}
            {firstAgent && (
              <div
                role="radiogroup"
                aria-label={t('thread.reasoningEffortAria')}
                className="ml-6 flex items-center gap-1.5 border-l border-term-border pl-3"
              >
                {REASONING_EFFORTS.map((eff) => {
                  const label = t(
                    eff === 'low'
                      ? 'thread.reasoningEffortLow'
                      : eff === 'medium'
                        ? 'thread.reasoningEffortMedium'
                        : 'thread.reasoningEffortHigh'
                  );
                  const active = effort === eff;
                  return (
                    <button
                      key={eff}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setEffort(eff)}
                      disabled={busy}
                      className={`flex min-h-[44px] select-none items-center rounded-[2px] border px-2 font-mono text-xs font-bold transition disabled:opacity-50 ${
                        active
                          ? 'border-term-amber text-term-amber'
                          : 'border-term-border text-term-dim hover:text-term-fg-bright'
                      }`}
                    >
                      {active ? `[${label}]` : label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="font-mono text-xs text-term-red" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!title.trim() || busy || loadingPost}
          className="min-h-[44px] w-full rounded-[2px] border border-term-active bg-term-cta px-4 py-2.5 text-sm font-bold text-term-glow glow-lg shadow-glow-cta transition disabled:cursor-not-allowed disabled:opacity-50"
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
