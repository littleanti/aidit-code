// src/components/LoginModal.tsx
// Modal overlay (WIREFRAME §1). 2 segmented tabs (Login / Register; active = term-amber) + guest entry.
// On success: store auth via authStore.setAuth and close. NO API key field anywhere.
// Closes on backdrop / [x] click. Touch targets >=44px. Only term-* tokens.
import { useState } from 'react';
import { useT } from '../i18n/useT';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { register, session, guest, ApiError } from '../api/rest';
import type { AuthResult } from '../api/types';

type Mode = 'login' | 'register';

export default function LoginModal() {
  const open = useUiStore((s) => s.loginOpen);
  const closeLogin = useUiStore((s) => s.closeLogin);
  if (!open) return null;
  return <LoginModalBody onClose={closeLogin} />;
}

function LoginModalBody({ onClose }: { onClose: () => void }) {
  const t = useT();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function applyAuth(res: AuthResult) {
    setAuth({ userId: res.id, username: res.username, token: res.token });
    onClose();
  }

  function handleError(e: unknown) {
    if (e instanceof ApiError && e.status === 409) {
      setError(t('auth.errFailed'));
    } else {
      setError(t('auth.errFailed'));
    }
  }

  const memberValid =
    username.trim().length > 0 &&
    password.length >= 8 &&
    (mode === 'login' || password === confirm);

  async function submitMember(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError(t('auth.errPasswordLength'));
      return;
    }
    if (mode === 'register' && password !== confirm) {
      setError(t('auth.errPasswordMismatch'));
      return;
    }
    setBusy(true);
    try {
      const res =
        mode === 'register'
          ? await register(username.trim(), password)
          : await session(username.trim(), password);
      applyAuth(res);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  const nicknameValid =
    nickname.trim().length > 0 &&
    nickname.trim().length <= 16 &&
    !nickname.includes('#');

  async function submitGuest() {
    setError(null);
    const n = nickname.trim();
    if (n.includes('#')) {
      setError(t('auth.errNicknameHash'));
      return;
    }
    if (n.length > 16) {
      setError(t('auth.errNicknameLength'));
      return;
    }
    if (n.length === 0) return;
    setBusy(true);
    try {
      applyAuth(await guest(n));
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  const mismatch = mode === 'register' && confirm.length > 0 && password !== confirm;
  const inputCls =
    'w-full rounded-[2px] border border-term-border-dim bg-term-sunken px-3 py-2 font-mono text-sm text-term-fg-bright placeholder:text-term-faint focus:border-term-active';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(2,8,5,0.82)] p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('common.login')}
    >
      <div
        className="relative w-full max-w-sm rounded-[3px] border border-term-active bg-term-modal p-5 shadow-[0_0_32px_rgba(43,212,111,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="absolute right-2 top-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center font-mono text-term-dim hover:text-term-fg-bright"
        >
          [x]
        </button>

        <div className="mb-4 text-center">
          <div className="font-mono text-lg font-bold tracking-[0.2em] text-term-glow">
            ⚡ {t('common.appName')}
          </div>
          <p className="mt-1 font-mono text-xs text-term-dim">{t('auth.subtitle')}</p>
        </div>

        {/* 2-tab segmented control */}
        <div className="mb-4 flex border-b border-term-line" role="tablist">
          {(['login', 'register'] as Mode[]).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={[
                  'min-h-[44px] flex-1 font-mono text-sm',
                  active
                    ? 'border-b-2 border-term-amber text-term-amber'
                    : 'text-term-dim hover:text-term-fg-bright',
                ].join(' ')}
              >
                {m === 'login' ? t('auth.tabLogin') : t('auth.tabRegister')}
              </button>
            );
          })}
        </div>

        <form onSubmit={submitMember} className="space-y-3">
          <div>
            <label className="mb-1 block font-mono text-xs text-term-dim">
              {t('auth.username')}
            </label>
            <input
              className={inputCls}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('auth.usernamePlaceholder')}
              autoComplete="username"
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-xs text-term-dim">
              {t('auth.password')}
            </label>
            <input
              type="password"
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </div>
          {mode === 'register' && (
            <div>
              <label className="mb-1 block font-mono text-xs text-term-dim">
                {t('auth.passwordConfirm')}
              </label>
              <input
                type="password"
                className={inputCls}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t('auth.passwordPlaceholder')}
                aria-invalid={mismatch}
                autoComplete="new-password"
              />
              {mismatch && (
                <p className="mt-1 font-mono text-xs text-term-red">
                  {t('auth.errPasswordMismatch')}
                </p>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={!memberValid || busy}
            className="min-h-[44px] w-full rounded-[2px] border border-term-border bg-term-cta font-mono text-sm text-term-fg-bright disabled:opacity-40"
          >
            {t('auth.submit')}
          </button>
        </form>

        {/* Guest entry */}
        <div className="mt-4 border-t border-term-line pt-4">
          <p className="mb-2 font-mono text-xs text-term-dim">{t('auth.guestDivider')}</p>
          <div className="flex gap-2">
            <input
              className={inputCls}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={t('auth.nickname')}
              maxLength={16}
              aria-label={t('auth.nickname')}
            />
            <button
              type="button"
              onClick={submitGuest}
              disabled={!nicknameValid || busy}
              className="min-h-[44px] shrink-0 rounded-[2px] border border-term-border px-3 font-mono text-sm text-term-fg hover:text-term-fg-bright disabled:opacity-40"
            >
              {t('auth.guestSubmit')}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-3 font-mono text-xs text-term-red" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
