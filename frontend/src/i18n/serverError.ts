// src/i18n/serverError.ts — map server/agent/sandbox/session error signals to an
// i18n error key (TRD §11 error matrix · §14.6 error dictionary). Used by FE-STATES
// and SYSTEM-notice rendering so KO/EN messages stay centralized in dicts/errors.ts.
//
// HARD RULE: never surface a raw server message that could leak internals — always
// resolve to a curated key. The agent/session/sandbox failures map to safe phrasing.
import type { ApiError } from '../api/rest';
import type { AgentSessionStatus, SandboxStatus } from '../api/types';

/** Error i18n keys defined in dicts/errors.ts (keep in sync). */
export type ErrorKey =
  | 'sessionFailed'
  | 'agentFailed'
  | 'toolFailed'
  | 'sandboxError'
  | 'pathDenied'
  | 'rateLimited'
  | 'networkError'
  | 'unauthorized'
  | 'generic';

/** Map an HTTP-ish ApiError to a curated error key (TRD §11). */
export function errorKeyForApi(err: ApiError): ErrorKey {
  switch (err.status) {
    case 0:
      return 'networkError';
    case 401:
    case 403:
      return err.status === 403 && /path/i.test(err.message) ? 'pathDenied' : 'unauthorized';
    case 429:
      return 'rateLimited';
    default:
      return 'generic';
  }
}

/**
 * Map a terminal session.status to a SYSTEM-notice key, or null when the status
 * needs no user-facing notice (TRD §11). ERROR → sessionFailed.
 */
export function errorKeyForSession(status: AgentSessionStatus): ErrorKey | null {
  return status === 'ERROR' ? 'sessionFailed' : null;
}

/**
 * Map a sandbox.status to a SYSTEM-notice key, or null when no notice is needed.
 * ERROR → sandboxError (TRD §11).
 */
export function errorKeyForSandbox(status: SandboxStatus): ErrorKey | null {
  return status === 'ERROR' ? 'sandboxError' : null;
}
