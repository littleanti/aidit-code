// src/pages/Settings.tsx
// /me/settings — 부모 Aidit 동일 구조: PageHeaderBar(제목 + [ ← 프로필 ] 백링크) +
// ShellPrompt("cat ~/.config") + 카드형 섹션(Runtime 읽기전용 / Language / Logout).
// 보안: API 키 입력 섹션 없음 — LLM 키는 서버 .env 에서만 관리. 읽기전용 runtime 행
// (GET /runtime → 'model @ host') + 서버 관리 안내만 노출. Only term-* tokens; copy via i18n.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { getRuntime } from '../api/rest';
import LangToggle from '../components/LangToggle';
import PageHeaderBar from '../components/PageHeaderBar';
import ShellPrompt from '../components/ShellPrompt';
import type { RuntimeInfo } from '../api/types';

export default function Settings() {
  const t = useT();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);

  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);

  // Read-only runtime info ('model @ host'). Best-effort: silently absent on failure.
  // HARD RULE: the payload is { model, baseURLHost } — never a key/secret.
  useEffect(() => {
    let alive = true;
    getRuntime()
      .then((r) => {
        if (alive) setRuntime(r);
      })
      .catch(() => {
        /* leave the row blank; the server-managed note still renders */
      });
    return () => {
      alive = false;
    };
  }, []);

  function handleLogout() {
    logout(); // clears token + identity
    navigate('/');
  }

  const runtimeLine = runtime
    ? runtime.baseURLHost
      ? `${runtime.model} @ ${runtime.baseURLHost}`
      : runtime.model
    : null;

  return (
    <div className="pb-6 font-mono">
      {/* 고정 상단바: 제목 + [ ← 프로필 ] 백링크(부모 동일) */}
      <PageHeaderBar>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-term-glow [text-shadow:0_0_4px_rgba(125,255,160,0.45)]">
          {t('profile.settings.title')}
        </h1>
        <Link
          to="/me"
          className="inline-flex h-8 shrink-0 items-center rounded-[2px] border border-term-line px-3 text-sm font-semibold text-term-dim transition hover:border-term-fg-bright hover:text-term-fg-bright"
        >
          {t('profile.settings.back')}
        </Link>
      </PageHeaderBar>

      <ShellPrompt command="cat ~/.config" className="mt-4 mb-3" />

      <div className="space-y-8">
        {/* Runtime (읽기전용) — 카드 + 코너 태그. API 키 입력 섹션은 정책상 없음. */}
        <section className="relative rounded-[2px] border border-term-line bg-term-panel p-4">
          <span className="absolute -top-2 left-3 select-none bg-term-panel px-1.5 text-[11px] font-bold uppercase tracking-wider text-term-faint">
            {t('profile.settings.runtime.label')}
          </span>
          {runtimeLine && (
            <p className="mb-1 text-sm text-term-fg" aria-live="polite">
              {runtimeLine}
            </p>
          )}
          <p className="text-xs leading-relaxed text-term-dim">
            ⚠ {t('profile.settings.runtime.serverManaged')}
          </p>
        </section>

        {/* Language (LangToggle variant="setting") */}
        <section className="rounded-[2px] border border-term-line bg-term-panel p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-term-fg-bright">
              {t('profile.settings.language.label')}
            </span>
            <LangToggle variant="setting" />
          </div>
        </section>

        {/* Logout */}
        <section className="rounded-[2px] border border-term-line bg-term-panel p-4">
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-[2px] border border-term-red px-4 text-sm font-semibold text-term-red transition hover:bg-term-hover"
          >
            {t('profile.settings.logout')}
          </button>
        </section>
      </div>
    </div>
  );
}
