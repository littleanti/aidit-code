// src/i18n/dicts/errors.ts — agent/session/tool/network errors. VERBATIM shape from TRD §14.6.
// Server LLM keys are never exposed in any error message (§8).
export const errors = {
  ko: {
    sessionFailed: '에이전트 세션 시작에 실패했습니다. 다시 시도하세요.',
    agentFailed: '에이전트 응답 생성에 실패했습니다.',
    toolFailed: '도구 실행이 실패했습니다. (종료코드 {code})',
    sandboxError: '샌드박스 오류 — 재생성이 필요할 수 있습니다.',
    pathDenied: '샌드박스 경로 밖은 접근할 수 없습니다.',
    rateLimited: '요청이 많습니다 — 잠시 후 재시도하세요.',
    networkError: '네트워크 오류 — 재시도 중…',
    unauthorized: '로그인이 필요하거나 세션이 만료되었습니다.',
    generic: '요청을 처리하지 못했습니다.',
  },
  en: {
    sessionFailed: 'Failed to start the agent session. Please retry.',
    agentFailed: 'Failed to generate the agent response.',
    toolFailed: 'Tool execution failed. (exit code {code})',
    sandboxError: 'Sandbox error — it may need to be recreated.',
    pathDenied: 'Access outside the sandbox path is not allowed.',
    rateLimited: 'Too many requests — please retry shortly.',
    networkError: 'Network error — retrying…',
    unauthorized: 'Login required or your session has expired.',
    generic: 'Could not process the request.',
  },
} as const;
