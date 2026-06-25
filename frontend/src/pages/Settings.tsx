// src/pages/Settings.tsx
// /me/settings — LangToggle (variant setting, active term-amber) + read-only runtime info row
// (GET /runtime → 'model @ host') + an explicit term-dim note that LLM keys are server-managed +
// Logout (border/text term-red) that clears the token and routes to '/'.
// ABSOLUTELY NO API Key input/section. Only term-* tokens; copy via i18n; touch targets >=44px.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { getRuntime } from '../api/rest';
import LangToggle from '../components/LangToggle';
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
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate('/me')}
          className="inline-flex min-h-[44px] items-center font-mono text-sm text-term-dim hover:text-term-fg-bright"
        >
          {t('profile.settings.back')}
        </button>
        <span className="font-mono text-xs text-term-dim">{t('profile.settings.title')}</span>
      </div>

      <div className="mb-3 font-mono text-xs text-term-dim">aidit@web:~$ cat ~/.config</div>

      {/* Runtime (read-only) — NO API key section. */}
      <section className="mb-6 border-t border-term-line pt-4">
        <h2 className="mb-2 font-mono text-xs uppercase tracking-wider text-term-dim">
          {t('profile.settings.runtime.label')}
        </h2>
        {runtimeLine && (
          <p className="mb-1 font-mono text-sm text-term-fg" aria-live="polite">
            {runtimeLine}
          </p>
        )}
        <p className="font-mono text-xs text-term-dim">
          ⚠ {t('profile.settings.runtime.serverManaged')}
        </p>
      </section>

      {/* Language */}
      <section className="mb-6 border-t border-term-line pt-4">
        <h2 className="mb-2 font-mono text-xs uppercase tracking-wider text-term-dim">
          {t('profile.settings.language.label')}
        </h2>
        <LangToggle variant="setting" />
      </section>

      {/* Account */}
      <section className="border-t border-term-line pt-4">
        <button
          type="button"
          onClick={handleLogout}
          className="min-h-[44px] w-full rounded-[2px] border border-term-red px-4 font-mono text-sm text-term-red hover:bg-term-red/10"
        >
          {t('profile.settings.logout')}
        </button>
      </section>
    </div>
  );
}
