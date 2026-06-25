// src/i18n/dicts/thread.ts — chat bubbles / composer / tool & terminal / session & sandbox status.
// Shape mirrors docs/TRD.md §14.2.
export const thread = {
  ko: {
    composerPlaceholder: '메시지를 입력하세요… (AI on이면 에이전트가 응답)',
    aiToggleOn: 'AI 켜짐',
    aiToggleOff: 'AI 꺼짐',
    agentThinking: '에이전트가 작업 중…',
    sandboxRunning: '실행 중',
    sandboxReady: '준비됨',
    sandboxError: '오류',
    toolRunning: '실행 중…',
  },
  en: {
    composerPlaceholder: 'Type a message… (agent replies when AI is on)',
    aiToggleOn: 'AI on',
    aiToggleOff: 'AI off',
    agentThinking: 'Agent is working…',
    sandboxRunning: 'Running',
    sandboxReady: 'Ready',
    sandboxError: 'Error',
    toolRunning: 'Running…',
  },
} as const;
