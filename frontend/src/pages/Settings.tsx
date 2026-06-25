// src/pages/Settings.tsx
// Language toggle + Logout. EXPLICITLY no API Key section. Shows a term-dim note that LLM keys
// are managed on the server (WIREFRAME §9.1). Only term-* tokens; touch targets >=44px.
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import LangToggle from '../components/LangToggle';

export default function Settings() {
  const t = useT();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);

  function handleLogout() {
    logout(); // clears token + identity
    navigate('/');
  }

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
