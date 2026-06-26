# Aidit-Code — 구현 노트 / 변경 이력 (IMPLEMENTATION_NOTES)

> [`CLAUDE.md`](../CLAUDE.md)·[`AGENTS.md`](../AGENTS.md)의 **GR-1**에 따라, 코드 변경은 여기에 먼저 기록한다.
> 작성 규칙:
> - 최신 항목을 **맨 위**에 둔다.
> - 각 항목: `날짜(절대) · [태그] · 상태 · 요약` + 변경 파일 경로.
> - 태그: `[feat]` / `[fix]` / `[test]` / `[docs]` / `[chore]`
> - 상태: `진행중`(착수 시 기록) → 검증 통과 후 `완료`로 변경 → 그 뒤 커밋·푸시.

---

## Changelog

### 2026-06-27 · [fix] · 완료 · 피드/프로필 EOF 줄을 부모 Aidit 스타일로 — `─── EOF ───` → `— EOF · <문구> —` (한국어 매칭)
- **요청(사용자)**: Aidit-Code의 EOF 표시를 부모 Aidit처럼 `— EOF · No more posts —` 형태로, 한국어도 부모 문구에 매칭.
- **현황 비교**: Aidit-Code는 `Home.tsx`·`Profile.tsx`가 공통 `common.eof:'EOF'`를 `─── {eof} ───`(박스 대시)로 감싸 `─── EOF ───` 표시. 부모 Aidit는 페이지별 문구에 데코를 내장해 bare 렌더 — `home.eof` ko `— EOF · 마지막 게시글이에요 —`/en `— EOF · No more posts —`, `profile.eof` ko `— EOF · 마지막이에요 —`/en `— EOF · Nothing more —`.
- **방향(부모 문구 그대로 매칭)**: Aidit-Code엔 `home` 네임스페이스가 없어 **피드(Home)는 `common.eof`를 재사용**해 ko `— EOF · 마지막 게시글이에요 —`/en `— EOF · No more posts —`로, **프로필은 신규 `profile.eof`** ko `— EOF · 마지막이에요 —`/en `— EOF · Nothing more —` 추가. 렌더 사이트의 `─── … ───` 래핑 제거하고 bare `{t(...)}`로(데코는 문자열에 내장, 부모와 동일). 스타일 클래스(`text-term-dim-3 font-mono text-xs`)는 유지.
- **구현(예정)**: `frontend/src/i18n/dicts/common.ts`(eof 문자열), `frontend/src/i18n/dicts/profile.ts`(eof 키 추가), `frontend/src/pages/Home.tsx`(L111 래핑 제거), `frontend/src/pages/Profile.tsx`(L75 → `profile.eof`).
- **검증(③) — 실측**: FE `tsc --noEmit` **클린(EXIT 0)**. 브라우저(5173, KO) 홈 피드 하단 `<p>` = **`— EOF · 마지막 게시글이에요 —`** 노출 확인(기존 `─── EOF ───` 대체). 프로필(`/me`)은 현재 로그인 계정에 게시글이 없어 EOF 블록 미렌더이나 `t('profile.eof')` **원시 키 노출 없음**(key leak=false) + tsc로 키 존재 확인.
- 변경 파일: `frontend/src/i18n/dicts/common.ts`, `frontend/src/i18n/dicts/profile.ts`, `frontend/src/pages/Home.tsx`, `frontend/src/pages/Profile.tsx`, `docs/IMPLEMENTATION_NOTES.md`.


### 2026-06-27 · [fix] · 완료 · 헤더 LLM 상태 배지 표기 `LLM`→`AI` (부모 Aidit와 용어 통일)
- **요청(사용자)**: Aidit-Code 헤더 연결 배지의 `LLM` 표기도 `AI`로 변경. (부모 Aidit는 앞서 `● AI` 라벨 + 툴팁 `AI`로 통일됨 — 형제 앱 용어 일치.)
- **방향(텍스트만)**: 반응형 동작(`hidden sm:inline`, 640px 기준 — 좁으면 숨김/넓으면 표시)은 **그대로 유지**하고 **표시 문구만** 변경. ① `LlmStatusBadge`의 가시 라벨 `LLM`→`AI`(클래스 불변), ② i18n `common.llmConnected/Offline/Unknown`의 `LLM`→`AI`(ko·en, aria-label·title용). 상태 로직·LED 색상 불변.
- **구현(예정)**: `frontend/src/components/LlmStatusBadge.tsx`(라벨 텍스트만), `frontend/src/i18n/dicts/common.ts`(llm* 문자열).
- **검증(③) — 실측**: FE `tsc --noEmit` **클린(EXIT 0)**. 브라우저(5173, 폭 1245px) 헤더 span 텍스트 = `AIDIT-CODE`·`● AI`·`KO|EN`·`[ wdyoon#e1eb ]` — `● AI` 노출, **`LLM` 잔존 없음**(`anyLLMleft=false`), `AI` 라벨 클래스 `hidden … sm:inline` 그대로 가시(반응형 동작 보존).
- 변경 파일: `frontend/src/components/LlmStatusBadge.tsx`, `frontend/src/i18n/dicts/common.ts`, `docs/IMPLEMENTATION_NOTES.md`.



### 2026-06-26 · [fix] · 완료 · 작성 페이지 게시 버튼 + 하단 탭바 글씨를 부모 Aidit 디자인과 통일 (+ 버튼/메뉴 대괄호·안내 섹션박스·⋯팝오버 여백)
- **요청(사용자)**: ① Aidit-Code 작성 페이지의 "게시하기" 버튼을 부모 Aidit 작성 페이지 게시 버튼과 **동일 디자인**으로. ② Aidit-Code 하단 메뉴바의 **글씨 크기·글씨 폰트·글씨 위치**를 부모 Aidit 하단 메뉴바와 통일.
- **현황 비교**:
  - 게시 버튼 — 부모: `border-term-cta bg-gradient-to-b from-[#155230] to-[#0c3a20] text-sm font-bold text-term-title glow-lg shadow-glow-cta transition disabled:cursor-not-allowed disabled:opacity-50`(인광 라이즈드 버튼). Aidit-Code: `border-term-border bg-term-cta text-term-fg-bright`(평면, glow 없음).
  - 하단 탭바 라벨 — 부모: `text-xs`(12px) + 기본 mono. Aidit-Code: `text-[10px]`(10px) + `font-mono`. 폰트 스택은 두 앱 `font-mono`가 글자단위 동일.
