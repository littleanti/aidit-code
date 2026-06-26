// src/i18n/dicts/profile.ts — profile + settings (WIREFRAME §9 / §9.1).
export const profile = {
  ko: {
    tabPosts: '게시글',
    tabBookmarks: '북마크',
    postsEmpty: '작성한 글이 없어요',
    bookmarksEmpty: '북마크한 글이 없어요',
    loginRequired: '로그인이 필요해요',
    settingsLabel: '설정',
    settingsLink: '설정 열기',
    // settings — keys per WIREFRAME §9.1
    'settings.title': '설정',
    'settings.back': '‹ /me',
    'settings.runtime.label': '런타임',
    'settings.runtime.serverManaged': 'LLM 키는 서버에서 관리됩니다',
    'settings.language.label': '언어 / Language',
    'settings.logout': '로그아웃',
  },
  en: {
    tabPosts: 'posts',
    tabBookmarks: 'bookmarks',
    postsEmpty: 'No posts yet',
    bookmarksEmpty: 'No bookmarks yet',
    loginRequired: 'Login required',
    settingsLabel: 'Settings',
    settingsLink: 'Open settings',
    'settings.title': 'Settings',
    'settings.back': '‹ /me',
    'settings.runtime.label': 'Runtime',
    'settings.runtime.serverManaged': 'LLM keys are managed on the server',
    'settings.language.label': '언어 / Language',
    'settings.logout': 'Logout',
  },
} as const;
