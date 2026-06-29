// src/i18n/dicts/post.ts — feed (Home), create, post card, status badges.
export const post = {
  ko: {
    sortHot: '인기',
    sortNew: '최신',
    feedEmpty: '아직 게시글이 없어요',
    emptyHot: '아직 인기 게시글이 없어요.',
    emptyNew: '아직 게시글이 없어요.',
    writeFirst: '+ 첫 게시글 쓰기',
    upvote: '추천',
    comments: '댓글',
    bookmark: '북마크',
    // status badge labels (sandbox)
    statusCreating: 'CREATING',
    statusReady: 'READY',
    statusRunning: 'RUNNING',
    statusSuspended: 'SUSPENDED',
    statusError: 'ERROR',
    statusNone: '준비 안 됨',
    // create page
    createTitle: '게시글 작성',
    titleLabel: '제목',
    titlePlaceholder: 'FastAPI 헬스체크 만들어줘',
    bodyLabel: '본문 / 작업 지시',
    bodyPlaceholder: '/health 라우트 + pytest 추가…',
    sandboxNotice:
      '게시하면 이 게시글 전용 샌드박스가 자동 생성되고 코드 에이전트가 붙습니다.',
    publish: '[ 게시하기 ]',
    publishing: '[ 게시 중… ]',
    aiFirstReply: '게시 후 AI 1차 답변 받기 (답변 깊이)',
    // XC-MODE(M8) — 동시 병렬 협업 opt-in 게이트(기본 OFF). 모드는 생성 시 1회 확정·변경 불가.
    concurrentLabel: '실시간 동시 협업 (실험적)',
    concurrentDesc:
      '동시에 물어도 서로 안 기다리고 각자 답이 즉시 옵니다. 파일은 순차로 안전하게 적용됩니다.',
    concurrentWarning:
      '⚠ 끄면 순차 처리됩니다. 동시 요청 수만큼 LLM 비용이 늘고, 같은 파일을 동시에 고치면 마지막 쓰기가 이깁니다(last-wins).',
    loginToPost: '게시글을 작성하려면 로그인이 필요해요',
    // 편집 모드(CreatePost 재활용 — 부모 Aidit 패리티)
    editTitle: '게시글 수정',
    save: '[ 저장 ]',
    saving: '[ 저장 중… ]',
    editLoadError: '게시글을 불러오지 못했어요.',
    // thread placeholder
    originalPost: '원본 게시글',
    originalPostTag: '★ 원본 게시글',
    threadComingSoon: '에이전트 세션 채팅은 다음 단계(M4)에서 제공됩니다.',
  },
  en: {
    sortHot: 'Hot',
    sortNew: 'New',
    feedEmpty: 'No posts yet',
    emptyHot: 'No popular posts yet.',
    emptyNew: 'No posts yet.',
    writeFirst: '+ Write the first post',
    upvote: 'Upvote',
    comments: 'Comments',
    bookmark: 'Bookmark',
    statusCreating: 'CREATING',
    statusReady: 'READY',
    statusRunning: 'RUNNING',
    statusSuspended: 'SUSPENDED',
    statusError: 'ERROR',
    statusNone: 'Not ready',
    createTitle: 'New post',
    titleLabel: 'Title',
    titlePlaceholder: 'Build a FastAPI health check',
    bodyLabel: 'Body / task instructions',
    bodyPlaceholder: 'Add a /health route + pytest…',
    sandboxNotice:
      'Publishing auto-creates a dedicated sandbox for this post and attaches a code agent.',
    publish: '[ Publish ]',
    publishing: '[ Publishing… ]',
    aiFirstReply: 'Get first AI reply after posting (reply depth)',
    // XC-MODE(M8) — concurrent collaboration opt-in gate (default OFF). Locked once at creation.
    concurrentLabel: 'Real-time concurrent collaboration (experimental)',
    concurrentDesc:
      "Ask at the same time without waiting on each other — everyone's reply streams instantly. Files are applied sequentially and safely.",
    concurrentWarning:
      '⚠ When off, requests are processed sequentially. LLM cost grows with the number of concurrent requests, and editing the same file at once is last-wins.',
    loginToPost: 'Login is required to create a post',
    // Edit mode (CreatePost reuse — Aidit parity)
    editTitle: 'Edit post',
    save: '[ Save ]',
    saving: '[ Saving… ]',
    editLoadError: 'Could not load the post.',
    originalPost: 'Original post',
    originalPostTag: '★ Original Post',
    threadComingSoon: 'Agent session chat arrives in the next stage (M4).',
  },
} as const;
