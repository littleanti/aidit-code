// src/i18n/dicts/workspace.ts — M6 workspace panel (file tree + file view).
// User-facing strings only; no hardcoded UI text elsewhere.
export const workspace = {
  ko: {
    title: '작업공간',
    tabChat: '대화',
    tabFiles: '파일',
    loading: '불러오는 중…',
    empty: '파일이 없어요.',
    error: '파일을 불러오지 못했어요.',
    retry: '다시 시도',
    selectPrompt: '파일을 선택하면 내용이 표시됩니다.',
    binary: '바이너리 파일 ({size} 바이트)',
    truncated: '— 파일이 잘렸습니다 (일부만 표시) —',
    fileEmpty: '(빈 파일)',
    modified: '변경됨',
    bytes: '{size} 바이트',
  },
  en: {
    title: 'Workspace',
    tabChat: 'Chat',
    tabFiles: 'Files',
    loading: 'Loading…',
    empty: 'No files.',
    error: 'Failed to load files.',
    retry: 'Retry',
    selectPrompt: 'Select a file to view its contents.',
    binary: 'binary file ({size} bytes)',
    truncated: '— file truncated (showing partial content) —',
    fileEmpty: '(empty file)',
    modified: 'modified',
    bytes: '{size} bytes',
  },
} as const;