- **방향(토큰 매핑 — Aidit-Code엔 부모와 이름이 다른 동일 색이 이미 존재)**: `border-term-cta`→`border-term-active`(둘 다 #3fa564), `text-term-title`→`text-term-glow`(둘 다 #7dffa0), `bg-gradient…`→`bg-term-cta`(Aidit-Code 토큰이 동일 그라디언트). 누락분만 추가: boxShadow `glow-cta`(→`shadow-glow-cta`), 유틸 `.glow`/`.glow-lg`(text-shadow). 탭바는 `text-[10px]`→`text-xs`(폰트/위치는 이미 동일).
- **추가 요청(후속, 동일 작업 중)**:
  - ③ 게시 버튼 라벨을 부모 Aidit처럼 대괄호로: `게시하기`→`[ 게시하기 ]` 등. 편집 모드 저장 버튼도 같은 버튼이라 동일하게 대괄호 처리(부모 `btn_*` 전체가 대괄호 — `[ 게시하기 ]`/`[ 게시 중… ]`/`[ 저장 ]`/`[ 저장 중… ]`, EN 동일).
  - ④ 샌드박스 안내문(`! 게시하면 …`)을 평면 텍스트→부모 Aidit `PersonaEditor` 힌트와 동일한 **섹션 박스**로: `rounded-[2px] border border-term-border bg-term-modal px-3 py-2 text-xs leading-relaxed text-term-dim`(부모 `bg-term-info`=#06190e → Aidit-Code `bg-term-modal`=#06190e 동일).
  - ⑤ Thread ⋯ 메뉴의 게시글 편집/삭제 라벨을 부모 Aidit처럼 대괄호로: `편집`→`[ 편집 ]`, `삭제`→`[ 삭제 ]`(EN `[ Edit ]`/`[ Delete ]`). 두 키는 메뉴 아이템 본문 전용(확인 다이얼로그 `deleteConfirm/Yes/No`·aria 미사용)이라 부작용 없음.
  - ⑥ ⋯ 팝오버 폭 조정(두 앱 공통). **측정(브라우저 canvas, text-xs mono + px-3)**: `[ Delete ]`=**90px**(메뉴 상태 최장 단일행), `[ Edit ]`=77px, `[ 삭제 ]`/`[ 편집 ]`=72px(한글이 더 좁음). 기존 `w-36`=144px는 `[ Delete ]` 기준 우측 ~54px(약 1/3) 빈 공간.
    - **1차 시도(`w-fit max-w-[9rem]`) → 실패/되돌림**: `w-fit`(fit-content)이 절대배치+래핑 가능 콘텐츠에서 **min-content로 수축**, 라벨의 공백(`[ Delete ]`의 스페이스)이 줄바꿈 기회가 되어 `[`/`Delete`/`]`가 **3줄로 깨짐**(한·영 모두 과도하게 좁아짐).
    - **확정(고정폭 `w-28`=112px)**: 사용자 요청대로 **영어 최장 라벨 기준으로 고정폭을 정하고 한·영 동일 적용**. 90px 콘텐츠 + 22px 여백으로 `[ Delete ]`가 한 줄에 들어오고(래핑 없음), 144px 대비 여백 32px 축소. 고정폭이라 언어 무관 동일 가로. 삭제 확인 긴 문구는 112px 안에서 자연 줄바꿈. **부모 Aidit도 동일 1줄 수정**(`bg-term-card`만 다르고 폭 클래스 동일).
- **구현(예정)**: `frontend/tailwind.config.js`(boxShadow `glow-cta` 추가), `frontend/src/index.css`(`@layer utilities`에 `.glow`/`.glow-lg`), `frontend/src/pages/CreatePost.tsx`(게시 버튼 className + 안내문 섹션 박스), `frontend/src/layout/AppShell.tsx`(TabBar 라벨 `text-[10px]`→`text-xs`), `frontend/src/i18n/dicts/post.ts`(버튼 라벨 대괄호).
- **검증(④) — 실측**: FE `tsc --noEmit` **클린(EXIT 0)** — Aidit-Code·부모 Aidit 양쪽. 브라우저(5173) 작성 페이지에서 ① 게시 버튼이 인광 그라디언트+밝은 글로우 텍스트(`text-term-glow`+`glow-lg`)+`shadow-glow-cta`로 부모 라이즈드 CTA와 동일 외형(활성 시), ② 라벨 `[ 게시하기 ]`, ③ 샌드박스 안내가 테두리+info 배경 섹션 박스, ④ 하단 탭바 글씨 `text-xs`로 확대됨을 스크린샷 확인. ⑤ ⋯팝오버 `[ 편집 ]`/`[ 삭제 ]` 대괄호 + 고정폭 `w-28`(112px)은 `tsc` 클린 + **브라우저 DOM 실측**으로 검증: 컨테이너 112px, `[ Delete ]`·`[ Edit ]` 모두 `getClientRects().length===1`(=한 줄, 래핑 없음, 텍스트 높이 14px) — 직전 `w-fit`의 3줄 깨짐 해소, `[ Delete ]`(90px) + ~20px 여백.
- 변경 파일(예정): `frontend/tailwind.config.js`, `frontend/src/index.css`, `frontend/src/pages/CreatePost.tsx`, `frontend/src/layout/AppShell.tsx`, `frontend/src/i18n/dicts/post.ts`, `docs/IMPLEMENTATION_NOTES.md`.


### 2026-06-26 · [fix] · 완료 · 샌드박스 작업경로를 절대경로 박제 대신 런타임 재계산(레포 이동/이름변경 내성)
- **배경(사고)**: 프로젝트 폴더명이 `Audit-Code`→`Aidit-Code`로 바뀌자, DB `Sandbox.path`에 **생성 시점 절대경로가 박제**돼 있어 세션 시작 시 `pi.ts` `spawn({cwd: sandbox.path})`가 `ENOENT`로 실패. 174개 글 중 171개가 세션 시작 불가 → (사용자 승인 후) 삭제 완료. 같은 일이 레포를 옮기거나 이름 바꾸거나 다른 머신/배포로 가면 또 재발하는 **설계 결함**.
- **원인**: `sandbox/service.ts createSandboxForPost`가 `resolveInsideRoot(config.sandboxRoot, postId)`로 만든 **절대경로**를 DB에 저장 → 호스트 경로에 종속. 소비처(spawn cwd, 도구 실행 root, 파일 트리, 디렉토리 삭제)가 모두 그 절대경로를 그대로 신뢰.
- **방향**: 저장된 `path`는 "힌트"로만 쓰고, 진짜 작업 디렉토리는 **(현재 `sandboxRoot`, `postId`)에서 매번 재계산**하는 단일 리졸버 `resolveSandboxDir({postId, path})` 도입. ① 저장 path가 현재 루트 안이면 그대로 사용 ② 루트 밖 + `basename === postId`(=createSandboxForPost 레이아웃 → 옛 루트 박제 케이스)면 표준 위치 `root/postId`가 **실제 존재할 때만** 자가복구 ③ 그 외(루트 밖 + basename≠postId = 의도적 외부 디렉토리/테스트 mkdtemp)는 저장 path 유지. → 레포 이동/이름변경에도 세션이 안 깨지고, out-of-root 테스트 디렉토리도 그대로 동작.
  - **basename 판별 추가 이유(검증 중 발견)**: 초기엔 "루트 밖 + canonical 존재 → 무조건 self-heal"이었으나, `redaction.test.ts`가 **API로 글 생성(→ `root/postId` 디렉토리 실재) 후 path를 외부 mkdtemp로 교정**하는 패턴이라 잘못 self-heal돼 도구가 외부 dir 대신 canonical에 파일을 써 실패. basename 판별로 의도적 외부 지정과 박제를 구분해 해결.
- **구현**: `sandbox/service.ts`(리졸버 `resolveSandboxDir` 추가), `agent/sessionStart.ts`(spawn 전 리졸브), `agent/turn.ts`(도구 root 리졸브, sandbox select에 `postId` 추가), `routes/files.ts`(파일 트리·내용 root 2곳 리졸브), `routes/posts.ts`(삭제 디렉토리 리졸브 — 박제 경로가 루트밖이라 기존엔 가드에 막혀 정리 실패하던 것도 해결), `config.ts`(주석의 옛 이름 `Audit-Code`→`Aidit-Code` 정정). 신규 단위테스트 `test/sandboxDir.test.ts`.
- **검증(③) — 실측**: backend `tsc --noEmit` 클린(EXIT 0). 백엔드 테스트 **85/85 통과(23 파일)** — 신규 `sandboxDir`(in-root 신뢰 / 박제 self-heal / 외부 보존 3케이스) + 기존 `redaction`·`sessionStart`·`toolCall`·`files`·`agentTurn` 그린.
- 변경 파일: `backend/src/sandbox/service.ts`·`agent/sessionStart.ts`·`agent/turn.ts`·`routes/files.ts`·`routes/posts.ts`·`config.ts`, `backend/test/sandboxDir.test.ts`, `docs/IMPLEMENTATION_NOTES.md`.
- **참고(데이터 사고 정리)**: 이 수정 전, 박제 경로로 세션 불가였던 글 171개를 사용자 승인 후 트랜잭션 삭제(메시지 94·투표 2·북마크 2·세션 33·툴콜 16·샌드박스 171 동반). 남은 글 3개. 이 수정 이후 생성되는 글은 레포 이동/이름변경에도 세션이 self-heal 된다.

### 2026-06-26 · [fix] · 완료 · 작성 페이지 체크박스 라벨에 "(답변 깊이)" 명시 (Aidit-Code 전용)
- **요청(사용자)**: `게시 후 AI 1차 답변 받기` → `게시 후 AI 1차 답변 받기 (답변 깊이)`, 매칭 영어도 반영.
- **범위**: Aidit-Code 의 `aiFirstReply` 만. Aidit-Code 의 낮음/중간/높음은 reasoning effort(=답변 깊이)라 라벨로 그 의미를 명확히 한다. 부모 Aidit 의 동일 라벨은 컨트롤이 "응답 길이"라 "깊이"가 맞지 않으므로 **건드리지 않음**.
- **변경**: KO `게시 후 AI 1차 답변 받기 (답변 깊이)`, EN `Get first AI reply after posting (reply depth)`.
- **검증(③) — 실측**: FE `tsc --noEmit` 클린(EXIT 0). 브라우저(5173) 작성 페이지 체크박스 라벨 = `게시 후 AI 1차 답변 받기 (답변 깊이)` 확인.
- 변경 파일(예정): `frontend/src/i18n/dicts/post.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 작성 페이지에 "게시 후 AI 1차 답변 받기" 체크박스 + 낮음/중간/높음(reasoning effort) — 외형은 부모, 동작은 Aidit-Code 매핑
- **요청(사용자)**: 부모 Aidit 작성 페이지의 "게시 후 AI 1차 답변 받기" 체크박스 + (짧게/보통/길게) 컨트롤을 Aidit-Code에도. 외형은 부모와 동일하게, 동작은 Aidit-Code식으로 매핑(옵션 4).
- **동작 매핑(부모와 다른 점)**:
  - 부모: AI=대화형 페르소나, 1차 답변 opt-in, "길이"=산문 분량. Aidit-Code: AI=코드 에이전트 세션, 게시 시 본문으로 자동 1턴(`maybeAutoReply`)이 **무조건** 실행됨.
  - **체크박스 "게시 후 AI 1차 답변 받기"**(기본 ON) → `autoReply` 플래그로 `maybeAutoReply` 실행 여부 제어. OFF면 게시만 하고 에이전트는 Thread의 [세션 시작]/메시지로 수동 실행.
  - **낮음/중간/높음** → 부모의 "응답 길이"는 코드 에이전트에 의미 없음 → 기존 **reasoning effort(low/medium/high)** 로 매핑. Aidit-Code엔 이미 Composer가 동일 3분할 셀렉터+i18n(`thread.reasoningEffort*`)+백엔드 배선(`runAgentTurn.reasoningEffort`→worker→`reasoning_effort`, reasoning 모델만 적용 게이트)을 보유 → 그대로 재사용. 작성 시 선택값이 자동 첫 턴의 effort가 됨(이후 메시지는 Composer가 따로 제어). 기본 medium.
- **구현(예정)**: FE `rest.ts createPost(title, body, { autoReply?, reasoningEffort? })`, `CreatePost.tsx`(체크박스+effort 세그먼트, 편집 모드 숨김, 체크 ON일 때만 세그먼트), `i18n/post.ts`(`ai_first_reply` 추가, effort 라벨/aria는 `thread.*` 재사용). BE `routes/posts.ts`(`autoReply`/`reasoningEffort` 파싱·검증, `maybeAutoReply(postId, reasoningEffort)` 게이트) + `maybeAutoReply`가 `runAgentTurn`에 effort 전달.
- **검증(③) — 실측**: FE `tsc` + BE `tsc` 클린(EXIT 0). 백엔드 테스트 19/19 통과(`reasoningEffort`·`deletePost`·`userPosts`). 브라우저(5173) 작성 페이지: 체크박스 기본 ON("게시 후 AI 1차 답변 받기") + 세그먼트 낮음/[중간]/높음(aria "추론 강도", 기본 medium), 체크 해제 시 세그먼트 숨김(radio 0)·재체크 시 복원(radio 3) 확인.
- 변경 파일(예정): `frontend/src/pages/CreatePost.tsx`·`api/rest.ts`·`i18n/dicts/post.ts`, `backend/src/routes/posts.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 나 페이지 탭(게시글/북마크)을 부모 공통 세그먼트 탭 스타일로 통일
- **요청(사용자)**: 부모 Aidit 홈 인기/최신·부모 나 페이지 커뮤니티/게시글/북마크·Aidit-Code 홈 인기/최신은 공통 탭 디자인을 공유하는데, Aidit-Code 나 페이지의 게시글/북마크 탭만 다르다 → 동일 디자인으로 통일.
- **현재(Aidit-Code 나 탭)**: `flex gap-4 ... px-1`(좌측 정렬, 폭 안 채움), 활성에만 `border-b-2`(틴트 없음), `font-semibold` 없음.
- **부모 공통 스타일(나 탭 = 직접 대응)**: 고정 상단바 아래 `sticky top-24 z-10 -mx-4 px-4 border-b`(풀블리드) + 내부 `flex`, 각 버튼 `min-h-[44px] flex-1 border-b-2 text-sm font-semibold transition`, 활성 `border-term-amber bg-[rgba(255,207,74,0.06)] text-term-amber` / 비활성 `border-transparent text-term-dim hover:text-term-fg-bright`.
- **방향**: Aidit-Code 나 탭을 위 스타일로 교체(토큰 매핑 term-border→term-line, term-screen 솔리드→term-nav, term-bright→term-fg-bright). 탭이 고정바(앱바 h-12 + PageHeaderBar h-12) 아래 `top-24`에 sticky. 패널 wrapper `mt-3` 제거(탭 컨테이너 `mb-3`로 간격 일원화).
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린(EXIT 0). 브라우저(5173) 나 탭 computed — flex-grow 1(균등 320px), fontWeight 600, 활성 border-bottom 1.6px amber(255,207,107) + bg rgba(255,207,74,0.06) + color amber, 비활성 투명 밑줄 + term-dim(79,191,114), 컨테이너 position:sticky top:96px(=top-24). 부모 나 탭과 버튼 스타일 수치 동일.
- 변경 파일(예정): `frontend/src/pages/Profile.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · UI 카피 용어 통일 — 게시물을 뜻하는 "글" → "게시글" (부모 Aidit 동시 적용)
- **요청(사용자)**: 나(프로필) 페이지에서 Aidit-Code는 "게시글", 부모 Aidit은 "글"로 불일치. 두 앱 모두 **게시물을 뜻하는 "글"을 "게시글"로 전부 통일**.
- **방향**: i18n 사전(KO)에서 post 의미의 `글` → `게시글`. 자연스러운 조사 유지(`글을`→`게시글을`, `글이`→`게시글이`, `글과`→`게시글과`). 일관성 위해 `인기글`→`인기 게시글`, `글쓰기`→`게시글 쓰기`도 포함. **"댓글"(comment)·코드 주석의 "글리프" 등 post와 무관한 "글"은 미변경.** EN(`post(s)`)은 이미 일관 → 미변경.
- **Aidit-Code 변경 키**: `post.ts`(emptyNew·writeFirst·createTitle·sandboxNotice·loginToPost·editTitle·editLoadError·emptyHot), `thread.ts`(deleteConfirm), `profile.ts`(postsEmpty·bookmarksEmpty). (이미 "게시글"인 feedEmpty·originalPost·tabPosts·ownerMenuAria 등은 그대로.)
- **검증(③) — 실측**: 두 frontend `tsc --noEmit` 클린(EXIT 0). i18n grep — `댓글`·`게시글` 제외 시 양쪽 사전에 "글" 0건(모든 post-글 전환, 댓글 보존). 브라우저: 나 페이지 탭 Aidit-Code=["게시글","북마크"], 부모 Aidit="커뮤니티 / 게시글 / 북마크" 확인. 잔존 bare post-"글" 없음.
- 변경 파일(예정): `frontend/src/i18n/dicts/post.ts`·`thread.ts`·`profile.ts`, `docs/IMPLEMENTATION_NOTES.md` + (부모 저장소) `frontend/src/i18n/dicts/post.ts`·`thread.ts`·`home.ts`·`profile.ts`·`community.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 한글까지 고정폭으로 통일 (D2Coding·NanumGothicCoding, 끝 monospace generic 제거) — 부모 Aidit 동시 적용
- **요청(사용자)**: 직전 통일(순수 시스템 스택)에선 한글이 Malgun Gothic(**비례폭**)으로 폴백돼 라틴(고정폭 Consolas)과 어긋났다. 한글도 **고정폭**으로 두 앱 모두 통일.
- **조사(브라우저 DOM 실측)**: Chrome 폰트 매칭 특이동작 발견 — 스택이 **`monospace` generic으로 끝나면** 앞에 명시한 한글 고정폭 폰트(D2Coding)를 건너뛰고 generic의 한글 폴백(Malgun, 288px)을 쓴다. generic을 빼고 **명시 폰트로 끝내면** D2Coding(264.96px, 고정폭)이 정상 적용된다. 또한 D2Coding을 스택에 넣어도 라틴은 그대로 Consolas(228.73px)로 유지된다(글리프 단위 매칭).
- **결정 스택(두 앱 공통, 끝에 generic 없음)**:
  `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'D2Coding', 'NanumGothicCoding'`
  → 라틴 = Consolas(직전 결정 유지), 한글 = **D2Coding 고정폭**(미설치 시 NanumGothicCoding → 브라우저 최종 폴백). **끝의 `monospace` generic은 의도적으로 제거** — 다시 넣으면 한글이 비례폭 Malgun으로 깨진다(위 특이동작).
- **적용**: `tailwind.config.js`(`fontFamily.mono`) + `index.css`(body). Tailwind preflight가 `code/pre`에도 `fontFamily.mono`를 적용하므로 마크다운 코드/터미널 출력 한글도 동일하게 고정폭. 부모 Aidit도 같은 스택으로 동시 수정(별도 저장소).
- **검증(③) — 실측**: 두 frontend `tsc --noEmit` 클린(EXIT 0). 브라우저 DOM에 결정 스택 주입 — Aidit-Code(5173): KO=264.96(D2Coding 고정폭)·EN=228.73(Consolas), 부모 Aidit(5174): KO 8자=117.76(14.72/자=D2Coding 고정폭). 두 앱 동일. ※ **라이브 반영엔 vite 재시작 필요** — vite가 stale tailwind.config를 require-cache에 들고 있어 `.font-mono` 유틸이 hot-reload되지 않음(편집 직후 5173/5174 `.font-mono` 모두 옛 스택 확인). 프로덕션 빌드는 config를 새로 읽으므로 정상.
- 변경 파일(예정): `frontend/tailwind.config.js`, `frontend/src/index.css`, `docs/WIREFRAME.md`(§12.2), `docs/IMPLEMENTATION_NOTES.md` + (부모 저장소) `frontend/tailwind.config.js`, `docs/DESIGN-SYSTEM.md`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 폰트 스택을 부모 Aidit 실제 코드와 동일하게 통일 (JetBrains Mono·D2Coding·Noto Sans KR 제거)
- **요청(사용자)**: Aidit과 Aidit-Code의 폰트체를 "Aidit이 쓰는 폰트체"로 전부 통일.
- **결정(사용자 확인)**: 부모 Aidit은 코드(`tailwind.config.js`)와 문서(DESIGN-SYSTEM.md)가 불일치 — 코드는 순수 시스템 모노 스택(JetBrains Mono 없음 → Windows 에서 Consolas 렌더), 문서는 풀 스택. 사용자가 **순수 시스템 스택**을 선택 → Aidit-Code 를 부모의 **실제 코드 스택**에 맞춤(부모는 변경 없음).
- **방향**: Aidit-Code 의 `font-mono` 스택에서 선두 `'JetBrains Mono', 'D2Coding'` 와 한글 폴백 `'Noto Sans KR'` 제거 → 부모와 글자단위 동일한 `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`. 두 곳 동기화: `tailwind.config.js`(`fontFamily.mono`) + `index.css`(body `font-family` 하드코딩 문자열). 한글은 부모와 동일하게 OS 기본 고정폭(Windows=Malgun Gothic 등)으로 폴백.
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린(EXIT 0). 브라우저 computed `font-family` 비교 — Aidit-Code(5173) body·h1 = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`(JetBrains/Noto 없음), 부모 Aidit(5174) body = **동일 문자열**. 두 앱 폰트 통일 확인.
- 변경 파일: `frontend/tailwind.config.js`, `frontend/src/index.css`, `docs/WIREFRAME.md`(§12.2), `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 홈·설정 화면을 부모 Aidit와 동일화 + 나 페이지 [설정] 라벨
- **요청(사용자)**: ① 홈 — 인기/최신 탭·활성 탭·쉘 프롬프트·로딩/빈 상태를 Aidit과 동일. ② 설정 — 헤더·쉘 프롬프트·섹션 스타일·로그아웃 버튼을 Aidit과 동일. ③ 나 페이지 — 설정 진입을 Aidit 동일 폰트/크기/스타일의 `[ 설정 ]` 로.
- **방향**:
  - 홈: 인기/최신 탭을 `<PageHeaderBar>` 안에 바를 꽉 채우게(h-full flex-1) + 활성 탭 amber 밑줄·배경틴트(`bg-[rgba(255,207,74,0.06)]`). 인라인 프롬프트 → `<ShellPrompt command="feed --sort=…">`. 로딩 = `LoadingState`(skeleton) 신규 이식, 빈 상태 = 부모식 `EmptyState`(title + CTA `+ 첫 글 쓰기`).
  - `EmptyState` 를 부모 API(title/hint/icon/action/className)로 교체 → 기존 `message` 호출부(Profile) 갱신. `LoadingState`(spinner|skeleton) 신규.
  - 설정: 헤더 `<PageHeaderBar>`(제목 + `[ ← 프로필 ]` 라벨 백링크), `<ShellPrompt command="cat ~/.config">`, 섹션을 `border-t` → **카드형**(`rounded-[2px] border bg-term-panel p-4`, 코너 태그), 로그아웃을 카드 안 full-width term-red 버튼으로. (API 키 BYOK 섹션은 서버키 정책상 계속 제외; Runtime 읽기전용 행 유지.)
  - 나 페이지: `profile.settingsLabel` `설정` → `[ 설정 ]`(부모 브래킷 스타일), 기존 bordered 버튼 스타일 유지.
  - 토큰 매핑: term-title→term-glow, term-border→term-line, term-card→term-panel, term-bright→term-fg-bright, term-danger→term-red, `.glow`→인라인 text-shadow.
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린. 브라우저(5173): 홈 = 인기/최신 탭이 PageHeaderBar 를 꽉 채움(활성 amber 밑줄+틴트) + `aidit@…:~$ feed --sort=popular`. 설정 = PageHeaderBar(`설정` + `[ ← 프로필 ]`) + `cat ~/.config` + 카드형 섹션(런타임 코너태그·언어·로그아웃 full-width term-red). 나 페이지 설정 진입 = 테두리 버튼 `[ 설정 ]`. (LoadingState skeleton·EmptyState CTA 는 부모 직역 이식분, tsc 검증.)
- 변경 파일(예정): `frontend/src/components/states/LoadingState.tsx`(신규)·`EmptyState.tsx`, `frontend/src/pages/Home.tsx`·`Settings.tsx`·`Profile.tsx`, `frontend/src/i18n/dicts/post.ts`·`profile.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 작성·나 페이지 헤더/쉘프롬프트를 부모 Aidit와 구조 동일화 (PageHeaderBar·ShellPrompt 이식)
- **요청(사용자)**: 작성 페이지·나 페이지의 **헤더와 쉘 프롬프트**를 부모 Aidit와 완전 동일 구조로(내용만 다르게).
- **방향**: 부모의 `PageHeaderBar`(앱바 h-12 바로 아래 sticky, `-mt-4 -mx-4` 풀블리드)·`ShellPrompt`(`aidit@user:~$ command` + term-cursor, aria-hidden)·`formatPromptArg`(프롬프트 인자 정규화/이스케이프/32자 트렁케이트)를 그대로 이식. 토큰만 Aidit-Code 매핑(term-title→term-glow, term-border→term-line, term-screen 솔리드→term-nav, glow 클래스→인라인 text-shadow). 커뮤니티 관련 `desktop:` 변형은 제외(Aidit-Code 단일 컬럼).
- **작성 페이지**: 평범한 `<h1>`+인라인 프롬프트 → `<PageHeaderBar><h1 …글 작성/글 수정></PageHeaderBar>` + `<ShellPrompt command={post --new|--edit "title"}>`. 본문/AI토글/이미지 등 나머지는 이번 범위 밖.
- **나 페이지**: `whoami` 인라인 헤더 → `<PageHeaderBar>` 안에 **Avatar(이식분) + username h1 + [설정] 라벨 링크** + 탭별 `<ShellPrompt command={ls ~/posts|~/bookmarks}>`. 탭/목록은 그대로.
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린. 브라우저(5173): 작성 페이지 = PageHeaderBar(`글 작성`, 하단 보더·풀블리드) + ShellPrompt(`aidit@wdyoon#e1eb:~$ post --new`). 나 페이지 = PageHeaderBar(Avatar + `wdyoon#e1eb` + 테두리 `[설정]` 링크) + ShellPrompt, 탭 전환 시 명령 `ls ~/posts`↔`ls ~/bookmarks` 갱신 확인. 설정 라벨 `설정`·Avatar 글리프 렌더 확인.
- 변경 파일(예정): `frontend/src/components/PageHeaderBar.tsx`(신규)·`ShellPrompt.tsx`(신규), `frontend/src/lib/shellArg.ts`(신규), `frontend/src/pages/CreatePost.tsx`·`Profile.tsx`, `frontend/src/i18n/dicts/profile.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 게시글 본문 마크다운 렌더링 추가 (부모 Aidit SafeMarkdown 이식)
- **요청(사용자)**: 직전 재디자인에서 평문으로 둔 게시글 본문을 마크다운으로 렌더링.
- **방향**: 부모 Aidit 의 살균 파이프라인(marked + DOMPurify)을 그대로 이식 — `markdown ─(normalizeLooseBold)→ marked(gfm,breaks) → DOMPurify(엄격 allowlist)` → `dangerouslySetInnerHTML`. 실패 시 escape 평문 폴백. 부모와 동일하게 게시글 본문엔 prose 클래스 미적용(text-sm/term-dim/leading-relaxed 상속) — 채팅 버블 마크다운은 이번 범위 밖(별도 요청 시).
- **구현**: deps `marked@^18`·`dompurify@^3` 추가 → `frontend/src/lib/sanitize.ts`·`SafeMarkdown.tsx` 이식 → `Thread.tsx` 본문 `<p>{post.body}</p>` 을 `<div class="…"><SafeMarkdown text={post.body}/></div>` 로 교체.
- **보안**: DOMPurify 엄격 allowlist(script/style/iframe/on*·style 속성 차단, URL 은 http(s)/mailto 만). 키/비밀과 무관.
- **검증(③) — 실측**: `npm install`(marked·dompurify) exit 0, frontend `tsc --noEmit` 클린. 브라우저(5173)에서 마크다운+XSS 페이로드 본문을 PATCH 후 렌더 검사 — `<strong>/<em>/<code>/<pre>/<ul><li>/<h1>` 정상 생성, 안전 링크 `https://` 유지, XSS 전부 무력화(window.__xss 미설정, `<script>` 없음, on* 핸들러 없음, `javascript:` 스킴 없음, 악성 `<img>` 의 onerror·비http src 제거). 검사 후 테스트 글 본문 원복.
- **참고(패리티)**: 부모와 동일하게 게시글 본문엔 prose 클래스 미적용 → 인라인 서식(굵게/기울임/인라인코드/링크)은 적용되고 블록 요소(제목/목록/코드블록)는 preflight 리셋으로 플랫하게 렌더(부모 post body 와 동일 동작). 채팅 버블 마크다운은 범위 밖.
- 변경 파일: `frontend/package.json`·`package-lock.json`, `frontend/src/lib/sanitize.ts`(신규)·`SafeMarkdown.tsx`(신규), `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · Thread 게시글 섹션을 형제 앱 Aidit와 동일하게 재디자인 (작성자/Upvote/댓글수/편집·삭제 팝오버)
- **요청(사용자)**: Thread 페이지의 게시글 자체 섹션(제목·본문·작성자·작성시간·Upvote·댓글 수·팝오버 편집/삭제)을 부모 Aidit와 동일 디자인으로. 커뮤니티 제외. 통일성 중요. (recon 워크플로 + frontend-design 으로 사전 검증 완료.)
- **결정사항**: ① 편집은 부모처럼 `/create` 페이지 편집모드 재활용. ② 댓글 수 = HUMAN + AGENT_REPLY(AI 최종응답) 카운트, TOOL_CALL/TOOL_RESULT(쉘 출력)·SYSTEM 제외. ③ 작성자 username 조인은 게시글 상세 + 피드 PostCard 둘 다. ④ 메뉴 hover 는 부모의 `term-hover` 토큰을 1회 예외로 추가해 부모 그대로. "(수정됨)" 표시는 부모에 없어 생략(updatedAt 미도입).
- **백엔드**:
  - `GET /posts/:id`·피드 `GET /posts`·북마크 카드에 `author { id, username }` 조인 추가(현재 authorId 만 반환 → 작성자 이름 미표시 버그 동반 수정).
  - `commentCount` 증가 규칙 변경: 기존 HUMAN 생성 시 +1 에 더해, **AGENT_REPLY 가 COMPLETE 로 확정될 때 +1**(`agent/turn.ts`), hotScore 재계산. 실패/PENDING 제외.
  - 기존 게시글 `commentCount` 백필(= HUMAN + AGENT_REPLY COMPLETE 재계산).
  - (이미 존재: Upvote POST/DELETE, voted, PATCH 편집, DELETE 삭제 — 변경 없음.)
- **프론트엔드**:
  - `Avatar` 컴포넌트 이식(부모, username 시드 결정적 실루엣).
  - `Thread.tsx` 게시글 article 재구성: 컨테이너/코너태그/제목(text-base bold term-glow+glow)/본문(SafeMarkdown 동등)/메타행(Avatar + u/이름 · relativeTime(createdAt)) + Upvote(▲score, 낙관적) + 댓글수(💬count) + 작성자 전용 `⋯` 팝오버(편집/2단계 삭제 확인).
  - `Create` 페이지 편집모드 추가(editPostId state → prefill → patchPost).
  - `PostCard` 작성자 표시 연결.
  - i18n 편집/메뉴 키 추가, tailwind 에 `term-hover`(#072115, 1회 예외)·`shadow-glow-soft` 추가.
- **본문 렌더 결정**: 부모는 SafeMarkdown(마크다운)이지만 Aidit-Code 엔 마크다운 렌더러가 없고 채팅 버블도 평문이라, 일관성·의존성 최소화를 위해 본문은 평문 `whitespace-pre-wrap` 유지(타이포만 부모와 동일하게 정렬). PostCard 는 이미 `post.author?.username` 을 렌더해 백엔드 조인만으로 작성자가 표시됨(FE 변경 불필요).
- **검증(③) — 실측**: backend `npm test` PASS(exit 0) + backend `tsc --noEmit` 클린 + frontend `tsc --noEmit` 클린. 브라우저(5173) 실측: 게시글에 `★ 원본 게시글`·제목(glow)·본문·Avatar+`u/wdyoon#f693 · 17시간 전`·`▲1`·`💬4` 렌더. 작성자 글에서 `⋯` 팝오버 열림 → [편집/삭제], 삭제 클릭 시 2단계 확인(`이 글과 샌드박스를 삭제할까요?`+확인/취소)→취소 복귀(미삭제 확인). 편집 클릭 → `/create` 편집모드(h1 `글 수정`, 제목/본문 prefill, 버튼 `저장`). 피드 API 응답에 `author{id,username}` 동봉 확인. 백필 22/174 게시글 재계산 완료.
- 변경 파일: `backend/src/routes/posts.ts`·`bookmarks.ts`·`users.ts`, `backend/src/agent/turn.ts`, `backend/scripts/backfill-comment-count.ts`(신규)·`backend/package.json`, `frontend/src/pages/Thread.tsx`·`CreatePost.tsx`, `frontend/src/components/Avatar.tsx`(신규), `frontend/src/api/rest.ts`(patchPost 언랩), `frontend/src/i18n/dicts/thread.ts`·`post.ts`, `frontend/tailwind.config.js`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 스레드 자동 스크롤이 최하단보다 살짝 위에서 멈추는 문제 — scrollIntoView+7rem → window.scrollTo(scrollHeight)
- **요청(사용자)**: 게시글에서 새 메시지를 보내 AI 응답이 올 때 자동 스크롤이 "최하단보다 살짝 위"에서 멈춤.
- **원인(브라우저 실측, 5173)**: 자동 추종은 `bottomRef.scrollIntoView({block:'end'})` + `scrollMarginBottom:'7rem'` 사용. 그런데 컴포저가 `sticky bottom-[var(--tabbar-h)]` 로 뷰포트 하단 ~150px 를 **덮고 있음**. `scrollIntoView` 는 (스티키 오버레이를 모른 채) 앵커를 **뷰포트 하단**에 맞추려 해서 항상 일찍 멈춤 → 실측: 자동 추종 `scrollY=1995`(최대 2040 대비 **45px 부족**), 마지막 메시지 끝이 컴포저 top 보다 36px 아래(=컴포저 뒤에 가림). 반면 점프 칩(↓)은 `window.scrollTo({top:scrollHeight})` 라 `scrollY=2040` 까지 가고 마지막 메시지가 컴포저보다 8px 위에 **온전히 노출**. (margin=0 으로 바꾸면 오히려 1883 까지만 — 더 나빠짐.)
- **부모 Aidit 와의 차이**: 부모는 컴포저 **바깥**의 내부 스크롤 컨테이너(`el.scrollHeight`)를 써서 `scrollIntoView` 가 정상 동작. Aidit-Code 는 **window 스크롤 + 스티키 컴포저 오버레이** 모델이라 같은 코드가 안 맞음.
- **방향**: 자동 추종을 점프 칩과 동일하게 `window.scrollTo({top: document.documentElement.scrollHeight})` 로 변경(토큰=instant, 새 버블=smooth 유지 + `prefers-reduced-motion` 존중). 의미를 잃은 `bottomRef`/`scrollMarginBottom:'7rem'` 제거. 스트리밍 추종과 ↓ 칩이 동일 위치로 일관.
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린(EXIT 0, 잔여 `bottomRef` 참조 없음). 브라우저(5173) 재실측 — 자동 추종이 `scrollY=2032`(=maxScroll, 최하단 도달), 마지막 메시지 bottom 636 이 컴포저 top 644 보다 **8px 위**로 온전히 노출(이전엔 45px 부족·36px 가려짐). scrollMarginBottom 앵커 완전 제거 확인.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 글로벌바 `[ KO | EN ]`·`[ username ]` 의 괄호 내부 공백을 형제 앱 Aidit와 동일하게
- **요청(사용자)**: 글로벌바의 `[ KO | EN ]` 언어 토글과 `[ username ]` 계정 링크의 "글자 내 공백"이 형제 앱 Aidit와 아직도 미묘하게 안 맞음.
- **원인(브라우저 실측)**:
  - **언어 토글**: 부모 Aidit 는 컨테이너 `gap-1`(4px) + 버튼/파이프 무패딩 → `[ KO | EN ]` 균일 4px 간격, 총 폭 **69.9px**. Aidit-Code 는 컨테이너 gap 없음 + 버튼 `px-1.5`(6px)·파이프 `px-1`(4px) → 간격이 더 넓고 불균일, 총 폭 **85.9px**(부모보다 16px 넓음).
  - **계정 링크**: 괄호 내부 공백 자체는 양쪽 모두 `[`(7.7px)+공백(7.7px)=15.4px 로 **이미 동일**. 다만 Aidit-Code 링크에 부모엔 없는 `px-1`(좌우 4px) 패딩이 있어 토글과의 간격이 부모(gap-2=8px)보다 4px 넓음. (`&nbsp;` 는 flex 아이템에서 일반 공백이 collapse 되는 것을 막는 장치라 유지.)
- **방향**: 부모의 간격 모델로 통일 — ① 토글 헤더 변형: 컨테이너 `gap-1` 추가, 옵션 span `gap-1` 추가, 헤더 버튼 `px-1.5` 제거(세로 터치 타깃 `min-h-[44px]`은 유지), 헤더 파이프 `px-1` 제거(세팅 변형은 그대로). ② 계정 링크·로그인 버튼 `px-1` 제거. 모노스페이스 셀이 두 폰트 모두 7.7px라 결과 폭은 부모와 정확히 일치(69.9px) 예상.
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린(EXIT 0). 브라우저(5173) 측정 — 토글 총 폭 **69.9px**(부모 69.9px 동일), 괄호 내부 간격 **균일 4px**(부모 동일), 계정 링크 `padding-left` **0px**(부모 동일), 토글→계정 간격 **8px**(부모 gap-2 동일).
- 변경 파일: `frontend/src/components/LangToggle.tsx`, `frontend/src/layout/AppShell.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 글로벌바(최상단 헤더)를 형제 앱 Aidit와 동일한 크기·폰트로 통일
- **요청(사용자)**: Aidit-Code 최상단 글로벌바의 크기/포함 텍스트의 폰트체·폰트크기·폰트내용이 형제 앱 Aidit의 글로벌바와 미묘하게 달라, Aidit의 디자인·폰트와 동일하게 맞춰달라.
- **비교(실측)** — Aidit(부모) vs Aidit-Code(현재):
  - 바 높이: `h-12`(48px) vs **`h-14`(56px)** — Aidit-Code 가 8px 더 높음.
  - 워드마크 폰트 크기(sm): `text-lg` vs **`text-base`** — Aidit-Code 가 더 작음.
  - 워드마크 자간(sm): `tracking-[3px]` vs **`tracking-[1px]`** — Aidit-Code 가 더 좁음.
  - 폰트체: 양쪽 모두 `font-mono`(동일) — 차이 없음.
  - 색상 토큰: 이름만 다르고(`term-fg-bright`=`term-bright`=`#aaffc0`, `term-nav`=`term-screen`=`#04130b`, `term-line`=`term-border`=`#1d4a30`) **값은 동일** → 변경 불필요.
  - 워드마크 텍스트: `AIDIT` vs `AIDIT-CODE` — **별개 제품명이므로 'AIDIT-CODE' 유지(사용자 확정)**, 폰트 스타일만 동일하게.
- **방향**: 시각적으로 다른 두 항목만 정정 — ① 헤더 높이 `h-14`→`h-12`, ② Logo `sm` 워드마크 `text-base tracking-[1px]`→`text-lg tracking-[3px]`. `truncate`/`shrink-0`/`min-w-0`(좁은 화면 오버플로 방지)는 Aidit-Code 고유 안전장치로 유지(일반 렌더 외형 불변). bg 불투명도(`/95`)·z-index 등은 시각차 없고 자체 TabBar 와의 일관성 때문에 미변경.
- **구현**: `AppShell.tsx` Header `h-14`→`h-12`; `Logo.tsx` sm 워드마크 className 폰트 크기/자간 변경.
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린(EXIT 0). 브라우저 computed 비교 — Aidit-Code(5173): 헤더 행 높이 48px·워드마크 fontSize 18px·letter-spacing 3px(JetBrains Mono). 부모 Aidit(5174): 48px·18px·3px 동일. 텍스트만 `AIDIT-CODE` vs `AIDIT`(의도된 제품명 차이).
- 변경 파일: `frontend/src/layout/AppShell.tsx`, `frontend/src/components/Logo.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 프로필 탭 라벨 한국어 미번역 수정 — posts/bookmarks → 게시글/북마크 (i18n ko≠en)
- **요청(사용자)**: 한↔영 전환 시에도 언어가 바뀌지 않는 텍스트가 몇 개 있음. 점검 결과 JSX는 모두 `t()` 사용(하드코딩 없음), 영어 키 누락도 없음. 실제 원인은 사전(dict)에서 `ko`·`en` 값이 동일한 항목들.
- **분석**: `profile.tabPosts`='posts', `profile.tabBookmarks`='bookmarks' 가 ko·en 모두 영어 → 한국어 모드에서도 영어로 표시(다른 탭 `홈`/`Home` 은 정상 번역). 사용자 선택으로 이 두 항목만 한국어화. (상태 배지 CREATING 등·placeholder 등 나머지 동일값 항목은 터미널 미학/브랜드로 보고 미수정.)
- **방향**: `profile.ts` ko 값만 `게시글`/`북마크` 로 변경(en 은 그대로). 렌더링 로직(`Profile.tsx` `t('profile.tabPosts')`)은 변경 없음.
- **검증(③)**: frontend `tsc --noEmit` 클린(EXIT 0). ko='게시글'/'북마크', en='posts'/'bookmarks' 로 분리되어 언어 토글 시 라벨 변경됨.
- 변경 파일: `frontend/src/i18n/dicts/profile.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 홈 인기/최신 토글 행 높이를 작성 페이지 제목과 동일(24px)로 — min-h-[44px] 제거
- **요청(사용자)**: 직전 글자 크기(text-base) 통일만으로는 부족 — 홈 인기/최신 행이 다른 상단바보다 여전히 **높이가 높다**. 작성 페이지 상단과 높이까지 동일하게.
- **원인(실측)**: 토글 버튼 `min-h-[44px]` 때문에 행 높이=**44px**. 작성 페이지 제목 `h1`은 min-height 없이 line-height만이라 **24px**. → 20px 차이(= 홈 헤더→프롬프트 68px vs 작성 48px 차이와 동일).
- **방향**: 토글 버튼에서 `min-h-[44px]` 제거 → 행 높이 24px 로 작성 페이지 `h1` 과 일치. **트레이드오프**: 모바일 터치 타깃이 44px→24px 로 작아짐(WIREFRAME 모바일 가이드와 상충). 시각적 높이 일치가 명시적 요청이라 우선 적용.
- **구현**: `Home.tsx` 토글 버튼 className 에서 `min-h-[44px]` 제거(`px-1` 유지).
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린. 브라우저(localhost:5173) 토글 행 높이 44→**26px**, 헤더→프롬프트 68→**50px**(작성 페이지 24px/48px과 거의 동일). 남은 2px 는 활성 토글의 앰버 밑줄(`border-b-2`)로, 제목엔 없는 토글 고유 디자인(유지 요청).
- 변경 파일: `frontend/src/pages/Home.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · ShellPrompt 바로 위 요소와의 여백을 전 페이지 8px(mb-2)로 통일
- **요청(사용자)**: `aidit@…:~$ ~~~~` 형태 ShellPrompt 와 그 위 상단 bar 사이 간격이 페이지마다 달라 통일.
- **측정(실측, localhost:5173)** — 헤더→프롬프트 총거리 / 프롬프트 바로 위 요소와의 여백:
  - 나(Profile): 16px / 위 요소 없음(프롬프트가 최상단, py-4만)
  - 작성(Create): 48px / 8px(`h1.mb-2`)
  - 홈(Home): 68px / 8px(토글 `div.mb-2`)
  - 설정(Settings): 72px / **12px**(`div.mb-3`) ← 유일한 불일치
  - (검색 페이지는 설계상 없음 — WIREFRAME §1.)
- **방향(사용자 확정)**: 프롬프트 **바로 위 요소와의 여백**만 8px(`mb-2`)로 통일. 페이지별 총 거리(요소 높이 차)는 유지. 각 페이지 헤더 구조/위치는 그대로.
- **구현**: `Settings.tsx` 상단 뒤로가기 바 `mb-3` → `mb-2`. (홈·작성은 이미 mb-2, 나는 위 요소 없음 → 변경 불필요.)
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린. 브라우저(localhost:5173/me/settings)에서 프롬프트 바로 위 바의 marginBottom=8px·gap=8px 확인 → 홈·작성과 동일.
- 변경 파일: `frontend/src/pages/Settings.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 홈 인기/최신 토글을 작성 페이지 상단과 동일 크기로 — text-sm → text-base
- **요청(사용자)**: 홈의 인기/최신 첫 줄 레이아웃을 작성 페이지(검색 페이지는 설계상 없음) 상단과 크기·디자인을 동일하게. 차이는 버튼이 2개라는 점만.
- **분석**: 작성 페이지 상단 = 제목 `h1`(`text-base text-term-fg-bright`, `mb-2`) → ShellPrompt 줄(`text-xs text-term-dim`, `mb-3`). 홈 상단 = 인기/최신 토글(`text-sm`, `mb-2`) → 동일 ShellPrompt 줄. ShellPrompt·여백(mb-2/mb-3)은 이미 동일하고 차이는 첫 줄 글자 크기뿐(`text-sm` vs `text-base`).
- **방향(사용자 확정)**: 토글 버튼을 제목 크기(`text-base`)로 키움. ShellPrompt 줄·여백은 공유, 토글의 앰버 밑줄/활성(active) 디자인은 유지.
- **구현**: `Home.tsx` 토글 컨테이너 className `text-sm` → `text-base`.
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린. 브라우저(localhost:5173)에서 홈 토글 버튼 computed fontSize=16px(JetBrains Mono), 작성 페이지 `h1` computed fontSize=16px·marginBottom=8px 동일 확인.
- 변경 파일: `frontend/src/pages/Home.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · [Stop Session] 칩 색을 Delete 버튼과 통일 + Delete → [Delete]
- **요청(사용자)**: `[Stop Session]` 테두리/글씨 색을 Delete 버튼과 동일하게, 그리고 Delete 라벨을 `[Delete]` 로.
- **수정**: 세션 토글 칩 className 을 상태별로 — `sessionActive`(Stop)면 Delete 와 동일 토큰(`border-term-red-line text-term-red hover:bg-term-red-bg`), `!sessionActive`(Start)면 기존 amber 유지. Delete 트리거 버튼 라벨을 `[{deletePost}]` 로 대괄호 표기(Start/Stop 칩과 통일).
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린 + `vite build` PASS. 브라우저에서 `[세션 중지]` 칩 computed color=term-red(rgb 255,122,122)·border=term-red-line(rgb 90,37,48) 확인 — Delete 와 동일 토큰. `[Start Session]` 은 amber 유지.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 진입 시 세션 자동 시작(연결) + 시작/중지 토글 버튼([Start Session]/[Stop Session])
- **요청(사용자)**: ① 게시글 진입 시 자동으로 세션이 연결(시작)되게. ② 연결되면 'Start session' 버튼이 사라지지 말고 `[Start Session]`→`[Stop Session]` 으로 토글.
- **원인(자동 연결 안 됨)**: 기존 진입 effect 가 `!sessionActive` 면 return → **기존 활성 세션 attach 만** 하고, 세션이 없으면 시작하지 않음(lazy). 그래서 활성 세션이 없는 글은 진입해도 연결 안 됨.
- **구현**:
  1. 진입 effect 를 **자동 시작**으로 변경: 인증(token) + 로딩 완료 + 미연결일 때, 샌드박스가 `READY`/`SUSPENDED`/`RUNNING`(stale→백엔드 startOrAttach 정규화)이면 `handleStartSession()` 호출. `CREATING` 이면 가드 미소진으로 대기 후 sandbox.status 갱신 시 재시도, `ERROR` 면 시작 안 함. 이미 활성이면 호출 없이 가드만 소진. (게스트는 token 없어 자동 트리거 안 됨.)
  2. 상단 우측 칩을 **항상 표시(토글)**: `!sessionActive`→`[Start Session]`(onClick startSession), `sessionActive`→`[Stop Session]`(onClick suspend). 진행 중엔 `[…중…]`. 라벨은 대괄호로 표기(요청).
  3. `rest.ts` 에 `suspendSession(postId)` 추가 → `POST /posts/:id/session/suspend`(기존 라우트: 세션 STOPPED + 샌드박스 SUSPENDED, `{session}` 반환). `handleStopSession` + `stoppingSession` 상태 추가.
  4. i18n: `startSession` en 'Start session'→'Start Session'(대문자), 신규 `stopSession`(세션 중지/Stop Session)·`stoppingSession`(세션 중지 중…/Stopping session…).
- 중지하면 sessionActive=false → 칩이 `[Start Session]` + 컴포저 위 빨간 경고 재노출(일관). 사용자가 직접 중지한 것이므로 자동 재시작 안 함(autoAttachedRef 이미 소진).
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린 + `vite build` PASS. 브라우저(localhost:5173, 로그인 상태)에서 게시글 진입 시 칩이 `[세션 중지]`(=자동 연결됨)로 표시 확인. 칩 클릭 → `[세션 시작]` 전환 + 컴포저 위 빨간 경고 노출 → 다시 클릭 → `[세션 중지]` 재연결까지 라운드트립 확인.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `frontend/src/api/rest.ts`, `frontend/src/i18n/dicts/thread.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 진입 시 바닥 스크롤 잔존 경로 제거 — firstRun 에서 pinnedRef 리셋 (실측 검증)
- **증상(사용자, 실기기)**: 직전 수정 후에도 진입 시 여전히 최하단으로 스크롤됨.
- **놓친 원인**: hydrate 전(짧은 콘텐츠) 스크롤 리스너가 `pinnedRef` 를 false-positive 로 `true` 로 만들어 둔 뒤, 진입 직후 자동 attach 된 활성 세션의 **SSE 스트리밍 토큰**이 메시지를 갱신하면 firstRun 은 이미 지났고 `pinnedRef===true` 라 `bottomRef.scrollIntoView` 로 바닥행. 직전 firstRun 분기가 `scrollTo(0,0)` 만 하고 `pinnedRef` 를 리셋하지 않음.
- **수정**: firstRun(진입) 분기에서 `pinnedRef.current = false` 를 명시적으로 추가 → 이후 스트리밍 갱신이 바닥으로 끌지 않음(사용자가 직접 바닥 근처로 스크롤해야 pinned 재활성). selfSent 팔로우는 그대로.
- **검증(③) — 실측**: frontend `tsc --noEmit` 클린 + `vite build` PASS. 브라우저(localhost:5173)에서 스크롤 가능한 스레드 진입(scrollHeight 2807 / viewport 992, 스크롤 여지 1815px) 후 `window.scrollY === 0`(최상단), 3초 후(SSE 정착)에도 `scrollY === 0` 유지 확인.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 게시글 진입 시 바닥 스크롤 제거 — 항상 최상단부터 표시
- **요청(사용자)**: 게시글 첫 진입 시 맨 아래로 내려가는 동작 삭제. 진입은 항상 최상단(원문)부터 보여주는 게 맞는 UX.
- **원인(취약점)**: 기존 top-on-entry 가드(`firstRun` + `pinnedRef=false`)가 있으나 ① 메시지 0건 초기 렌더가 `hasAutoScrolledRef` 가드를 먼저 소진 → 실제 hydrate 시 firstRun=false, ② 짧은/로딩 중 콘텐츠에서 스크롤 리스너가 `innerHeight+scrollY >= scrollHeight-120` 를 만족시켜 `pinnedRef` 가 false-positive 로 true → 첫 hydrate 에서 바닥으로 스크롤될 수 있음.
- **수정**: 자동스크롤 effect 를 견고화 — (1) `messages.length === 0` 이면 즉시 return(가드 미소진, 빈 렌더가 firstRun 을 잡아먹지 않음). (2) 첫 실제 실행(firstRun && !selfSent)에서 단순 return 대신 `window.scrollTo(0,0)` 로 **명시적으로 최상단 고정**(브라우저 스크롤 복원/false-positive pinned 무력화). 자기 전송(selfSent) 팔로우와 사용자가 바닥 근처일 때의 스트리밍 팔로우는 그대로 보존.
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS. 진입 firstRun 에서 `window.scrollTo(0,0)` 강제 + 빈 렌더 가드 미소진으로 항상 최상단; selfSent/pinned 팔로우 보존.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 세션 끊김인데 좌상단 배지가 `Running` 으로 남는 모순 — 세션 인식형 표시
- **증상(사용자)**: "세션 끊김" 빨간 경고가 떠 있는데 게시글 상단 좌측 배지는 여전히 `● Running`.
- **원인**: 좌상단 `StatusBadge` 는 **샌드박스 상태**(`sandboxStatus`)를, 끊김 경고는 **세션 상태**(`sessionActive`)를 본다 — 서로 다른 대상. 세션이 끊겨도 샌드박스는 DB 에 `RUNNING` 으로 남을 수 있어(stale; 백엔드도 "활성 세션 없는 RUNNING 은 비정상") 둘이 어긋남.
- **수정**: Thread.tsx 에서 배지에 넘기는 상태를 세션 인식형으로 도출 — `!sessionActive && raw === 'RUNNING'` 이면 `RUNNING` 대신 `SUSPENDED`(○ 비활성)로 표시해 경고와 일치. `sessionActive` 면 실제 샌드박스 상태 그대로. CREATING/READY/ERROR 등은 불변. `StatusBadge` 는 순수 표시 컴포넌트 유지(도출은 호출부).
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS. 끊김(`!sessionActive`)+stale RUNNING → 배지 ○ SUSPENDED 로 표시되어 경고와 일치; 연결 시 ● RUNNING 유지.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [chore] · 완료 · 미사용 i18n 키 `thread.sessionRunning` 제거
- 직전 작업에서 '● 세션 실행 중' 배지를 삭제해 유일 소비처가 사라진 dead 키(ko/en)를 제거. 다른 참조 없음(grep 확인), 동작 무변. frontend `tsc --noEmit` 클린 + `vite build` PASS.
- 변경 파일: `frontend/src/i18n/dicts/thread.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 진입 시 자동 연결(attach) 후 Thread 세션 UI 정리 — 중복 배지 제거·시작 컨트롤 우상단 이동·컴포저 위 빨간 경고
- **요청(사용자)**: 게시글 진입이 세션을 자동 연결/attach 하게 된 지금, Thread 세션 UI 를 정리한다.
- **배경/불변식**: `sessionActive = !!activeSession && status !== 'STOPPED' && status !== 'ERROR'`(~244). `!sessionActive` 는 **세션 끊김**뿐 아니라 **세션이 아직 시작되지 않은 새 글**(lazy auto-attach 는 *기존* 세션만 attach; 첫 메시지로 spawn)도 포함한다 → 두 상태 모두 동일한 "시작 칩 + 경고" 가 노출되는 것이 **올바른 어포던스**(시작/재연결 유도). 의도된 동작으로 허용한다.
- **구현 단계(순서대로)**:
  1. **상단 우측 '● 세션 실행 중' span 삭제** — Thread.tsx ~292-296 의 `{sessionActive && <span className="ml-auto … text-term-amber">● {t('thread.sessionRunning')}</span>}` 블록 제거. 상단 좌측 `<StatusBadge>`(● RUNNING)가 실행 상태를 이미 전달하므로 중복.
  2. **챗 본문 중앙 '세션 시작' 버튼 블록 삭제** — Thread.tsx ~411-421 의 `{!sessionActive && <div className="mb-3 flex justify-center"><button …>{startingSession ? t('thread.startingSession') : t('thread.startSession')}</button></div>}` 전체 제거.
  3. **'세션 시작' 컨트롤을 상단 STATUS ROW 우측으로 이동** — 1)에서 삭제한 '● 세션 실행 중' 배지가 차지하던 **바로 그 슬롯**(상단 행 내부, `ml-auto` 우측 정렬)에 배치한다. **`!sessionActive` 일 때만** 렌더(연결됨 → 아무것도 없음 / 끊김·미시작 → 우상단 소형 칩).
     - **크기/모양(컴팩트 칩, 삭제된 amber 배지와 동일 계열)**: `<button type="button">`, `className="ml-auto inline-flex min-h-[28px] items-center rounded-[2px] border border-term-amber-line px-2 font-mono text-[11px] tracking-wider text-term-amber disabled:opacity-50"`. (큰 중앙 버튼의 `min-h-[44px] px-4 text-sm` 가 아니라 배지 계열 `text-[10px]/[11px]`·`px-2`·min-height ~28-32px 로 맞춘다.)
     - **동작/라벨 재사용**: `onClick={handleStartSession}`, `disabled={startingSession}`, 라벨 `{startingSession ? t('thread.startingSession') : t('thread.startSession')}`. 새 핸들러/상태를 만들지 않고 기존 `handleStartSession`/`startingSession`/`thread.startSession`/`thread.startingSession` 그대로 사용.
     - **슬롯 주의**: 상단 행은 `back '‹' Link → <StatusBadge> → (reconnecting indicator) → [여기 ml-auto 우측 칩]` 순. `ml-auto` 로 우측 끝에 붙인다.
  4. **컴포저 바로 위 빨간 경고 배너 추가** — sticky 컴포저 래퍼(`<div className="sticky bottom-[var(--tabbar-h)] z-10 -mx-4">`) 안, `<Composer>` **직전 블록**으로 삽입(점프 칩 다음, Composer 위). 컴포저 상단 모서리에 붙는 풀블리드 배너.
     - **조건**: `!sessionActive && !statusErrorKey` 일 때만 표시(하드 ERROR 배너 ~303-310 와 **중복 방지**; sessionErr/sandboxErr 가 있을 땐 빨간 ERROR 공지가 이미 뜨므로 이 경고는 숨김).
     - **토큰/스타일(빨강 계열, Aidit 의 간결·행동지향 경고 스타일)**: `role="alert"`, full-bleed(래퍼가 이미 `-mx-4` 풀블리드이므로 내부 행 `px-3` 정렬 유지), `className` 예: `"border-t border-term-red-line bg-term-red-bg px-3 py-1.5 font-mono text-[11px] leading-relaxed text-term-red"`. small font. (Aidit 의 "A Gemini key is required … add your key in login." 같이 한 줄 행동지향 문구.)
     - **문구**: `{t('thread.sessionDisconnected')}` (신규 키).
  5. **i18n 신규 키 `thread.sessionDisconnected` 추가** — frontend/src/i18n/dicts/thread.ts 의 ko/en 양쪽에 추가.
     - KO: `세션이 끊겼어요. 우측 상단 '세션 시작'을 눌러 다시 연결하세요.`
     - EN: `Session disconnected — tap 'Start session' (top right) to reconnect.`
     - (문구가 4)/3) 의 우상단 이동된 컨트롤을 가리키므로 위치 정합성 유지.)
- **가시성 요약**: 연결됨(sessionActive) → 상단 우측 비움 + 컴포저 위 경고 없음. 끊김/미시작(!sessionActive) → 상단 우측 '세션 시작' 칩 + (하드 ERROR 가 아닐 때) 컴포저 위 빨간 경고. 하드 ERROR(statusErrorKey) → 기존 중앙 빨간 ERROR 공지 유지 + 컴포저 위 경고는 숨김(중복 방지).
- **불변 유지**: `statusErrorKey` 배너(~303-310) KEEP. `handleStartSession`/자동 attach `useEffect`(~262-267) 로직 불변. 그 외 기존 동작 보존.
- **검증(③, 결과)**: frontend `npx tsc --noEmit` 클린(오류 0), `npx vite build` PASS(90 modules transformed, built in 1.84s). 세 변경 모두 통과 → `완료` 전환.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `frontend/src/i18n/dicts/thread.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 게시글 최하단 공백 제거 — 컴포저를 TabBar 에 밀착
- **요청(사용자, 스크린샷)**: 게시글 페이지 최하단(컴포저와 하단 TabBar 사이)에 공백이 남아 있음 → 제거.
- **원인**: 컴포저는 Thread 루트의 마지막 요소인데, Thread 루트는 `<main class="… py-4">` 안에 있어 루트 아래로 main 의 `pb-4`(16px) 가 깔린다. 컴포저(sticky bottom-[var(--tabbar-h)])가 그 16px 만큼 TabBar 와 벌어져 보임. (직전 좌우 공백은 `px-4`/`-mx-4` 로 해결했고, 이번은 하단 `pb-4`.)
- **수정**: Thread 루트 div 에 `-mb-4` 추가 → 자식 음수 마진이 부모(main)의 `pb-4` 를 잠식해 루트 하단이 main 콘텐츠박스 하단(=TabBar 상단)과 flush. 컴포저가 TabBar 에 밀착(공백 제거). `<main>` 자체는 불변이라 피드/프로필 등 다른 페이지의 하단 여백은 보존.
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS. 자식 음수 마진(`-mb-4`)이 부모(main)의 `pb-4`(1rem)를 상쇄하는 결정적 CSS 라 빌드 검증으로 충분.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 컴포저 좌우 공백 제거 — Aidit 처럼 풀블리드 footer
- **요청(사용자, 스크린샷)**: 게시글 메시지 컴포저 좌/우에 공백이 있음 → Aidit 참고해 제거.
- **원인**: 컴포저 루트는 `border-t bg` 풀폭이지만 `AppShell` 의 `<main class="… px-4">`(전 페이지 16px 인셋) 안에 들어 있어 좌우 16px 공백 발생. Aidit 은 컴포저가 컬럼 풀블리드 footer 이고 내부만 `px-3`.
- **수정**: Thread 의 sticky 컴포저 래퍼에 `-mx-4` 추가 → main 의 `px-4` 를 상쇄해 컴포저(테두리/배경)가 화면 가장자리까지 풀블리드. 내부 행은 기존 `px-3` 유지(콘텐츠는 가장자리에 붙지 않음). 같은 래퍼에 anchored 된 점프 칩도 함께 풀블리드되어 `right-3` 가 화면에서 12px(Aidit 동일).
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS(90 모듈). `-mx-4` 가 `<main>`의 `px-4`(1rem)를 정확히 상쇄하는 결정적 CSS 라 빌드 검증으로 충분(모바일 풀블리드; 데스크톱은 컬럼 대비 ±16px 확장이나 mobile-first 의도상 허용).
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 게시글 점프 칩 — Aidit 과 모양/위치/기능 동일하게 적용
- **요청(사용자)**: Thread 화면의 점프 칩을 부모 Aidit 과 동일하게(모양·위치·기능).
- **Aidit 사양**: 단일 정사각형 버튼(`h-10 w-10 rounded-[2px]`, term-border + 반투명 card bg + backdrop-blur, hover 시 bright+glow), 스크롤 영역 우하단(`sticky bottom-3` h-0 래퍼 + `absolute right-3`), **스크롤 방향 추종**(위로 스크롤=↑ 맨위로, 아래로=↓ 맨아래로; deadzone 2px), 스크롤 중에만 페이드인 후 1초 유휴 시 페이드아웃, 클릭 시 smooth scrollTo(reduced-motion 존중), `isProgrammatic` 으로 자기 스크롤 재트리거 차단. aria/title `thread.jumpTopAria`/`jumpBottomAria`.
- **이식(대상 차이 적응)**: Aidit 은 내부 컨테이너 스크롤(`scrollRef`)이지만 Audit-Code 는 **window 스크롤** → 방향은 `window.scrollY` 델타, 점프는 `window.scrollTo({top:0 | documentElement.scrollHeight})`. 칩은 컴포저 sticky 래퍼 안에서 `absolute bottom-full right-3` 로 **컴포저 바로 위** 우측에 띄움(TabBar/컴포저 위, 매직넘버 없이). 토큰은 Audit-Code 명칭(term-panel/term-fg-bright)으로, 없는 `shadow-glow-soft` 대신 인라인 hover 글로우. 기존 window 스크롤 리스너(pinnedRef)에 방향 감지+유휴타이머 통합. 점프=bottom 시 pinnedRef 재핀, top 시 해제.
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS(90 모듈). 칩은 sticky 컴포저 래퍼(positioned containing block) 안 `absolute bottom-full right-3` 로 컴포저 바로 위 우측에 위치, 방향/유휴/점프 로직은 window 스크롤로 이식.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `frontend/src/i18n/dicts/thread.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 유저명 닫는 `]` 사라짐 + Thread 컴포저가 TabBar 에 가려 잘리는 문제
- **증상(사용자)**: ① 헤더 `[ username ]` 에서 닫는 `]` 가 사라짐. ② 게시글 진입 시 댓글 작성창(Composer) 하단 일부가 잘려 안 보임(메인 화면 세로 길이가 실기기보다 미묘하게 김).
- **원인**: ① 직전 수정에서 `[ name ]` 전체 문자열에 `truncate` 를 걸어 닫는 `]` 까지 잘림. ② Composer 래퍼가 `sticky bottom-0` 인데 하단 `TabBar` 도 `sticky bottom-0`(z-20) → 둘 다 뷰포트 맨 아래에 겹쳐 TabBar(~56px)가 Composer 하단(전송 버튼)을 가림.
- **수정**: ① `AppShell` 헤더 유저명을 `[`·`]` 고정 span + 가운데 username 만 `truncate`(min-w-0) 로 분리 → 대괄호 항상 표시. ② TabBar 높이를 결정적 CSS 변수 `--tabbar-h = calc(3.5rem + safe-area-inset-bottom)` 로 고정(AppShell 루트에 선언, nav 에 safe-area paddingBottom + 내부 행 h-14), Thread 의 Composer 래퍼를 `sticky bottom-[var(--tabbar-h)]` 로 올려 TabBar 바로 위에 고정 → 겹침 해소, iOS 노치 safe-area 도 반영.
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS(90 모듈). 브라우저(localhost:5173)에서 ① `[ wdyoon#e1eb ]` 닫는 대괄호 복구 **시각 확인**. ② 컴포저-TabBar 겹침은 구조적 수정(sticky offset = `--tabbar-h`)으로 해소 — 단 실재현은 모바일 해상도 전용이라 데스크톱 뷰포트 캡처로는 미확인(실기기 확인 권장).
- 변경 파일: `frontend/src/layout/AppShell.tsx`, `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · 헤더 깨짐 수정 — `[ KO | EN ]` 대괄호 + 모바일 줄바꿈/오버플로 방지
- **증상(사용자, 스크린샷)**: 모바일 헤더에서 ① 워드마크 `AIDIT-CODE` 가 두 줄로 줄바꿈, ② `[ username ]` 대괄호가 위/아래로 분리, ③ 언어 토글이 `[ KO | EN ]` 가 아니라 대괄호 없는 `KO | EN`. 우상단 요소들이 헤더 폭을 초과해 줄바꿈됨.
- **원인**: LangToggle 에 대괄호 없음. 워드마크/유저명에 `whitespace-nowrap` 미적용 → 공백·하이픈에서 줄바꿈. 워드마크(text-lg tracking-[3px]) + LLM 배지 + 토글 + 유저명이 모바일 폭 합산 초과인데 축소/truncate 가드 없음.
- **수정**: (1) `LangToggle` 을 `[ … ]` 대괄호로 감싸고 `whitespace-nowrap`, 버튼 패딩 축소. (2) `Logo` 헤더 워드마크 `whitespace-nowrap` + 크기/자간 축소(text-base tracking-[1px]) + `truncate` 가능하게. (3) `AppShell` 헤더: 좌측 Link `min-w-0`(워드마크가 최후수단으로 truncate), 우측 클러스터 `shrink-0 whitespace-nowrap`, 간격 축소, 유저명 `max-w` + `truncate`. (4) LLM 라벨은 좁은 화면에서 점만 남기고 텍스트는 `sm:` 이상에서 표시. → 어떤 폭에서도 줄바꿈/레이아웃 깨짐 없이 한 줄 유지.
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS(90 모듈). 브라우저(localhost:5173) 시각 확인 — 헤더가 한 줄로 유지되고 `[ KO | EN ]`·`[ username ]` 대괄호 표시 확정. (도구가 <640px CSS 뷰포트를 강제하지 못해 모바일 리플로우는 nowrap/shrink-0/truncate/반응형 LLM 라벨로 구조적 보장.)
- 변경 파일: `frontend/src/components/LangToggle.tsx`, `frontend/src/components/Logo.tsx`, `frontend/src/components/LlmStatusBadge.tsx`, `frontend/src/layout/AppShell.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · Composer 레이아웃을 Aidit 구조로 재구성(기능 전부 보존) — 프런트엔드
- **요청(사용자)**: `frontend/src/components/Composer.tsx` 의 **레이아웃/구조만** 부모 Aidit 와 동일하게 재구성. 기존 Audit-Code 기능은 전부 보존: 이미지 업로드+미리보기+이미지 단독 전송, `reasoning_effort`(low/medium/high · 낮음/중간/높음, 기본 medium), aiMode 토글, 스트리밍 중 interrupt/steer, 낙관적 삽입, i18n.
- **변경 내용(레이아웃)**:
  1. **루트**: `shrink-0 border-t border-term-border bg-term-bg font-mono`. 행 순서(위→아래): [error/toast] → [이미지 미리보기 행(h-16 w-16 썸네일 + × 제거)] → [스트리밍 중 interrupt/steer 행(기존 유지)] → [메인 행].
  2. **메인 행**(`flex items-end gap-2 px-3 py-2`): (a) **첨부 버튼**을 입력 박스 **바깥**(h-11 w-11, 보더, + 아이콘, 숨김 file input 트리거); (b) **입력 래퍼**(`flex items-end gap-2 flex-1 min-h-[44px] max-h-32 border rounded bg`, aiMode 시 `border-term-amber` else `border-term-border`/focus-within) 안에 `>` 프리픽스(text-term-faint) + **오토그로우 textarea**(rows=1, resize-none, bg-transparent, Enter=전송/Shift+Enter=개행) + **AI 칩 버튼**(h-9, 로봇 글리프 + AI + 셰브론, aiMode 시 amber); (c) **전송 버튼**을 바깥(h-11 w-11, border-term-active, `bg-term-cta` 그라데이션, 위 화살표 아이콘, 텍스트·이미지 모두 없으면 disabled).
  3. **AI 팝오버**(기존 인라인 reasoning_effort 행을 대체): 칩 위(`absolute bottom-full`)에 앵커되는 컴팩트 패널 = aiMode ON/OFF 토글 + 3단계 effort 라디오(낮음/중간/높음, 기본 medium). aiMode OFF 시 effort 비활성. 바깥 클릭/Escape 로 닫힘. 선택한 effort 는 기존과 동일하게 `sendMessage({ reasoningEffort })` 로 흐름. 이미지도 기존과 동일하게 먼저 업로드 후 imageUrl 동봉 전송.
- **토큰 주의**: Aidit 의 `shadow-glow-*`/`term-card`/`term-info` 토큰은 Audit-Code 에 없음 → 기존 토큰으로 매핑(card→`term-panel`, 그라데이션→기존 `bg-term-cta`, glow 그림자 생략). 신규 토큰 도입 없음.
- **i18n**: `thread.aiMenuAria`/`thread.sendAria` 키 추가(ko/en). 나머지는 기존 키 재사용(composerPlaceholder, send, attachImageAria, removeImageAria, attachPreviewAlt, aiToggleOn/Off, reasoningEffort*). 하드코딩 없음.
- **보안(TRD §8)**: 컴포저는 LLM 키를 다루지 않음(전송 페이로드 불변: { body, aiMode, clientId, lang, imageUrl?, reasoningEffort? }).
- **불변 보장**: Thread 의 StrictMode 안전성·진입 시 자동 첨부 동작에는 영향 없음(Composer props 시그니처 `{ postId }` 유지).
- **변경 파일**: `frontend/src/components/Composer.tsx`(재구성), `frontend/src/i18n/dicts/thread.ts`(키 2개 추가).
- **검증(통과)**: `cd frontend && npx tsc --noEmit` → 에러 0(TSC_OK). `npx vite build` → `✓ 90 modules transformed`, `✓ built in 2.02s` (exit 0). 전송 페이로드·낙관 삽입·interrupt/steer·이미지 업로드+미리보기+이미지 단독 전송·reasoning_effort·i18n 동작 불변. Thread props 시그니처 `{ postId }` 유지(자동 첨부/StrictMode 안전성 불변).

### 2026-06-26 · [feat] · 완료 · 앱 셸: 헤더(로고+상태+언어+계정) + 바텀 탭바(인라인 SVG) + LLM 연결 상태 배지 — 프런트엔드
- **요청(사용자)**: 부모 Aidit 의 앱 셸을 Audit-Code 에 이식.
  1. **헤더**(`frontend/src/layout/AppShell.tsx`): 좌측 = `<Logo size="sm"/>`(삼각형 마크 + `AIDIT-CODE` 워드마크), `/` 로 링크. 우측(Aidit 순서) = LLM 연결 상태 배지 → `LangToggle(KO|EN)` → 로그인 시 `[ username ]`(/me 링크, text-term-dim hover bright) / 비로그인 시 `[ login ]` 버튼(openLogin, text-term-amber). **기어/⚙ 설정 아이콘 완전 제거**. 헤더 bg = `term-nav`(Aidit screen).
  2. **LLM 상태**: `rest.getRuntime()` 는 이미 존재(GET /runtime → {model, baseURLHost}). 신규 `frontend/src/components/LlmStatusBadge.tsx`(Aidit GeminiStatusBadge 미러): `●` connected(model 해석 성공 → text-term-fg-bright + glow) / `○` offline(fetch 에러 → text-term-red animate-pulse) / `○` unknown(로딩 중 → text-term-faint). mount + window focus 시 fetch. 라벨 `LLM`(작은 대문자), title = `model@baseURLHost`. **키는 절대 노출 안 함**(응답에 키 없음).
  3. **바텀 탭바**(AppShell.tsx 내): emoji 글리프(🏠/＋/👤) → Aidit 인라인 SVG(22x22, stroke=currentColor, strokeWidth 1.6) Home/Write/Profile 로 교체. 기존 3 라우트(/, /create, /me) 유지. active text-term-amber, inactive text-term-dim, bg term-nav.
- **i18n**: `common.llmConnected` / `common.llmOffline` / `common.llmUnknown`(aria/title) 키 추가(ko/en). 사용자 노출 문자열 하드코딩 없음.
- **보안(TRD §8)**: apiKey 절대 노출 금지. 상태 배지는 model 명 + baseURLHost 만 title 로 표기.
- **변경 파일**: `frontend/src/layout/AppShell.tsx`(수정), `frontend/src/components/LlmStatusBadge.tsx`(신규), `frontend/src/i18n/dicts/common.ts`(키 추가).
- **검증(통과)**: `cd frontend && npx tsc --noEmit` → 에러 0. `npx vite build` → `✓ 90 modules transformed`, `✓ built in 1.88s` (exit 0). 기존 라우트(/, /create, /me)·동작 불변.

### 2026-06-26 · [feat] · 완료 · Aidit 팔레트 채택(term-* 토큰 재평가) + favicon 에셋 + Logo 컴포넌트 포팅 — 프런트엔드
- **요청(사용자)**: 부모 Aidit 의 비주얼을 Audit-Code 에 이식. (1) `term-*` 토큰 **이름은 유지**하고 값만 Aidit 팔레트로 역할(role) 기준 재평가. index.css 의 배경 그라데이션·CRT 스캔라인/비네트/placeholder/스크롤바를 Aidit 값으로 교체. (2) `frontend/public/` 생성 후 Aidit favicon 에셋 복사 + index.html `<link rel=icon>` 추가(title/theme-color 유지). (3) Aidit Logo 컴포넌트(인라인 SVG 삼각형 'A', stroke #5cff9a, glow)를 `frontend/src/components/Logo.tsx` 로 포팅. 헤더 와이어링은 다음 단계.
- **(1) tailwind.config.js 역할→값 매핑(이름 유지, 값만 Aidit 로)**:
  - `term-bg` (앱 backdrop): `#04130b` → `#020a05` (Aidit bg)
  - `term-panel` (카드/패널): `#08220f` → `#04130b` (Aidit card)
  - `term-sunken` (입력/sunken): `#04130b` → `#03100a` (Aidit input)
  - `term-nav` (헤더/탭바 bg): `#061a0d` → `#04130b` (Aidit screen)
  - `term-modal` (모달): `#06160c` → `#06190e` (Aidit info)
  - `term-chart` (차트): `#06140a` → `#06190e` (Aidit info, 최근접)
  - `term-line` (디바이더): `#114e2b` → `#1d4a30` (Aidit border)
  - `term-border` (기본 보더): `#1c7a42` → `#1d4a30` (Aidit border)
  - `term-border-dim` (dim 보더): `#185c33` → `#1d4a30` (Aidit 단일 border)
  - `term-active` (active/focus): `#2bd46f` → `#3fa564` (Aidit cta)
  - `term-fg-bright` (최고 명도 텍스트): `#9affc4` → `#aaffc0` (Aidit bright)
  - `term-glow` (글로우/헤딩): `#5cff9a` → `#7dffa0` (Aidit title)
  - `term-fg` (본문 텍스트): `#36c46f` → `#4fbf72` (Aidit dim)
  - `term-dim` (2차 텍스트): `#1f9d56` → `#4fbf72` (Aidit dim)
  - `term-dim-2`: `#1c8f4d` → `#2f8a52` (Aidit faint)
  - `term-dim-3`: `#157a3f` → `#2f8a52` (Aidit faint)
  - `term-faint` (placeholder/hint): `#176a3b` → `#2f8a52` (Aidit faint)
  - `term-amber`: `#ffcf4a` → `#ffcf6b` (Aidit amber)
  - `term-red`: `#ff7a7a` → `#ff6b6b` (Aidit danger)
  - 유지: `term-amber-line` `#6e5a1e`, `term-amber-bg`, `term-red-line`, `term-red-bg` (Aidit 에 직접 대응 없음 — 역할 보존).
  - `backgroundImage.term-screen` 그라데이션: `radial(125% 80% at 50% -5%, #0c2a18 0%, #04130b 58%, #020a06 100%)` → Aidit `radial(120% 80% at 50% 0%, #06190e 0%, #04130b 55%, #020a05 100%)`. `term-cta` 그라데이션은 양쪽 동일(`linear 180deg #155230→#0c3a20`) — 불변.
- **(1) index.css**: body 배경을 Aidit 그라데이션으로 교체 + `background-attachment: fixed`. body text color `#36c46f`→`#4fbf72`(term-fg/dim). text-shadow phosphor glow rgba(125,255,160,..) 계열로 정렬. placeholder `#176a3b`→`#2f8a52`. 스크롤바 thumb `#185c33`→`#1d4a30`, track `#04130b` 유지, hover `#3fa564` 추가, `scrollbar-color: #1d4a30 #04130b`. 스캔라인 alpha 0.16→0.18(~3px). 비네트 55% falloff. focus-visible ring `#2bd46f`→`#3fa564`. term-cursor `#5cff9a`→glow 정렬.
- **(2) favicon**: `frontend/public/` 신규 생성 후 Aidit `frontend/public/` 에서 favicon.svg, favicon-32.png, favicon-16.png, apple-touch-icon.png, icon-192.png, icon-512.png, maskable-512.png 복사. index.html `<head>` 에 `<link rel=icon svg>` + png 32/16 + apple-touch-icon 추가. `<title>AIDIT-CODE</title>` 와 `theme-color #04130b` 유지.
- **(3) Logo.tsx**: Aidit Logo 포팅(`frontend/src/components/Logo.tsx` 신규). 인라인 SVG 삼각형 'A' 마크(stroke #5cff9a, drop-shadow glow), `size?: 'sm'|'lg'`, `withWordmark` prop. 워드마크 텍스트는 `AIDIT-CODE` 로, `text-term-fg-bright`(신 팔레트) 사용. 헤더는 이 단계에서 미변경.
- **보안(TRD §8)**: 순수 정적 테마/에셋 변경 — LLM apiKey 미노출. `GET /runtime`{model,baseURLHost} 계약 불변.
- **i18n**: Logo 워드마크는 고정 브랜드명(AIDIT-CODE)으로 사용자 가변 문자열 아님 → t() 비대상(브랜드 토큰). 기존 i18n 영향 없음.
- **검증(③)**: frontend `npx tsc --noEmit` **클린(exit 0)**, `npx vite build` **PASS(88 모듈 transformed, built in 1.94s, exit 0)**. dist 에 favicon.svg/favicon-16·32.png/apple-touch-icon.png/icon-192·512.png/maskable-512.png 7개 전부 출력 확인, dist/index.html 에 icon link 4개(svg+png16/32+apple-touch) + `<title>AIDIT-CODE</title>` 유지 확인. 기존 라우트/동작 무변경(순수 테마/에셋/신규 컴포넌트).
- 변경 파일: `frontend/tailwind.config.js`, `frontend/src/index.css`, `frontend/index.html`, `frontend/public/`(신규 7 에셋: favicon.svg, favicon-16.png, favicon-32.png, apple-touch-icon.png, icon-192.png, icon-512.png, maskable-512.png), `frontend/src/components/Logo.tsx`(신규), `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [fix] · 완료 · reasoning_effort 를 추론 모델일 때만 전송 — gpt-4o-mini 회귀 방지
- **증상(잠재 회귀)**: 프런트가 aiMode 에서 항상 기본값 `medium` 을 보내므로, 워커가 매 AI 메시지에 `reasoning_effort` 를 실어 보냄. 현재 설정 모델은 `openai/gpt-4o-mini`(GitHub Models)인데, 이 필드는 reasoning 모델 전용이라 비-reasoning 모델에서 400(Unknown parameter) 위험 → **잘 동작하던 채팅을 깨뜨릴 수 있음**. 기존 가드(`값 있을 때만 포함`)는 프런트가 항상 값을 보내므로 무력.
- **수정**: `piWorkerBody.mjs` 에 `reasoningEffortApplies(model, effort, envOverride)` 추가 — 유효 effort + 게이트 통과일 때만 적용. 게이트(`REASONING_EFFORT` env, 기본 `auto`): `off`→미전송, `on`→항상 전송, `auto`→모델명이 reasoning 패턴(o1~o9 계열, gpt-5 계열; `openai/` 프리픽스 허용)일 때만. `piWorker.mjs` 의 `runLlmAgent` 가 이 함수로 effective effort 를 계산해 전달 → gpt-4o-mini 는 `auto` 에서 미전송(기존 동작 보존), 추론 모델·`on` 에서만 전송. `buildCompletionBody` 는 불변(기존 단위테스트 유효).
- **검증(③)**: backend `tsc --noEmit` 클린, `vitest run` **82/82 GREEN**(이전 79 + 게이트 3 케이스: auto→gpt-4o-mini 미전송·o3/o4-mini/gpt-5 전송, on/off override, 무효 effort 미적용). `buildCompletionBody` 불변이라 기존 단위테스트 유효.
- 변경 파일: `backend/src/agent/piWorkerBody.mjs`, `backend/src/agent/piWorker.mjs`, `backend/test/reasoningEffort.test.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 이미지 첨부+에이전트 비전(Feature A) + per-message reasoning_effort(Feature B) — 프런트엔드
- **요청(사용자)**: 백엔드(완료) 위에 프런트 UI 를 얹는다. (A) 메시지 컴포저에서 이미지 1장 첨부(미리보기/제거) → `POST /uploads` → `{imageUrl}` → `sendMessage` 에 동봉(이미지-only 전송 허용). 버블에 이미지 렌더. (B) 컴포저에 3분할 `reasoning_effort`(low/medium/high) 선택기(aiMode 켜졌을 때만 활성, 기본 medium) → `sendMessage` 에 `reasoningEffort` 동봉.
- **설계(프런트)**:
  - **rest.ts**: `uploadImage(file): Promise<{imageUrl}>` 추가(multipart FormData, Bearer, 400/413 → ApiError). `sendMessage` payload 타입에 optional `imageUrl?:string|null` · `reasoningEffort?:'low'|'medium'|'high'` 추가. `assetUrl()` 헬퍼 추가(상대 `/uploads/*` 를 API origin 으로 해석 — dev 는 프록시라 상대경로 그대로, prod 는 `VITE_API_ORIGIN` prefix).
  - **types.ts**: `Message` DTO 에 `imageUrl?:string|null` 추가.
  - **Composer.tsx**: 숨김 `<input type=file accept=image/png,image/jpeg,image/webp,image/gif>` + 첨부 버튼(term-*, ≥44px, i18n aria). 선택 시 타입/5MB 검증 → 썸네일 미리보기 + 제거 버튼(objectURL revoke). 전송 시 파일 있으면 먼저 `uploadImage` → imageUrl 포함해 `sendMessage`. 이미지-only(빈 텍스트+이미지) 허용. 낙관 버블에 로컬 미리보기(objectURL) 표시 후 reconcile. aiMode 켜졌을 때만 활성인 3분할 reasoning_effort 선택기(기본 medium), 값은 컴포넌트 state(세션 한정), payload 동봉.
  - **ChatBubble.tsx**: `imageUrl`(또는 낙관 로컬 `localImagePreview`) 있으면 이미지 렌더(반응형 max-width, term-* 프레이밍, i18n alt). `assetUrl()` 로 백엔드 origin 해석.
  - **vite.config.ts**: dev 프록시에 `/uploads` 추가(단일 origin — CSP connect-src 'self', 이미지 src 도 동일 origin).
  - **i18n thread.ts(ko/en)**: `unsupportedImageFormat`, `imageTooLarge`, `imageReadError`, `attachImageAria`, `removeImageAria`, `attachPreviewAlt`, `messageImageAlt`, `reasoningEffortAria`, `reasoningEffortLow`(낮음/low), `reasoningEffortMedium`(중간/medium), `reasoningEffortHigh`(높음/high).
- **이미지 URL cross-origin 해석**: dev 는 vite 프록시(`/uploads`→Fastify)로 상대경로가 그대로 동일 origin. prod 빌드는 `assetUrl()` 이 `VITE_API_ORIGIN`(설정 시)을 prefix, 미설정이면 상대경로 유지(동일 origin 배포 가정). 백엔드 반환 경로 `/uploads/<uuid>.<ext>` 와 정확히 일치.
- **보안(TRD §8)**: 프런트는 LLM apiKey 를 다루지 않음. 업로드는 Bearer + 서버측 UUID/MIME/5MB 가드(백엔드). 클라 검증(타입/5MB)은 UX 보조이며 서버가 권위. objectURL 미리보기는 reconcile/실패 시 정확히 1회 revoke(누수 방지).
- **검증(③)**: frontend `npx tsc --noEmit` **클린(exit 0)**, `npx vite build` **PASS(88 모듈 transformed, built in 1.84s, exit 0)**. 백엔드 무변경 — 기존 79 테스트 영향 없음(프런트 전용). i18n: `resolveKey` 가 첫 점만 분리하므로 `thread.reasoningEffort*`/`thread.*Image*` 키 정상 해석(ko/en). reasoning 옵션 라벨은 정확히 KO 낮음/중간/높음, EN low/medium/high.
- 변경 파일: `frontend/src/api/rest.ts`, `frontend/src/api/types.ts`, `frontend/src/components/Composer.tsx`, `frontend/src/components/ChatBubble.tsx`, `frontend/vite.config.ts`, `frontend/src/i18n/dicts/thread.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 이미지 첨부+에이전트 비전(Feature A) + per-message reasoning_effort(Feature B) — 백엔드
- **요청(사용자)**: (A) 메시지 컴포저에서 이미지 1장을 첨부하면 에이전트가 그 이미지를 **실제로 본다**(OpenAI multimodal `image_url` content part). (B) Aidit 의 "답변 길이(짧게/보통/길게)"를 여기서는 **per-message `reasoning_effort`(low/medium/high)** 로 용도 변경. 둘 다 컴포저에서 메시지 단위로 선택.
- **설계(백엔드)**:
  - **deps**: `@fastify/multipart@^9`(5MB fileSize limit, files:1), `@fastify/static@^8`(/uploads 정적 서빙, index/list 비활성) 추가. app.ts 에서 multipart→mkdir(uploadDir)→static 순으로 register.
  - **업로드 디렉토리**: `UPLOAD_DIR`(미설정 시 `backend/uploads`) 부팅 시 생성. `.gitignore` 에 추가. URL prefix `/uploads`.
  - **POST /uploads (requireAuth)**: multipart 파일 1개. MIME ∈ {image/png,image/jpeg,image/webp,image/gif} 화이트리스트 — 비이미지 400, 5MB 초과 413. `<uuid>.<ext>`(확장자는 MIME 에서 도출, 클라 파일명 절대 미사용)로 기록. 201 `{ imageUrl: '/uploads/<uuid>.<ext>' }`. 응답에 키/시크릿 없음.
  - **schema**: `Message.imageUrl String?`(optional) 추가. `prisma db push`(non-interactive) + `prisma generate`. 테스트 DB(`backend/prisma/prisma/dev.db`, db push 모드 — 마이그레이션 없음)도 동일 컬럼 반영.
  - **POST /posts/:id/messages**: optional `imageUrl` 수용. 자기 소유 `/uploads/<uuid>.<ext>` 형태만 화이트리스트(절대경로/traversal/타 prefix 거부). HUMAN 메시지에 저장. imageUrl 있으면 빈 body 허용(이미지-only 메시지). optional `reasoningEffort ∈ {low,medium,high}` 파싱(aiMode 시 기본 'medium', 그 외 무시).
  - **비전 스레드-스루**: messages.ts → `runAgentTurn`(RunAgentTurnArgs 에 `image?:{absPath,mime}` 추가) → `runtime.send`(image/reasoningEffort 인자 추가) → pi.ts stdin(`{type:'input',...,image?,reasoningEffort?}`) → piWorker.mjs. 워커가 절대경로를 업로드 디렉토리 가드 후 읽어 base64 data-url 로 구성, user content 를 `[{type:'text',text},{type:'image_url',image_url:{url:<data-url>}}]` 배열로. 이미지 없으면 기존 plain string content(동작 무변).
  - **reasoning_effort**: piWorker 의 /chat/completions body 에 값이 있을 때만 `reasoning_effort` 포함(없으면 필드 생략 — 비지원 모델 호환). 모델이 reasoning 지원해야 적용됨(주석).
- **보안(TRD §8)**: apiKey 는 어떤 응답/이벤트/로그에도 미포함(기존 redact 유지). 업로드 파일은 UUID 파일명, MIME 화이트리스트, 5MB 캡. 워커의 이미지 파일 읽기는 업로드 디렉토리 경로 가드(.. 차단).
- **A/B 스레드-스루(시그니처 변경)**:
  - `turn.ts` `RunAgentTurnArgs` 에 `image?:{absPath,mime}`·`reasoningEffort?:string` 추가 → `runtime.send(session,input,lang,onToken,onTool?, options?)` 로 `{image,reasoningEffort}` 전달.
  - `runtime.ts` `AgentRuntime.send` 에 6번째 인자 `options?: TurnOptions` 추가(`TurnOptions = {image?:TurnImage; reasoningEffort?:string}`, `pi.ts` export).
  - `pi.ts` `PiRuntime.send` 가 `options` 를 받아 stdin `{type:'input',text,lang, image?, reasoningEffort?}` 로 기록(값 있을 때만 포함). `buildInjectedEnv` 가 워커에 `UPLOAD_DIR` 주입(경로 가드 기준). `redactSpawnEnv` 에 `UPLOAD_DIR`(비밀 아님) 추가.
  - `piWorker.mjs` 의 `input` 핸들러가 `image{absPath,mime}`·`reasoningEffort` 를 파싱해 `runTurn`→`runLlmAgent` 로 전달.
- **워커의 비전 content + reasoning_effort(순수 헬퍼 분리)**: 부트스트랩 부작용(readline/'ready'/keepalive) 없는 `backend/src/agent/piWorkerBody.mjs` 로 분리(단위 테스트 가능):
  - `buildUserContent(prompt,image,uploadDir)`: 이미지 없으면 plain string(동작 무변); 있으면 `imageToDataUrl` 로 파일을 읽어 `[{type:'text',text},{type:'image_url',image_url:{url:<data-url>}}]` 배열. `imageToDataUrl` 은 absPath 가 `uploadDir` 내부일 때만 읽음(.. /외부/미허용 MIME/uploadDir 미주입 → null → 텍스트-only 폴백). 이미지-only(빈 텍스트)도 LLM 호출(text 파트는 빈 문자열).
  - `buildCompletionBody(messages,model,tools,reasoningEffort)`: `reasoning_effort` 는 값이 low/medium/high 일 때만 포함(없거나 무효면 필드 생략 — 비-reasoning 모델 거부 방지). 워커 fetch body 가 이 함수를 사용.
- **/uploads 계약**: `POST /uploads`(requireAuth, multipart 파일 1개) → 비이미지 400, 5MB 초과 413, 성공 201 `{ imageUrl: '/uploads/<uuid>.<ext>' }`(ext 는 MIME 도출, 클라 파일명 미사용). MIME→ext: png→png, jpeg→jpg, webp→webp, gif→gif. 정적 서빙 `GET /uploads/<uuid>.<ext>`.
- **schema 적용**: `Message.imageUrl String?` 추가 → `npx prisma db push`(non-interactive) 성공(DB 동기화 31ms). `prisma generate` 는 실행 중인 dev tsx 프로세스가 query engine DLL 을 잠가 EPERM(엔진 rename 만 실패) — 그러나 추가 컬럼은 엔진 바이너리 불변이고 생성된 TS 타입(`node_modules/.prisma/client/index.d.ts`)에는 `imageUrl` 이 정상 반영됨(확인). 테스트 DB(`backend/prisma/prisma/dev.db`, db push 모드 — 마이그레이션 없음)도 같은 db push 로 컬럼 반영됨(스위트 통과로 확인).
- **검증(③)**: backend `npx tsc --noEmit` **클린(exit 0)**. `npx vitest run` **79/79 GREEN(22 파일)** — 기존 61 유지 + 신규 18(uploads 4, messageImage 4, reasoningEffort 10). `node scripts/key-grep-gate.mjs` **PASS**(130 파일 스캔, 하드코딩 키 0 — 테스트의 base64 PNG/UUID 도 통과).
- 변경 파일: `backend/package.json`(+package-lock.json), `backend/src/app.ts`, `backend/src/config.ts`, `backend/src/routes/uploads.ts`(신규), `backend/src/routes/index.ts`, `backend/src/routes/messages.ts`, `backend/src/domain/imageRef.ts`(신규), `backend/prisma/schema.prisma`, `backend/src/agent/turn.ts`, `backend/src/agent/runtime.ts`, `backend/src/agent/pi.ts`, `backend/src/agent/piWorker.mjs`, `backend/src/agent/piWorkerBody.mjs`(신규), `backend/test/uploads.test.ts`(신규), `backend/test/messageImage.test.ts`(신규), `backend/test/reasoningEffort.test.ts`(신규), `backend/.gitignore`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 글 진입 시 lazy auto-attach UX(인증+활성세션 한정, eager spawn 금지, StrictMode 중복 방지)
- **요청(사용자)**: 글 진입 시, 이미 활성 세션이 있으면 사용자가 "세션 시작" 버튼을 누르지 않아도 조용히 attach 되어 실행 중(running) 배지가 떠야 한다. 단, **새 프로세스를 spawn 하는 비용이 큰 절반은 하지 않는다**(no eager spawn).
- **설계(lazy auto-attach, NOT eager spawn)**:
  - 진입 시 `id` 가 바뀔 때마다 단발성 effect 가 다음 4중 게이트를 모두 통과할 때만 기존 `handleStartSession()` 경로를 1회 호출(백엔드는 이를 값싼 attach/no-op fan-out 으로 처리 — 신규 spawn 아님).
    - **① 인증 게이트**: `token` 이 있어야 함. 게스트(token 없음)는 절대 자동 트리거 안 함, `openLogin()` 도 절대 호출 안 함(읽기 전용 브라우징 + 기존 클릭→로그인 흐름 유지).
    - **② 활성 세션 게이트**: `getPost` 가 활성 세션을 반환했을 때만(`post.session` 존재 + status 가 STOPPED/ERROR 아님). 활성 세션이 없으면 자동 spawn/자동 startSession 안 함 — 기존 수동 버튼 그대로 두고, 첫 사용자 메시지(aiMode)가 기존 백엔드 경로로 spawn.
    - **③ no-spawn 불변식**: 누군가 글을 열었다는 이유만으로 새 프로세스를 절대 띄우지 않음(②가 보장 — 활성 세션이 있을 때만 attach).
    - **④ StrictMode/재렌더 중복 방지**: `autoAttachedRef`(useRef) 가드로 StrictMode 더블 마운트·재렌더에도 스레드(id)당 최대 1회만 발화. `id` 변경 시 리셋. 기존 스크롤/가드 effect 와 충돌 없음(별도 effect).
  - 자동 attach 도 `handleStartSession` 을 재사용하므로 실패 시 기존 `errors.sessionFailed`/`errors.networkError` 처리·`startingSession` 스피너·`setActiveSession` 동작을 그대로 공유. 신규 사용자 노출 문자열 없음.
- **보안(TRD §8)**: 프런트 변경만이며 LLM apiKey 를 다루지 않음(`startSession` 응답은 `{ session }` 만 — apiKey 미포함).
- **검증(③)**: frontend `npx tsc --noEmit` **클린(에러 0)**, `npx vite build` **PASS(88 모듈 transformed, built in ~1.8s, exit 0)**. 로직 재검토 — ① `autoAttachedRef` 기본 false, id 변경 effect 에서 false 로 re-arm → 스레드당 1회. ② effect 가드 `if (autoAttachedRef.current) return; if (loading || !token || !sessionActive || startingSession) return;` → 게스트(token 없음)·비활성 세션·로딩 중·수동 시작 중엔 발화 안 함. ③ 활성 세션 없을 때 startSession 미호출(no-spawn-on-entry). ④ 자동 경로는 `handleStartSession`(token 있을 때만 진입하므로 `openLogin()` 미도달) 재사용. backend 무변경이라 기존 57 테스트 영향 없음(프런트 전용).
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-26 · [feat] · 완료 · 세션 시작/attach 동시성 가드(per-sandbox mutex + spawn 멱등 + Race B 복구 공용 헬퍼화)
- **배경/문제**: 글 진입 시 자동 세션 시작(auto-session-on-entry)이 같은 sandbox 로 고빈도 동시 호출을 유발한다. 현재 `lookup→attach→spawn→create` 임계구역을 직렬화하는 락/트랜잭션/UNIQUE 가 전혀 없어 다음 경합이 가능하다.
  - **Race A/D (process-level)**: `pi.ts:spawn()` 이 `handles.set(sandbox.id, ...)` 를 **무조건 덮어써** 직전의 살아있는 자식을 고아로 만든다. 동시 두 호출이 두 자식을 띄우고 하나만 레지스트리에 남는다.
  - **Race B (messages/aiMode)**: `messages.ts:ensureActiveSession` 은 attach 실패 시 stale 세션을 STOPPED 로 닫기만 하고 **stale RUNNING 정규화도, spawn 도 하지 않아** `null` 반환 → 서버 재시작 후 aiMode 전송·`maybeAutoReply` 가 조용히 실패(`session.ts` 의 최근 수정이 여기엔 미적용).
- **설계(한 지점으로 수렴)**:
  - 신규 `backend/src/agent/sessionStart.ts` 가 임계구역 전체를 캡슐화하는 `startOrAttach()` 를 export. 동작: 활성 세션 lookup → attach(live 면 no-op) → attach-fail 시 stale 세션 STOPPED + stale RUNNING→SUSPENDED 정규화 → READY/SUSPENDED 면 spawn → AgentSession(STARTING→IDLE) → sandbox RUNNING. session.status/sandbox.status 이벤트는 헬퍼 내부에서 publish(라우트와 동일 동작). 반환은 `{ session, attached }` 또는 실패 시 `{ reason:'NOT_READY' }`(라우트가 409 로 매핑).
  - **per-sandbox mutex(최우선 가드)**: 모듈 레벨 `Map<sandboxId, Promise>` 로 같은 sandboxId 의 동시 호출을 하나의 in-flight Promise 로 coalesce. 두 번째 호출은 첫 호출 결과를 await(자체 lookup/spawn 안 함). `finally` 에서 맵 정리. 프로세스 내 Race A/D 봉쇄.
  - **pi.ts spawn 멱등**: `spawn()` 이 기존 핸들이 **살아있으면** 새 자식을 SIGTERM 으로 정리(loser)하고 기존 pid 를 반환(고아 방지). 죽은 핸들이면 정상 교체. on-exit cleanup 은 `h.child===child` 가드로 유지.
  - 라우트 3곳(`session.ts` POST /session, `messages.ts` ensureActiveSession, `posts.ts` maybeAutoReply)을 모두 헬퍼로 경유 → Race B 복구 + mutex 가 전역 적용. `session.ts` 의 inline stale-RUNNING 블록은 헬퍼로 이동(중복 제거). 응답코드 유지(200 attach / 201 fresh / 409 not-ready).
- **DB defense-in-depth**: datasource=**sqlite**(schema.prisma:11). 활성 상태 한정 partial/filtered UNIQUE(sandboxId) 는 SQLite + Prisma 에서 비자명(Prisma 가 partial index unique 제약을 직접 표현 못 함) → **SKIP**. in-process mutex 가 1차 가드이며 멀티 인스턴스(수평확장) 안전성은 open item(후속: Postgres 전환 시 partial unique + advisory lock).
- **capacity gate(optional)**: spawn 직전 `sandboxLimiter` 획득은 기존 provision(POST /posts)과 슬롯 의미가 얽혀(거기서 선점→provision finally 반납) 세션 시작에 끼우면 provisioning 의미가 흔들릴 위험 → **SKIP**(노트만). mutex + 멱등 + Race B 가 필수 항목.
- **검증(③)**: backend `npx tsc --noEmit` **클린(에러 0)**. `npx vitest run` **61/61 GREEN(19 파일)** — 기존 57 유지 + 신규 `sessionStart.test.ts` 4 케이스. 응답코드 보존 확인(로그: fresh 201 → attach 200 → CREATING 409). 키 누출 없음(헬퍼 반환/이벤트에 apiKey 미포함, AgentSession.model 은 모델명만).
- **회귀 테스트**: `backend/test/sessionStart.test.ts`(4 케이스) — (a) 동일 sandbox 8개 동시 `startOrAttach`: `piRuntime.spawn` 정확히 **1회** 호출 + 활성 세션 행 **1개** + 모든 호출자 동일 session id(coalesce 증명), 핸들 1개. (b) Race B: stale RUNNING + 활성 IDLE 행 + `attach` throw 일 때 `ensureActiveSession` 이 **null 대신** 새 IDLE 세션 반환(stale→STOPPED, sandbox 재-RUNNING). (c) `session.ts` 201(fresh)→200(attach, 동일 id)→409(CREATING) 유지. `vi.spyOn(piRuntime, 'spawn'|'attach')` 시임 사용. 실제 stub piWorker spawn(네트워크 없음).
- **mutex 동작(요약)**: `startOrAttach()` 진입 시 `inFlight.get(sandboxId)` 에 진행 중 Promise 가 있으면 그것을 그대로 await(자체 lookup/spawn 안 함). 없으면 임계구역 본체 Promise 를 만들어 맵에 등록 후 await, `finally` 에서 (자기 Promise 일 때만) 제거. + pi.ts spawn 멱등(live 핸들이면 기존 pid 반환, onReady 시점 set 직전 재확인으로 loser SIGTERM)이 보강.
- 변경 파일: `backend/src/agent/sessionStart.ts`(신규), `backend/src/agent/pi.ts`, `backend/src/routes/session.ts`, `backend/src/routes/messages.ts`, `backend/test/sessionStart.test.ts`(신규), `docs/IMPLEMENTATION_NOTES.md`. (`posts.ts:maybeAutoReply` 는 이미 `ensureActiveSession` 경유라 자동으로 헬퍼/mutex 적용 — 코드 변경 불필요.)

### 2026-06-25 · [fix] · 완료 · 서버 재시작 후 세션 시작 실패(stale RUNNING 샌드박스 → 409) → SUSPENDED 정규화로 resume
- **증상(사용자)**: 이미 에이전트 활동이 있던 글에서 서버 재시작 후 "세션 시작" 시 프런트가 "Failed to start the agent session. Please retry." 표시. 작성자/게스트 무관(소유권 문제 아님).
- **원인(stale-state)**: 활동 이력이 있는 글은 DB 에 `sandbox.status='RUNNING'` + 활성(IDLE) AgentSession 행이 남는다. 서버 재시작 시 in-memory 핸들이 사라져 `runtime.attach` 가 `no active runtime process to attach to` throw(`backend/src/agent/pi.ts`). attach-fail catch 가 stale 행을 STOPPED 로 닫고 `startFreshSession` 으로 떨어지지만, 샌드박스가 여전히 `RUNNING`(READY/SUSPENDED 아님) → 409 `sandbox is RUNNING; cannot start a session`.
- **수정(한 지점, 최소)**: `POST /posts/:id/session` 의 attach-fail catch 에서 stale 세션을 STOPPED 로 닫은 **직후, startFreshSession 호출 전**에 stale 한 `RUNNING` 샌드박스를 정규화한다. 프로세스는 죽었지만 디렉토리는 보존됨 → 의미상 resume 이므로 `setSandboxStatus(sandbox.id, 'SUSPENDED')`(이미 import) 로 전이하고, 반환된 행의 status 로 로컬 `sandbox.status` 를 갱신해 `startFreshSession` 이 SUSPENDED 를 보게 한다. `sandbox.status` 이벤트도 함께 publish 되어 바람직. CREATING/ERROR 는 정상적으로 409 유지(RUNNING 만 stale-active 케이스).
- **회귀 테스트**: `backend/test/sessionAttachFail.test.ts` 추가(2 케이스) — ① `normalizes RUNNING→SUSPENDED and starts a fresh session (201), not 409`: 활성 IDLE AgentSession 행 + `runtime.attach` throw(프로세스 소멸) + 샌드박스 RUNNING 일 때 409 가 아니라 stale 세션을 STOPPED 로 닫고 새 세션(201, IDLE)을 반환함을 단언. ② `does NOT force-resume a CREATING sandbox (still 409)`: CREATING 은 정규화 대상이 아니라 409 유지 확인. `vi.spyOn(piRuntime,'attach').mockRejectedValue(...)` 로 throw 유도, 실제 stub piWorker spawn 으로 fresh-start 검증.
- **검증(③)**: backend `npx tsc --noEmit` 클린(에러 0). `npx vitest run` **57/57 GREEN**(18 파일, 기존 55 + 신규 2). 신규 파일 단독 실행도 2/2 GREEN.
- 변경 파일: `backend/src/routes/session.ts`, `backend/test/sessionAttachFail.test.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-25 · [fix] · 완료 · 글 진입 시 맨 아래로 점프 → 맨 위(원문/첫 메시지) 표시, 라이브 팔로우는 보존
- **요청(사용자)**: 게시글(Thread) 진입 시 자동으로 맨 아래(최신/composer)로 스크롤되어 원문(📌)과 대화 시작점을 못 봄. 진입 시에는 **맨 위**를 보여주고, 스트리밍 중 라이브 팔로우와 "내가 보낸 메시지 따라가기"는 그대로 유지.
- **설계(가드형 top-on-entry)**:
  - `pinnedRef` 초기값 `true`→`false`. window 스크롤 기준, 진입 시 맨 위는 바닥과 멀므로 pinned=false 가 실제 상태. 첫 SSE 토큰이 reader 를 끌어내리는 것 방지.
  - `hasAutoScrolledRef`(useRef(false)) 일회성 가드 추가 — 스레드의 **첫 messages-driven 실행만** scrollIntoView 스킵 후 true.
  - hydrate 직후 `prevLastIdRef` 를 마지막 메시지 id 로 시드 → 첫 실제 변경을 새 메시지로 정확히 감지.
  - 자기 전송(HUMAN·authorId===userId) 재핀은 가드와 **독립**으로 먼저 적용 — 내 메시지/이어지는 에이전트 답변은 오늘처럼 팔로우.
  - 스크롤 리스너(120px)는 그대로 — 사용자가 바닥 근처로 스크롤하면 pinned=true 로 라이브 팔로우 자연 재개.
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS(88 모듈). 로직 검토 — ① 초기 hydrate 시 `hasAutoScrolledRef=false` → 첫 messages-driven 실행은 `firstRun && !selfSent` 로 early-return(top 유지). ② `pinnedRef` 초기 false 라 첫 스트리밍 토큰도 팔로우 안 함. ③ 자기 전송은 `selfSent` 로 가드 우회 + 재핀 → 본인/후속 에이전트 답변 팔로우. ④ `id` 변경 시 가드 refs 리셋 + `window.scrollTo(0,0)` 로 이전 라우트 스크롤 잔존 제거.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-25 · [fix] · 완료 · 입력창 placeholder 가 두 줄로 줄바꿈 → 한 줄로 단축(ko/en)
- **증상(사용자)**: 모바일에서 composer placeholder `메시지를 입력하세요… (AI on이면 에이전트가 응답)` 가 너무 길어 두 줄로 표시 → UX 불편.
- **수정**: `(AI on…)` 부가 설명 제거(바로 옆 AI 토글 칩이 같은 정보를 전달). KO `메시지를 입력하세요…`, EN `Type a message…` 로 단축. TRD §14.2 예시도 동일하게 정정.
- **검증(③)**: frontend `tsc --noEmit` 클린, `vite build` PASS. `thread.ts` ko/en `composerPlaceholder` 가 단축 문구로 갱신됨 확인.
- 변경 파일: `frontend/src/i18n/dicts/thread.ts`, `docs/TRD.md`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-25 · [fix] · 완료 · 도구 결과 버블이 완료 후에도 "실행 중…" 으로 남는 문제 → "실행 완료."
- **증상(사용자)**: 도구(write_file/shell) 실행이 끝나도 TOOL_RESULT 버블 배지가 계속 "실행 중…". 끝나면 "실행 완료." 로 바뀌어야 함.
- **원인**: `ToolResultBubble.tsx` 가 상태를 `tc?.status ?? (message.status==='FAILED'?'FAILED':'RUNNING')` 로 도출 — ① TOOL_RESULT 버블은 `toolCallId` 가 없어(연결은 TOOL_CALL 버블) 라이브 tool.* 패치가 닿지 않아 `tc` 가 null, ② 폴백이 `COMPLETE` 를 `RUNNING` 으로 매핑. 결과적으로 항상 RUNNING. 실제로 TOOL_RESULT 의 생명주기는 자신의 `message.status`(서버 finalize 가 `message.updated` 로 COMPLETE/FAILED 확정)가 권위인데 이를 무시.
- **수정**: `ToolResultBubble.tsx` 배지/커서를 `message.status` 기준으로 도출(STREAMING/PENDING→실행 중, COMPLETE→완료, FAILED→실패; `tc` 있으면 보조). i18n `thread.ts` 에 `toolDone`("실행 완료."/"Done.")·`toolFailed`("실행 실패"/"Failed") 추가. 성공 시 `✓ 실행 완료.`, 실패 시 `✗ 실행 실패 [exit N]`.
- **검증(③)**: workflow(구현→검증) + 독립 재확인 — frontend `tsc --noEmit` 클린, `vite build` PASS(88 모듈), `thread.ts` 에 `toolDone`/`toolFailed`(ko/en) 존재, 배지 상태가 `message.status` 기반(하드코딩 RUNNING 폴백 제거). 성공→`✓ 실행 완료.`, 실패→`✗ 실행 실패 [exit N]`.
- 변경 파일: `frontend/src/components/ToolResultBubble.tsx`, `frontend/src/i18n/dicts/thread.ts`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-25 · [feat] · 완료 · 글 생성 시 에이전트 자동 응답 + 브랜딩 "pi agent" → "Aidit Agent"
- **요청(사용자)**: ① 게시글을 처음 만들면 게시글 내용으로 에이전트가 자동 답변. ② UI 의 "pi agent"/"AI" 표기를 "Aidit Agent" 로. (workflow 로 작업)
- **설계 — 자동 응답(backend)**:
  - `turn.ts`: `runAgentTurn` 의 `humanMessage` 를 선택적으로, `prompt`(직접 입력 텍스트) 추가 — humanMessage 없으면 prompt 를 입력으로 쓰고 AGENT_REPLY.replyToId=null.
  - `messages.ts`: `ensureActiveSession` 를 export(중복 없이 재사용). (turn.ts↔messages.ts 순환을 피하려 오케스트레이션은 posts.ts 에 둔다.)
  - `posts.ts`: `provisionSandbox(sandbox)` resolve 후 `maybeAutoReply(postId)` — 샌드박스 READY·메시지 0건일 때만 ensureActiveSession → runAgentTurn(prompt = 제목+본문, lang=한글 감지). fire-and-forget, 예외 삼킴(글 생성 무영향).
- **설계 — 브랜딩(frontend)**: `i18n/dicts/thread.ts` 의 `agentLabel: 'pi agent [AGENT]'`(KO/EN) → `'Aidit Agent [AGENT]'`. 그 외 사용자 노출 "AI"/"pi agent" 도 에이전트 명칭이면 "Aidit Agent" 로. **백엔드 'pi' 런타임 키/파일명은 기능용이라 불변.**
- **구현(workflow)**: 2-에이전트 병렬(backend 자동응답 / frontend 브랜딩) → verify 게이트로 오케스트레이션.
  - verify 가 회귀 포착: 자동응답이 모든 글 생성에 비요청 턴을 주입 → 기존 `e2e`/`redaction` 테스트(글 생성 후 특정 agent 프레임 단정)를 오염(2 fail).
  - **수정**: `maybeAutoReply` 가 테스트 환경(`VITEST`/`NODE_ENV=test`)에서는 스킵(부수효과 비활성). 운영/개발 구동 영향 없음. `POST_AUTO_REPLY=1` 로 테스트에서 강제 가능.
- **검증(③)**:
  - backend `tsc` 클린 + `vitest` **55/55 GREEN**(게이트 후 회귀 해소); frontend `tsc` 클린 + `vite build` PASS(88 모듈).
  - **라이브**(gpt-4o-mini): 메시지 0건으로 글 "Write a short fizzbuzz function in Python" 생성 → **자동** AGENT_REPLY 등장("…saved to fizzbuzz.py") + TOOL_CALL FILE_WRITE/SUCCEEDED + `.sandboxes/<postId>/fizzbuzz.py`(283 bytes) 실제 생성. 자동응답이 도구까지 사용.
  - 브랜딩: frontend grep 결과 사용자 노출 "pi agent" 0건; `agentLabel='Aidit Agent [AGENT]'`(KO/EN). 'AI' 모드 토글 라벨은 에이전트 명칭이 아니라 모드 표시이므로 유지(검토 후 의도적 보존).
- 변경 파일: `backend/src/agent/turn.ts`, `backend/src/routes/{posts,messages}.ts`, `frontend/src/i18n/dicts/thread.ts`, `frontend/src/components/ChatBubble.tsx`(주석), `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-25 · [feat] · 완료 · 에이전트 도구 호출(function calling) — LLM 이 샌드박스에 코드 저장/읽기/실행
- **증상(사용자 보고)**: "코드를 저장해줘" → 에이전트가 "코드 저장 기능은 지원하지 않습니다. 코드를 제공해 드릴 수 있습니다"라고 거부. 샌드박스가 있는데도 파일 저장이 안 됨.
- **원인(고민)**: 실 LLM 연결이 **텍스트만 스트리밍**하고 LLM 에 도구를 알리지 않음(`tools` 미전달) + 응답의 `tool_calls` 미파싱. gpt-4o-mini 는 도구가 없으니 거부. 반면 도구 실행 파이프라인(M5: toolBridge→toolExec, pathGuard·tool.*·file.changed)은 이미 완성돼 있어 **연결 고리만 부재**.
- **수정(설계)**: 워커 실 모드에 OpenAI function-calling 에이전트 루프 구현, 기존 M5 파이프라인에 브리지.
  - `piWorker.mjs`: `write_file`/`read_file`/`delete_file`/`bash` 도구 스펙을 LLM 에 전달. 스트림에서 텍스트 delta(토큰)와 `tool_calls` delta(id/name/arguments 누적)를 함께 파싱. 도구 호출 시 기존 `{type:'tool', kind, relPath/content/command}` 인텐트로 방출 → 부모가 실제 실행 → ack 의 결과를 `tool` 역할 메시지로 history 에 넣고 루프(최대 N회). 세션 수명 동안 대화 history 유지(멀티턴). interrupt/timeout abort 유지.
  - `pi.ts`/`runtime.ts`: `ackTool(session, result?)` — `{type:'tool-done', result:{ok,output}}` 를 워커 stdin 으로 전달(하위호환: result 선택).
  - `turn.ts`: `onTool` 가 `runToolIntent` 결과를 받아 ackTool 로 전달.
  - `toolBridge.ts`: `runToolIntent` 가 `{toolCallId, ok, output}` 반환(SHELL 은 출력 청크 누적, 길이 캡).
  - 보안(TRD §8): 도구 args/result·`tool` 메시지에 키 없음(toolExec 보장). LLM 요청 키는 Authorization 헤더로만, 에코/로그 0.
  - 하위호환: 스텁 모드 + `!write/!shell/!demo` 수동 경로 불변 → 기존 M5/turn 테스트 무영향.
- **검증(③)**:
  - `tsc --noEmit` 클린; `vitest run` **55/55 GREEN**(스텁/수동 `!`-도구 경로·M5 toolCall 테스트 무영향).
  - mock-LLM tool_call 루프 단위 검증: 스트리밍 tool_calls(arguments delta 누적) → FILE_WRITE 인텐트(relPath/content/callId 정확) 방출 → ack 되먹임 → 후속 completion 텍스트("Saved hello.txt.") 까지 PASS.
  - **실 서버 라이브 e2e**(gpt-4o-mini): "hello.py 저장" 요청 → AGENT_REPLY "file has been created" + TOOL_CALL FILE_WRITE/SUCCEEDED + TOOL_RESULT "wrote hello.py (24 bytes)" + `tool.call`·`file.changed` 이벤트 + **`.sandboxes/<postId>/hello.py` 실제 파일 생성**(내용 verbatim) 확인.
- 변경 파일: `backend/src/agent/{piWorker.mjs,pi.ts,runtime.ts,turn.ts,toolBridge.ts}`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-25 · [fix] · 완료 · 스레드 채팅 자동 스크롤 — 전송/스트리밍 시 최신 버블 추종
- **증상(사용자 보고)**: 채팅이 길어져 스크롤이 생기면, 내가 메시지를 보내도 스크롤이 따라 내려가지 않아 마지막 채팅이 안 보임.
- **원인**: `Thread.tsx`의 자동 스크롤 `useEffect`가 ① `behavior:'smooth'`로 토큰마다 재호출돼 빠른 스트리밍에서 추종이 끊기고, ② 윈도우 스크롤 기준인데 `sticky bottom-0` Composer + AppShell의 sticky TabBar가 뷰포트 하단을 가려 마지막 버블이 footer 뒤에 숨음.
- **수정**: `Thread.tsx`
  - "하단 고정(pinned)" 추적: 윈도우 스크롤 리스너로 사용자가 바닥 근처면 추종, 위로 스크롤해 과거를 읽는 중이면 추종 보류(끌어내리지 않음).
  - **내가 보낸 메시지(HUMAN·authorId=본인)** 가 새로 추가되면 항상 강제로 하단 고정+스크롤 → 요청 동작 충족.
  - 토큰 누적 갱신은 즉시(`auto`), 새 버블 등장은 부드럽게(`smooth`).
  - 하단 센티넬에 `scroll-margin-bottom` 부여 → sticky Composer/TabBar 위로 마지막 버블이 보이도록.
- **검증(③)**: 프론트 `tsc --noEmit` 클린. 로직: pinned 추적(윈도우 스크롤), 본인 HUMAN 신규 버블 시 강제 추종, 토큰 갱신 즉시/신규 버블 부드럽게, 센티넬 scroll-margin-bottom 7rem.
- 변경 파일: `frontend/src/pages/Thread.tsx`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-25 · [fix] · 완료 · 에이전트가 에코만 응답하는 문제 — 실 LLM 스트리밍 연결 + 호출 타임아웃 (AR-PI SEAM)
- **증상(사용자 보고)**: ① "세션 시작"이 계속 끊긴다 ② "다이아몬드 모양 *" 요청에 에코만 오고 실제 에이전트 작업이 안 됨.
- **라이브 재현/진단**: `tsx src/app.ts`로 서버 기동 후 게스트→글→세션→SSE→메시지(aiMode) 전 구간 curl 재현.
  - 백엔드/세션/SSE는 정상: 세션 `STARTING→IDLE→RUNNING→IDLE`, SSE 토큰 스트리밍·종료까지 **끊김 없음**. (① "끊김"은 백엔드 세션 단절이 아니라 에이전트가 무의미한 에코만 내어 "작동 안 함"으로 인지된 것 + ③ 타임아웃 부재 시 도달불가 LLM 으로 턴이 무한 RUNNING 으로 멈추던 잠재 행 문제.)
  - 근본 원인(②): `backend/src/agent/piWorker.mjs`의 `simulateTurn()`이 M4 PoC 에코 스텁이라 **실 LLM을 호출하지 않음**. 실 GitHub Models 자격증명이 워커 env(`OPENAI_*`/`PI_*`)로 주입되지만 워커가 이를 무시하고 `[KO]/[EN] 에코:`만 흘림.
- **수정(②③)**: 워커의 자연어 응답 분기를 **OpenAI-compatible 스트리밍 호출**로 교체(M4가 명시한 SEAM 실현) + 호출 타임아웃 추가.
  - 실 모드: 주입된 `OPENAI_*`(폴백 `PI_*`) 자격증명으로 `POST {baseURL}/chat/completions`(stream:true) 호출, `choices[].delta.content`를 `{type:'token'}`으로 스트리밍. `lang` 힌트를 system 메시지로 전달. `{type:'interrupt'}` 시 `AbortController`로 즉시 중단.
  - 스텁 모드(결정성 보존): `AGENT_STUB=1` 또는 테스트(`VITEST`/`NODE_ENV=test`) 또는 자격증명 누락 시 기존 에코 동작 유지 → 기존 vitest 스위트 무영향.
  - **호출 타임아웃**(신규): `AGENT_LLM_TIMEOUT_MS`(기본 60s) 벽시계 상한. 초기 응답+스트림 수신 전체에 적용, 초과 시 abort → 일반 에러(`{type:'error'}`)로 턴 FAILED 마감. 도달 불가/지연 엔드포인트로 인한 무한 RUNNING("끊김" 체감) 방지.
  - `!write`/`!read`/`!del`/`!shell`/`!demo` 도구 컨벤션 분기는 두 모드 모두 그대로 유지(toolBridge 실행 경로 불변).
  - 보안(CLAUDE.md/TRD §8): 키는 stdout/이벤트/에러 메시지에 절대 미노출 — LLM 에러는 일반 문구만 방출, 응답 원문/상태코드/URL/키 미포함.
- **검증(③)**:
  - `tsc --noEmit` 클린; `vitest run` **55/55 GREEN**(스텁 모드 유지 — `VITEST` env 가 자식 워커로 전파되어 결정적 에코 보존).
  - 실 모드 성공 경로: 서버 spawn 경로(`getLlmRuntimeConfig`→`OPENAI_*` 주입→워커 spawn)를 그대로 재현한 진단 스크립트가 실 키(93자)로 **실제 다이아몬드 ASCII 스트리밍 생성** 확인. 별도 mock OpenAI SSE 서버로 토큰 재조립 시 완전한 다이아몬드 일치.
  - 실 모드 실패 경로(무행/무누출): 잘못된 키(401)·연결 거부·**무응답 서버(타임아웃 2s 설정 시 정확히 ~2.0s에 클린 에러)** 모두 `{type:'error',message:'agent turn failed'}`만 방출(키/원문 0건), 무한 행 없음.
  - 캐비엇: 백그라운드(`run_in_background`)로 띄운 테스트 서버는 네트워크/실키 부재로 워커 fetch 가 지연 → 이 타임아웃 수정이 바로 그 케이스를 클린 FAILED 로 마감함을 함께 확인.
- 변경 파일: `backend/src/agent/piWorker.mjs`, `docs/IMPLEMENTATION_NOTES.md`.

### 2026-06-25 · [docs] · 완료 · 프로젝트 그라운드 룰 도입
- 부모 Aidit의 Docs-before-code 규칙을 계승하고, **검증 → 문서 완료 표시 → 커밋**의 5단계 순서로 정밀화.
- 변경 파일:
  - `CLAUDE.md` (신규)
  - `AGENTS.md` (신규)
  - `docs/IMPLEMENTATION_NOTES.md` (신규)

### 2026-06-25 · [feat] · 완료 · M1 골격 (인증·게시글·홈 피드)
- PLAN.md §M1 구현 완료. 부모 대비 제거: 커뮤니티/페르소나(L8), API 키 입력 폼·키 저장(L1).
- 작업 패키지: BE-SCAF, BE-DB(Foundation 스키마 verbatim), BE-AUTH, BE-MW, BE-HOT, BE-cursor, BE-SBX(M1 행 생성 훅), BE-POST, BE-VOTE / FE-SHELL, FE-API, FE-AUTH, FE-HOME, FE-CREATE + i18n(KO/EN) 골격.
- **검증(③)**: 백엔드 `tsc --noEmit` 클린; 서버 부팅 + 스모크 PASS — `/health`, `/auth/guest`(서버 #hex4 부여), `POST /posts`(Post+Sandbox 1:1 CREATING/pi 자동 생성), `GET /posts?sort=new`(카드 sandbox.status 요약), 멱등 upvote(score/voted). 프론트 `tsc -b && vite build` PASS(73 modules). 키 누출 가드 PASS — LLM 키는 `backend/src/config.ts`(env 읽기+redaction)에만, 어떤 모델/DTO/응답/JWT/클라 스토어에도 없음.
- 종료 기준 충족: `{userId,username,token}` 영속화; 글 작성→Post+Sandbox(CREATING)→스레드 라우트; hot/new 커서 피드; 카드 sandbox.status; 서버 LLM 키 필드 0건; Login/Settings에 API 키 섹션 없음.
- 변경 파일: `backend/`(app/config/db/prisma·routes(auth/posts/index)·plugins/auth·domain(hotScore/cursor)·sandbox/service), `frontend/`(App·layout·api(rest/types)·stores(auth/lang/ui)·i18n·hooks·components·pages·tailwind/index.css), 루트 `.gitignore`(.sandboxes 추가).
- 알려진 제약(후속): hot 피드 keyset는 (createdAt,id) 앵커(다중 페이지 시 hotScore 변동 보정 필요); 게스트 #hex4 충돌 재시도가 create 오류 일반 포착. M1 범위 내 허용.

### 2026-06-25 · [feat] · 완료 · M2 샌드박스 프로비저닝 (글 생성 → 폴더 생성·할당)
- PLAN.md §M2 구현 완료. Foundation sandboxLifecycle §1.
- 작업 패키지: BE-SBX(setSandboxStatus 상태 전이 헬퍼 + path를 pathGuard로 산출), BE-PROV(fire-and-forget 비동기 프로비저닝: mkdir + `.sandbox-meta.json` 마커 + DB meta, CREATING→READY, 실패 ERROR, finally 슬롯 반환), BE-ISO(pathGuard: realpath 기반 `..`/symlink/절대경로 탈출 차단, PathEscapeError), BE-LIMIT(ConcurrencyLimiter, SANDBOX_MAX_CONCURRENT 기본 4, 초과 429-on-overflow 무큐잉), RT-PS(PubSub 인터페이스 + InMemoryPubSub + publishToPost), RT-SBXEV(discriminated RealtimeEvent union, sandbox.status 페이로드 TRD §7), FE-SBXBADGE(5상태 배지 검증).
- **검증(③)**: 백엔드 `tsc --noEmit` 클린; `vitest` 10/10 PASS(pathGuard 6·limiter 3·sandboxStatus 1); 부팅 스모크 — POST /posts 즉시 sandbox.status=CREATING → GET /posts/:id 폴링서 READY 전이 관측, ERROR 전이 직접 호출 확인; 12-동시 POST → 정확히 4×429 + 8×201; PubSub 구독자가 sandbox.status 이벤트 수신; 프론트 build PASS; 키 누출 가드 PASS(키는 config.ts에만, 이벤트/DTO/응답 0건); M1 회귀 PASS.
- 종료 기준 충족: 샌드박스 1:1 할당, CREATING→READY 전이 + 버스 발행(브라우저 SSE 종단은 M4), ERROR 표면화, 동시 초과 429, pathGuard 탈출 거부.
- 비고: 브라우저-facing `GET /posts/:id/stream`은 PLAN 순서상 M4(RT-STREAM). M2는 publish seam까지 닫고 인프로세스 구독으로 검증. 테스트 인프라(vitest) 도입 — M7 XC-T 기반.
- 변경 파일: `backend/src/realtime/{pubsub,publish,events}.ts`, `backend/src/sandbox/{pathGuard,limiter,provision,service}.ts`, `backend/src/routes/posts.ts`, `backend/src/config.ts`, `backend/{vitest.config.ts,package.json,.env.example,.env}`, `backend/test/{pathGuard,limiter,sandboxStatus}.test.ts`.

### 2026-06-25 · [feat] · 완료 · M3 pi agent 런타임 어댑터 (spawn/attach + OpenAI-compatible 주입)
- PLAN.md §M3 구현 완료. Foundation sandboxLifecycle §2, TRD §5.
- 작업 패키지: AR-CFG(`agent/config.ts`: getLlmRuntimeConfig 내부 주입용·getPublicRuntimeInfo {model,baseURLHost}만), AR-RT(`AgentRuntime` 인터페이스 + getAgentRuntime 팩토리/레지스트리, AGENT_RUNTIME 기본 'pi'), AR-PI(`pi.ts`+`piWorker.mjs`: 실 child process spawn, cwd=sandbox.path, OPENAI_*/PI_*+LANG_HINT env 주입, sandboxId→{child,pid} 레지스트리, attach 재사용, suspend SIGTERM, resume 재spawn, redactSpawnEnv), BE-SESS/BE-SUSPEND(`routes/session.ts`), RT-SESSEV(session.status 이벤트), GET-RUNTIME(`routes/runtime.ts`).
- **검증(③)**: `tsc --noEmit` 클린; `vitest` 16/16 PASS(M2 10 + runtime 4 + runtimeConfig 2); 세션 라이프사이클 스모크 — spawn→IDLE(실 OS pid, sandbox RUNNING)→2회차 동일 session·pid attach(무 respawn)→suspend(프로세스 종료·디렉토리 보존·SUSPENDED)→resume(신규 pid·RUNNING); `GET /runtime`={model, baseURLHost}만. **센티넬 키 누출 테스트 PASS** — 가짜 API_KEY/URL 자격증명이 어떤 응답·AgentSession 행(model 이름만)·이벤트 페이로드·서버 로그에도 0건; 키는 config.ts→agent/config.ts→pi.ts child env 주입 경로에만. 프로세스 위생 PASS(고아 없음). M1/M2 회귀 무사.
- 종료 기준 충족.
- 후속(비차단): ① 이 머신의 셸 env `BASE_URL=/`가 .env를 가리는 quirk → `usableBaseURL()` 폴백으로 기본값 사용; ② `npm run build`(tsc)가 `piWorker.mjs`를 `dist/agent/`로 복사하지 않음 — 런타임은 `tsx`로 구동하므로 무해, 실제 빌드 패키징은 후속; ③ sendInput/interrupt는 M3 스텁 → 턴 스트리밍은 M4(AR-TURN).
- 변경 파일: `backend/src/agent/{config,runtime,pi}.ts`+`piWorker.mjs`, `backend/src/routes/{session,runtime,index}.ts`, `backend/src/realtime/events.ts`, `backend/test/{runtime,runtimeConfig}.test.ts`.

### 2026-06-25 · [feat] · 완료 · M4 협업 채팅 + SSE fan-out (다중 attach)
- PLAN.md §M4 구현 완료. Foundation sandboxLifecycle §3, realtimeEvents, TRD §4.1/§7.
- **검증(③)**: 백엔드 `tsc` 클린, `vitest` 23/23 PASS(8 파일), 프론트 build PASS(77 모듈). **핵심 수용: 2개 동시 SSE 구독자가 동일 순서 이벤트 수신(message.created HUMAN→message.created AGENT_REPLY PENDING→agent.token 델타들→message.updated COMPLETE), 에이전트 출력 1회 생성·바이트 동일 fan-out**; clientId 멱등(동일 id·중복 없음); `Last-Event-ID:1` 재접속이 seq>1만 재생; 인터럽트가 부분 답변 보존(COMPLETE 부분 body)·session INTERRUPTED; HUMAN authorId=발신자(본인=우 정렬); 센티넬 키 누출 0건(스트림/응답/로그). M1–M3 회귀 무사.
- 적용된 수정: `turn.ts` 스트리밍 중 누적 body 증분 영속화(인터럽트가 부분 body 읽도록) — 이전엔 turn 종료 시 1회만 저장해 인터럽트가 빈 body로 확정하던 버그.
- 후속(비차단): ① `AgentRuntime.send`가 EmitFn→`onToken(delta)`로 조정(messageId/seq는 AR-TURN이 부여, TRD §5.1 의도 유지); ② `POST /messages`에 선택 `lang` 필드 추가(프론트가 langStore에서 전달, 비파괴) — TRD §5.5 언어 힌트; ③ 멀티바이트 본문은 curl Content-Length 아티팩트(서버 무관, --data-binary로 검증).
- 작업 패키지: BE-MSG(`POST /posts/:id/messages` HUMAN: seq 부여·clientId 멱등·RT publish·aiMode=true면 활성 세션 입력 주입), BE-MSGPAGE(`GET /posts/:id/messages?afterSeq=` keyset 50 + toolCall 요약), RT-STREAM(`GET /posts/:id/stream` afterSeq 스냅샷 재생 후 라이브 구독·heartbeat), RT-EV(message.created/message.updated/agent.token 스키마), RT-REPLAY(`Last-Event-ID`=seq 갭 재생), AR-TURN(입력 주입→AGENT_REPLY PENDING→agent.token 누적→COMPLETE/FAILED; pi 워커 턴 스트리밍 프로토콜), BE-INT(`POST /posts/:id/interrupt` steer 선택, STREAMING→부분 COMPLETE/FAILED, session=INTERRUPTED), FE-THREAD(threadStore: 버블 리스트·활성 세션·seq dedupe·낙관적 삽입), FE-BUBBLE(ChatBubble HUMAN 좌/우·AGENT_REPLY 앰버+타이핑), FE-STREAM(useThreadStream EventSource 구독+재생+dedupe), FE-COMPOSER(전송·AI on/off·clientId·인터럽트/스티어링).
- 종료 기준: 두 브라우저가 동일 에이전트 출력 P95<1.5s 확인(fan-out 1회 생성·전원 중계); 본인=우/타인·에이전트=좌; aiMode=true 전송이 턴 시작해 agent.token 스트리밍; 재접속 시 `Last-Event-ID`로 놓친 버블 재생; clientId 재요청은 동일 버블 반환; 인터럽트가 진행 턴 중단·부분 답변 보존.
- 비고: 실 LLM 미보장(키 placeholder·BASE_URL quirk) → pi 워커가 결정적 턴 스트리밍을 시뮬레이션(실 OpenAI-compatible 스트리밍 호출 seam 명시). 도구 실행 표면은 M5(AR-TOOL).
- 예상 변경 파일: `backend/src/routes/{messages,session}.ts`, `backend/src/realtime/{stream,events}.ts`, `backend/src/agent/{turn,pi,piWorker}.*`, `backend/src/domain/seq.ts`, `backend/test/**`; `frontend/src/stores/threadStore.ts`, `frontend/src/stream/useThreadStream.ts`, `frontend/src/components/{ChatBubble,Composer}.tsx`, `frontend/src/pages/Thread.tsx`.

### 2026-06-25 · [feat] · 완료 · M5 도구 실행 표면 (파일 CRUD·쉘·venv) + 터미널/툴 버블
- PLAN.md §M5 구현 완료. Foundation prismaSchema(ToolCall), realtimeEvents(tool.*), TRD §7.
- **검증(③)**: 백엔드 `tsc` 클린, `vitest` 26/26 PASS(9 파일), 프론트 build PASS(79 모듈). 라이브 E2E 20/20 PASS — 2 SSE 구독자 tool.call→tool.output→tool.result 동일 fan-out(toolCallId별); FILE_WRITE 실제 파일 `.sandboxes/<postId>/out/...` 생성(내용 verbatim); SHELL exit 0 SUCCEEDED·exit 7 FAILED(exitCode 정확); 경로 탈출 `!write ../escape` 거부(ToolCall FAILED 'path violation', 루트 밖 파일 미생성); ToolCall↔TOOL_CALL(toolCallId @unique)/TOOL_RESULT(replyToId) 1:1 연결; 센티넬 키 누출 0건(이벤트/행/버블/세션); 평문 채팅 회귀 무사.
- 설계: 워커가 입력 컨벤션(`!write`/`!read`/`!del`/`!shell`/`!demo`)으로 도구 의도 방출→toolBridge가 createToolCall→executeTool(스트리밍)→finalizeToolCall. Message.toolCallId @unique(1:1)이므로 TOOL_CALL 버블만 toolCallId 보유, TOOL_RESULT는 replyToId로 페어링(tool.output/result의 messageId=TOOL_RESULT 버블). 평문 채팅(`!` 없음)은 도구 없음.
- 후속(비차단): tool.* 라이브 이벤트는 SSE id 없음(seq 없는 sandbox.status/session.status와 동일) — 재생/멱등은 TOOL_CALL/TOOL_RESULT message.created 스냅샷(seq 보유)에 의존; E2E가 dev.db에 일부 행 남김(gitignored, 무해).
- 작업 패키지: BE-TOOL(ToolCall 영속화: kind SHELL/FILE_*/PACKAGE/OTHER·name·args·result·exitCode·status, Message TOOL_CALL/TOOL_RESULT `toolCallId` 1:1 연결), AR-TOOL(toolBridge: pi 워커가 샌드박스 cwd에서 실행한 쉘/파일/패키지 호출을 ToolCall + 버블로 매핑, pathGuard로 경로 탈출 차단), RT-TOOLEV(tool.call/tool.output/tool.result 이벤트 스키마+발행, stdout/stderr 청크 스트리밍), FE-TOOLCALL(`$ <cmd>` 프롬프트 풍 term-dim/faint), FE-TOOLRESULT(고정폭 스크롤, 성공=기본/실패=term-red, exitCode), FE-TOOLSTREAM(tool.output 청크 누적·tool.result 색/상태 확정).
- 종료 기준: 에이전트가 샌드박스 내부 파일 생성/삭제·venv·패키지·쉘 실행(모든 permission 허용); 각 호출이 TOOL_CALL 버블(`$ cmd`)로 시작→tool.output 스트리밍→TOOL_RESULT 확정(성공/실패 색·exitCode); 도구 실행이 경로 탈출 차단(BE-ISO) 강제; 모든 도구 이벤트가 동일 세션 attach 전원에 fan-out.
- 비고: pi 워커(시뮬 에이전트)가 cwd=sandbox.path에서 실제 fs/쉘 도구를 실행하고 protocol로 tool.* 이벤트 방출 → 백엔드 toolBridge가 ToolCall 행+버블+SSE 매핑. PoC 결정적 트리거로 성공/실패/경로탈출 케이스 검증.
- 예상 변경 파일: `backend/src/domain/toolCall.ts`, `backend/src/agent/{toolBridge,pi,piWorker}.*`, `backend/src/realtime/{events,stream}.ts`, `backend/src/routes/messages.ts`(toolCall 요약), `backend/test/**`; `frontend/src/components/{ToolCallBubble,ToolResultBubble}.tsx`, `frontend/src/components/ChatBubble.tsx`, `frontend/src/stores/threadStore.ts`, `frontend/src/stream/useThreadStream.ts`.

### 2026-06-25 · [feat] · 완료 · M6 워크스페이스 / 파일 트리 패널
- PLAN.md §M6 구현 완료. Foundation apiEndpoints(`/files`, `/files/content`), realtimeEvents(file.changed), TRD §7.
- **검증(③)**: 백엔드 `tsc` 클린, `vitest` 38/38 PASS(10 파일, files 12 신규), 프론트 build PASS(83 모듈). 라이브 E2E PASS — `GET /files?path=` 루트 상대 트리(dirs-first), `GET /files/content` 텍스트/바이너리(binary:true·content 없음)/대용량(truncated:true, 256KiB cap); `path=../`·절대경로 → 400 'path violation'(내용 미누출); SSE `file.changed` {path 루트상대, change CREATED/DELETED, size}; 키 누출 0건; M1–M5 회귀 무사.
- 설계: file.changed는 toolExec FILE_WRITE/DELETE 경로에서만 발행(쉘 유발 변경 미추적, PoC 범위); 파일 트리는 단일 레벨 얕은 트리(FE가 expand 시 lazy 로드); FE Chat|Files 탭 토글(모바일 sm:flex-row 분할).
- 변경 파일: `backend/src/{routes/files.ts,realtime/events.ts,agent/{toolExec,toolBridge}.ts,routes/index.ts}`, `backend/test/files.test.ts`; `frontend/src/{components/{FileTree,FileView}.tsx,stores/workspaceStore.ts,stream/useThreadStream.ts,pages/Thread.tsx,api/{rest,types}.ts,i18n/dicts/workspace.ts,i18n/index.ts}`.
- 작업 패키지: BE-FILES(`GET /posts/:id/files?path=` 디렉토리 트리, 루트 상대·BE-ISO 강제, 위반 400), BE-FILECONTENT(`GET /posts/:id/files/content?path=` 단일 파일, 바이너리 거부/메타, 대용량 truncate), RT-FILEEV(`file.changed` CREATED/MODIFIED/DELETED size? — 도구 FILE_* 실행에서 트리거), FE-FILETREE(워크스페이스 패널: term-panel, 라인 SVG 아이콘, 접기/펼치기, file.changed 라이브 갱신), FE-FILEVIEW(파일 뷰어: 고정폭 단순 표시, 대용량 안내, file.changed 갱신).
- 종료 기준: 워크스페이스 패널이 샌드박스 파일 트리 렌더(루트 상대만, `..`/symlink 거부 400); 파일 클릭 시 내용 조회(바이너리 거부, 대용량 truncate); 에이전트 파일 변경이 file.changed로 패널 라이브 갱신; 패널은 term-* 팔레트·라인 SVG만(새 색 없음).
- 비고: file.changed는 M5 toolExec의 FILE_WRITE/DELETE 경로에서 발행(쉘 유발 변경 추적은 PoC 범위 외). BE-ISO(M2 pathGuard) 공용.
- 예상 변경 파일: `backend/src/routes/files.ts`, `backend/src/realtime/events.ts`(file.changed), `backend/src/agent/toolExec.ts`(file.changed 발행), `backend/src/routes/index.ts`, `backend/test/**`; `frontend/src/components/{FileTree,FileView}.tsx`, `frontend/src/pages/Thread.tsx`, `frontend/src/stream/useThreadStream.ts`, `frontend/src/api/{rest,types}.ts`.

### 2026-06-25 · [feat] · 완료 · M7 다듬기 (레이트리밋·격리 강화·i18n·상태·지표·라이선스·테스트)
- PLAN.md §M7 구현 완료. NFR + 지표 + i18n + 라이선스. **PoC v0.1 전체(M1–M7) 완료.**
- **검증(③)**: 백엔드 `tsc` 클린; `vitest` **52/52 PASS(16 파일)**; keygate PASS(120 파일, 하드코딩 키 0); 프론트 build PASS(88 모듈). 라이브 DoD — 북마크 add/remove 멱등, `/users/:id/posts`·`/bookmarks` 커서 봉투, `/metrics` 수치 집계, `/runtime`={model,baseURLHost}(키 없음); 레이트리밋 버스트 429(정상 단건 영향 없음); 격리(파일 경로탈출 400 + 도구 wall-clock 타임아웃 kill→FAILED 'timeout'); redaction 센티넬 누출 0(로그/응답); Profile [posts|bookmarks] 2탭(communities 없음); Settings Language+로그아웃·API Key 섹션 없음·runtime read-only; LICENSE(MIT)+`docs/checklists/key-blind.md` 존재; **E2E(글→샌드박스→세션→AI 턴→도구→파일, 2-구독자 fan-out) PASS**; i18n KO/EN 7 네임스페이스 + 에이전트 언어 힌트가 Composer→sendMessage{lang}→runAgentTurn→pi 워커 LANG_HINT까지 전파.
- 작업 패키지: XC-ISO(`sandbox/limits.ts` 도구 타임아웃+프로세스 캡+NETWORK_POLICY 플래그), XC-RATE(`plugins/rateLimit.ts` 고정창 30 posts/120 msgs per min, RATE_LIMIT_DISABLED 토글), XC-REDACT(`test/security/redaction.test.ts`+`docs/checklists/key-blind.md`+`scripts/key-grep-gate.mjs`), BE-BOOKMARK/BE-USERPOSTS/BE-METRICS, FE-PROFILE/FE-SETTINGS/FE-STATES, I18N, XC-LICENSE(MIT), XC-T(`test/e2e.test.ts`).
- 후속(비차단): cgroup/메모리·CPU 쿼터·네트워크 egress 강제는 크로스플랫폼 한계로 정직하게 연기(플래그만 기록); vitest forks maxForks=2로 SSE/agent 타이밍 안정화; 레이트리밋 키가 글로벌 preHandler라 anon|ip 단위(더 엄격, DoD 충족).
- 변경 파일: `backend/src/{config,routes/{index,bookmarks,users,metrics},plugins/rateLimit,sandbox/{limits,provision},agent/{toolExec,toolBridge}}`, `backend/{scripts/key-grep-gate.mjs,vitest.config.ts,.env.example,test/{bookmark,userPosts,metrics,toolTimeout,security/redaction,e2e}.test.ts}`, `LICENSE`, `docs/checklists/key-blind.md`; `frontend/src/{pages/{Profile,Settings,Home,Thread},components/states/*,hooks/usePagedList,api/{rest,types},stream/useThreadStream,components/Composer,i18n/**}`.
- 작업 패키지: XC-ISO(리소스 제한 best-effort: 도구 타임아웃·프로세스 캡 + 네트워크 정책 플래그), XC-RATE(글/메시지 레이트리밋 + 샌드박스 동시 실행 제한[M2 limiter 계승]), XC-REDACT(키 redaction 테스트 + `docs/checklists/key-blind.md` + CI grep 게이트), BE-BOOKMARK(`POST/DELETE /posts/:id/bookmark`, `GET /users/:id/bookmarks?cursor=`), BE-USERPOSTS(`GET /users/:id/posts?cursor=`), BE-METRICS(`GET /metrics` 글당 평균 턴·고유 참여자·세션 성공률), FE-PROFILE(`/me` 탭 posts|bookmarks 무한 스크롤), FE-SETTINGS(Language+로그아웃+`GET /runtime` read-only, API Key 없음), I18N(신규 문자열 키화·에이전트 언어 힌트·서버 오류 사전), FE-STATES(빈/에러/오프라인+SSE 재접속 배너+ERROR SYSTEM 버블), XC-LICENSE(MIT LICENSE), XC-T(통합 테스트 스위트 unit/contract/integration/E2E).
- 종료 기준: 모든 PRD 수용 항목 E2E 통과; 격리(경로+리소스+네트워크 best-effort) 강제; 레이트리밋·동시 실행 제한 동작; 키 redaction green; Profile 2탭 무한 스크롤; Settings API Key 없음·Language/로그아웃; i18n KO↔EN+에이전트 언어 추종; 지표 엔드포인트; LICENSE 존재; 통합 테스트 green.
- 비고: cgroup-lite/실 메모리·CPU 제한은 크로스플랫폼 한계로 PoC 보수적 best-effort(도구 wall-clock 타임아웃+프로세스 캡); 네트워크 정책은 플래그 수준. `docs/checklists/key-blind.md`는 신규 산출 문서(허용), 변경 이력/PRD/TRD/PLAN 편집은 오케스트레이터 전담.
- 예상 변경 파일: `backend/src/plugins/rateLimit.ts`, `backend/src/sandbox/limits.ts`, `backend/src/routes/{bookmarks,users,metrics}.ts`, `backend/src/routes/index.ts`, `backend/src/agent/toolExec.ts`(타임아웃), `backend/test/{security/redaction,bookmark,metrics,e2e}.test.ts`, `docs/checklists/key-blind.md`, `LICENSE`; `frontend/src/pages/{Profile,Settings}.tsx`, `frontend/src/components/states/*`, `frontend/src/hooks/usePagedList.ts`, `frontend/src/api/{rest,types}.ts`, `frontend/src/i18n/**`.

### 2026-06-25 · [chore] · 완료 · 검증용 실행 구성 (프론트 외부/백엔드 내부 바인딩)
- 목적: 수동 검증을 위해 프론트엔드는 외부 접속(0.0.0.0), 백엔드는 내부 접속(127.0.0.1)으로 분리 실행.
- 변경: `backend/src/config.ts`에 `host`(HOST env, 기본 `0.0.0.0`) 추가 + `app.ts` listen에 `config.host` 사용; `frontend/vite.config.ts` 프록시 타깃을 env(`VITE_PROXY_TARGET`/`BACKEND_URL`, 기본 `http://localhost:3001`)로 구성; vite config의 `process` 사용 위해 `@types/node` devDep 추가.
- 실행: 백엔드 `HOST=127.0.0.1 PORT=3011`(3001은 무관 앱 점유), 프론트 `vite --host 0.0.0.0 --port 5173` + `VITE_PROXY_TARGET=http://127.0.0.1:3011`. 외부 클라는 프론트 프록시 경유로만 백엔드 도달.
- 검증: 백엔드 `tsc` 클린; 프론트 `build` PASS; 백엔드 `127.0.0.1:3011/health`=ok·외부 IP에서 미도달(내부 전용 확인); 프론트 외부 IP `:5173` HTTP 200; 프록시 경유 게스트→글 작성→피드(20)→`/runtime`(키 없음) E2E PASS.
- 변경 파일: `backend/src/config.ts`, `backend/src/app.ts`, `frontend/vite.config.ts`, `frontend/package.json`(+package-lock), `frontend/tsconfig.node.json`(변경 없음).

### 2026-06-25 · [fix] · 완료 · 게스트 로그인 계약 불일치(nickname) 수정
- 증상: 외부 검증 중 게스트 진입 실패 — 프론트 `rest.guest`가 `{username}`을 보내지만 백엔드 `/auth/guest`는 `{nickname}`을 요구(`"nickname is required"`). 백엔드 단위 테스트는 자기 계약(nickname)으로 통과해 누락됨.
- 수정: 프론트 `rest.guest`가 TRD §4(닉네임) + 백엔드 계약에 맞춰 `{ nickname }` 전송.
- 검증: 프론트 build + 프록시 경유 게스트→글 작성 E2E 재확인.
- 변경 파일: `frontend/src/api/rest.ts`.

### 2026-06-25 · [fix] · 완료 · Vite 프록시가 SPA 라우트(/posts/:id) 가로채 JSON 노출
- 증상: 스레드 URL 직접 로드/새로고침 시 React 앱 대신 백엔드 `GET /posts/:id` 원시 JSON이 떠 까만 화면처럼 보임(인앱 네비게이션은 정상). 원인: vite proxy의 `/posts`·`/users` prefix가 SPA 클라이언트 라우트 `/posts/:id`와 충돌 — 문서 네비게이션(Accept: text/html)까지 백엔드로 포워딩.
- 수정: `frontend/vite.config.ts` 각 프록시 엔트리에 `bypass` 추가 — `Accept: text/html` 문서 네비게이션이면 `/index.html`(SPA) 서빙, fetch/EventSource(API)만 프록시. SSE(text/event-stream)·feed·getPost fetch는 영향 없음.
- 검증: Chrome MCP로 스레드 URL 직접 로드 → SPA 렌더 확인 + 전체 동작(글 작성→세션→메시지→도구→파일) 테스트.
- 변경 파일: `frontend/vite.config.ts`.

### 2026-06-25 · [fix] · 완료 · getPost 봉투 언래핑 누락 → 스레드 postId undefined / 본문 빈칸
- 증상: 스레드에서 메시지 전송이 `POST /posts/undefined/messages`(404)로 감 + 원본 게시글 제목/본문이 빈칸. 원인: `GET /posts/:id`는 봉투 `{post, sandbox, voted, bookmarked, activeSession}`를 반환하는데 `rest.getPost`가 이를 `Post`로 잘못 단언 → Thread가 `post.id`/`post.title`/`post.body`를 envelope 최상위에서 읽어 undefined. (`<Composer postId={post.id}>`가 undefined 전달)
- 수정: `rest.getPost`가 봉투를 언래핑해 `{...env.post, sandbox, session: env.activeSession, voted, bookmarked}` 병합 Post 반환. 같은 클래스 버그로 `rest.getFiles`도 `{path, entries}` 봉투에서 `.entries` 언래핑(이전엔 객체를 배열로 취급해 파일 트리 빈칸).
- 검증: Chrome MCP 전체 동작 — 세션 시작→메시지 전송→도구(!write) 실행(실 파일 생성)→TOOL_CALL/TOOL_RESULT 버블→파일 패널에 hello.py 표시.
- 변경 파일: `frontend/src/api/rest.ts`.

### 2026-06-25 · [feat] · 완료 · 글 삭제 시 샌드박스 폴더까지 정리 (DELETE /posts/:id)
- **검증(③)**: 백엔드 `tsc` 클린 + `vitest` 55/55(deletePost 3 신규: 비작성자 403·작성자 200 전 행+디렉토리 삭제·루트 밖 경로 거부); 프론트 build PASS. Chrome MCP 실제 동작 — 작성자 전용 삭제 버튼→인라인 확인→삭제 후 홈 이동; `.sandboxes/<postId>` 디렉토리 디스크에서 제거 확인, `GET /posts/:id`=404, 피드에서 사라짐.
- 요청: 글을 삭제하면 해당 게시글의 샌드박스 디렉토리도 함께 삭제. (sandboxLifecycle §6.1 step7 cleanup 구현)
- 구현: `DELETE /posts/:id`(requireAuth, 작성자만 403) — ① 활성 AgentSession 있으면 runtime.suspend로 프로세스 종료, ② 트랜잭션으로 FK 안전 순서 삭제(message.replyToId null 처리→message→toolCall→agentSession→vote/bookmark→sandbox→post), ③ 샌드박스 디렉토리 `rm -rf`(pathGuard isInsideRoot로 sandboxRoot 내부 확인 후에만 삭제 — 루트 밖 경로 거부), ④ sandbox.status SSE 불필요(글 자체 삭제). 프론트: Thread에 작성자 전용 삭제 버튼(term-red, 확인) → 삭제 후 홈 이동.
- 종료 기준: 작성자가 글 삭제 시 200 + DB 행 전부 제거 + `.sandboxes/<postId>` 디렉토리 삭제; 비작성자 403; 활성 프로세스 종료; 루트 밖 경로는 절대 삭제하지 않음.
- 예상 변경 파일: `backend/src/routes/posts.ts`(DELETE 라우트), `backend/src/sandbox/service.ts`(deleteSandboxDir 헬퍼), `backend/test/deletePost.test.ts`; `frontend/src/api/rest.ts`(deletePost), `frontend/src/pages/Thread.tsx`(삭제 버튼), `frontend/src/i18n/dicts/thread.ts`.

<!-- 새 항목은 이 줄 위에 추가 -->
