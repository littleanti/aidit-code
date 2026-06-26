# Aidit-Code — Wireframe & Interaction Spec (+ Design System)

> Companion to [PRD.md](./PRD.md) & [TRD.md](./TRD.md). Mobile-first (360–430px). ASCII low-fi wireframes.
> 범례: `[버튼]` `(입력)` `‹좌버블›` `›우버블‹` `$명령버블$` `▒출력버블▒` `⟳로딩`
> **Status: PoC · Version 0.1 · 2026-06-25**

```
╔══════════════════════════════════════════════════════════════════════╗
║ Δ from Aidit — 부모 대비 무엇이 바뀌었는가 (이 문서의 단일 출처)          ║
╠══════════════════════════════════════════════════════════════════════╣
║ • 백엔드 = 코드 에이전트 호스트. 채팅방 = 샌드박스에서 도는 pi agent     ║
║   세션. 여러 사람이 같은 세션에 attach(fan-out).                        ║
║ • 커뮤니티/페르소나 전면 제거. 홈 = 게시글 피드. 화면에서 Search/        ║
║   Community 상세/CreateCommunity/페르소나 편집 삭제.                     ║
║ • BYOK 전면 폐기. LLM 키(apikey/baseURL)는 서버 .env에만. 클라 미노출.  ║
║   → Login의 API Key 필드 삭제, Settings의 API Key 섹션 삭제,            ║
║     Header의 GEMINI 연결 배지 삭제.                                     ║
║ • 게시글 생성 → 샌드박스 1:1 자동 생성. Thread는 채팅 버블 + 도구호출/    ║
║   터미널 출력 버블 + (선택)워크스페이스/파일 트리 패널 + AI on/off       ║
║   Composer + 에이전트/샌드박스 상태 배지.                               ║
║ • 클라 128K 요약 엔진(contextEngine.ts) 폐기 → 컨텍스트는 pi agent 책임. ║
║   서버는 메시지/이벤트 SoT(seq 순서) + SSE 릴레이만. §7 자동요약 절 삭제.║
║ • 디자인 시스템(그린 인광 CRT term-*)은 100% 계승. 새 색 도입 금지 —     ║
║   신규 컴포넌트(도구호출/터미널출력 버블, 파일트리 패널, 상태 배지,       ║
║   스트리밍 인디케이터)는 기존 term-* 팔레트만 사용(§12에 통합).          ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## 0. 화면 인벤토리 & 내비게이션

```
Login(모달) ─▶ Home ──┬──▶ Thread (게시글 직접 진입 = 에이전트 세션 attach)
                      └──▶ CreatePost ──▶ Thread (게시 후, 샌드박스 자동 생성)

하단 탭바(모바일):  [🏠 홈]  [＋ 작성]  [👤 나]
상단바 우측:  [ {username} ] ─▶ /me (나)  ·  [ KO | EN ]  ·  비로그인 시 [ Login ] ─▶ 로그인 모달
```
> **i18n 언어 토글** — 상단바 우측에 `[ KO | EN ]` 세그먼트 컨트롤(`LangToggle variant="header"`). 활성 언어는 `text-term-amber`, 비활성은 `text-term-dim hover:text-term-bright`(터미널 앰버 브래킷 미감). 선택은 `langStore`(zustand persist, `localStorage` 키 `'aidit-lang'`)에 저장되며, 명시적 선택이 브라우저 기본값을 항상 덮어쓴다. 언어 변경 시 에이전트 답변도 가능 범위에서 선택된 언어로 출력된다(UGC·터미널 명령은 번역하지 않음). 모바일에서는 레이블 없이 `KO`/`EN` 두 글자만 표시한다.

> **상단바 username 진입점** — 로그인 상태에서 상단바 우측의 `[ {username} ]`은 **`/me`(나) 페이지로 이동하는 링크**다(`hover:text-term-bright`). 비로그인 시에는 같은 자리에 `[ Login ]`(`openLogin()`)이 표시된다.

> **Δ Header — GEMINI 연결 배지 삭제.** 부모는 `[ {username} ]` 좌측에 BYOK Gemini 호출 결과를 반영하는 LED 배지(`GeminiStatusBadge`)를 두었으나, BYOK가 폐기되어(서버 .env 키) **헤더에는 어떤 LLM 상태 표식도 두지 않는다.** 에이전트/샌드박스 상태는 **Thread 내부 상태 인디케이터**(§6)에서만 노출한다.

> **동선** — '작성' 탭(＋)은 글 작성(`/create-post`)으로 직결한다. 게시 시 Post 등록 + Sandbox 1:1 자동 생성 → Thread로 이동. **커뮤니티 만들기/검색 진입점은 존재하지 않는다(전면 삭제).** 데스크톱 사이드바 순서는 **홈 / 작성 / 나**. **로그인은 별도 페이지가 아니라 모달 오버레이**(§1)로 어디서든 열린다(`/login` 직접 접근/딥링크는 호환 유지).

---

## 1. Login (= username + password, 게스트) — **모달 오버레이**

> 로그인은 **별도 페이지가 아니라 앱 위에 뜨는 모달 오버레이**다. 헤더의
> `[ Login ]`(`text-term-amber`)이나 쓰기 게이트에서 `openLogin()`으로 열리며, 폼 본체는
> `LoginForm`(2탭: 로그인/회원가입 + 게스트 + 제출 로직)으로 추출되어 모달·페이지 양쪽에서 공유된다.
> 오버레이: `fixed inset-0 z-[60]` + 딤 `bg-[rgba(2,8,5,0.82)]`, 중앙 카드
> `border border-term-active bg-term-modal rounded-[3px] shadow-[0_0_32px_rgba(43,212,111,0.28)]`,
> 우상단 `[x]`(닫기), A-mark + `AIDIT`(glow-lg) + 부제. **배경/[x] 클릭으로 닫힘**(카드 클릭은 전파 차단),
> 제출 성공 시 닫힘. `/login` 라우트는 유지되어 페이지 셸에서 동일 `LoginForm`을 렌더(딥링크 호환,
> 성공 시 `/`로 이동). 상태는 `uiStore`(`loginOpen/openLogin/closeLogin`)가 보유.
> **실인증(JWT) 폼**: `LoginForm`은 `username` + `password`(+ 회원가입 모드는 **`비밀번호 확인`** 추가)
> 입력. 회원가입은 두 비밀번호가 **일치해야** 제출(불일치 시 인라인 빨간 힌트 `aria-invalid` + 가입 차단),
> 비밀번호 8자 이상. **게스트**는 닉네임만 입력(≤16자·`#` 금지) → 서버가 `#hex4` 부여. **세션 만료/무효 시**
> (시크릿 교체·이전 세션) 인증 요청 401이면 자동으로 세션 정리 + 이 모달이 다시 열린다 — "로그인된 듯
> 보이나 쓰기가 401"인 좀비 상태 방지.

```
┌──── 모달 오버레이 (딤 배경 위) ───┐
│         [x]                │
│         ⚡ AIDIT-CODE        │
│   샌드박스에서 함께 코딩하는    │
│         에이전트 플랫폼         │
│                            │
│  [ 로그인 ] [ 회원가입 ]       │ ← 2탭 세그먼트(활성=term-amber)
│ ──────────────────────────  │
│  사용자 이름                  │
│ (  e.g. yoon              ) │
│  비밀번호                     │
│ ( ••••••••••              ) │
│  (회원가입 시) 비밀번호 확인     │
│ ( ••••••••••              ) │
│                            │
│        [   시작하기   ]       │
│ ──────────────────────────  │
│  또는 닉네임만으로 게스트 진입   │
│ (  닉네임  ) [ 게스트로 시작 ] │ ← 서버가 닉네임#a3f9 부여
└────────────────────────────┘
```
- **Δ API 키 입력 필드 삭제.** 부모의 "Google AI Studio API Key" 입력·`localStorage` 저장·`countTokens`
  유효성 확인·키 발급 링크·"키는 이 기기에만 저장" 경고는 **전부 제거**한다. LLM 키는 서버 `.env`가 관리한다.
- 검증: 로그인/회원가입은 username+password 입력 시 활성, 회원가입은 두 비밀번호 일치 필요. 게스트는 닉네임만.
- 저장: 서버가 발급한 JWT 토큰(`POST /auth/session` · `/auth/register` · `/auth/guest`). 클라는 토큰만 보관.
- 미로그인도 홈/스레드/파일 **열람**은 가능 → 쓰기/세션 시작 시점에 **로그인 모달**로 유도. 글 작성 게이트는
  하드 리다이렉트 대신 **"로그인이 필요해요" 안내 + `[ 로그인 ]` 버튼(`openLogin()`)** 으로 그 자리에서 모달을 띄운다.

---

## 2. Home (게시글 피드)

> **Δ 커뮤니티 개념 없음.** 부모의 우측 "커뮤니티 검색 패널"·`r/...` 라벨·페르소나 배지를 전면 삭제한다.
> 홈은 **게시글 피드 단일 컬럼**(인기/최신)이며, 각 카드에 **샌드박스 상태 요약 배지**를 표시한다.

**모바일**
```
┌────────────────────────────┐
│ ⚡ AIDIT-CODE        (👤)   │  ← 탭: 인기 | 최신
│ aidit@yoon:~$ feed --sort=popular ▌
│ ──────────────────────────  │
│ ┌────────────────────────┐ │
│ │ ● RUNNING               │ │  ← 샌드박스 상태 배지(활성=term-amber)
│ │ FastAPI 헬스체크 엔드포인트  │ │  ← 제목
│ │ ▲ 128  💬 24  · 2h      │ │  ← score / 버블수 / 시간
│ └────────────────────────┘ │
│ ┌────────────────────────┐ │
│ │ ○ READY                 │ │  ← 유휴=term-dim
│ │ 모노레포 빌드 캐시 깨짐 해결  │ │
│ │ ▲ 96   💬 41  · 5h      │ │
│ └────────────────────────┘ │
│ ┌────────────────────────┐ │
│ │ ✗ ERROR                 │ │  ← 실패=term-red
│ │ venv 패키지 충돌 디버깅     │ │
│ │ ▲ 12   💬 5   · 1d      │ │
│ └────────────────────────┘ │
│  ⋯ (무한 스크롤, 커서)        │
└────────────────────────────┘
  [🏠]        [＋]        [👤]
```

**데스크톱 (≥1024px)** — 단일 중앙 피드 (우측 검색 패널 없음)
```
┌──────────┬───────────────────────────────┐
│ 좌 내비    │  [인기] [최신]                  │
│ 🏠 홈     │  aidit@yoon:~$ feed --sort=popular ▌
│ ＋ 작성    │  ┌─ PostCard (상태배지 포함) ─┐  │
│ 👤 나     │  │ ● RUNNING / 제목 / ▲💬 ·t │  │
│          │  └───────────────────────────┘  │
│          │  ┌─ PostCard ─┐ ...             │
└──────────┴───────────────────────────────┘
```
- **FR-1.1** 인기 정렬(hotScore, `GET /posts?sort=hot`). **FR-1.2** 최신 정렬(`sort=new`). **FR-1.3** 열람은 비로그인 허용.
- **샌드박스 상태 요약**: 각 카드는 `GET /posts`가 포함한 `sandbox.status`를 §12의 상태 배지 규칙으로 렌더한다
  (RUNNING=term-amber, READY/SUSPENDED=term-dim, ERROR=term-red, CREATING=term-dim + `⟳`).

---

## 3. CreatePost (글 작성 → 샌드박스 자동 생성)

> **Δ 커뮤니티 피커·페르소나·이미지 첨부 삭제.** 부모의 커뮤니티 선택 필드/펼침 패널/빈상태 보조 링크,
> "게시 후 AI 1차 답변 받기" 토글, AI 답변 길이 세그먼트는 **전부 제거**한다. 글은 **제목 + 본문(작업 지시)**
> 만 받으며, 게시 즉시 백엔드가 **샌드박스 1개를 1:1로 자동 생성**한다.

```
┌──────────────────────────────────┐
│ ‹ 글 작성                          │
│ aidit@yoon:~$ post --new ▌         │  ← ShellPrompt(라이브: 제목 반영)
│ 제목 ( FastAPI 헬스체크 만들어줘 )    │
│ ┌──────────────────────────────┐ │
│ │ 본문 / 작업 지시…               │ │  ← 에이전트 첫 발화의 시드로 사용 가능
│ │ /health 라우트 + pytest 추가…   │ │
│ └──────────────────────────────┘ │
│                                  │
│  ! 게시하면 이 글 전용 샌드박스가     │  ← term-dim 안내(신규)
│    자동 생성되고 코드 에이전트가      │
│    붙습니다.                       │
│                                  │
│        [   게시하기   ]            │
└──────────────────────────────────┘
```
- **비로그인 게이트**: 하드 리다이렉트 없이 "로그인이 필요해요" 안내 + `[ 로그인 ]`(`openLogin()`)로 모달 유도(§1).
- **라이브 ShellPrompt**: 제목이 비어 있으면 `post --new`(기본), 제목이 있으면 `post --new "<title>"`. 본문은 절대 노출하지 않음(§12 Live-Prompt).

**게시 인터랙션 (샌드박스 라이프사이클 1단계)**
```
[게시] → ① POST /posts (title, body)
       → ② 서버: Post 등록 + Sandbox 1:1 생성(status=CREATING) → { post, sandbox } 반환
       → ③ Thread로 즉시 이동 (상단 배지 ⟳ CREATING…)
       → ④ 폴더/런타임(pi) 준비 끝 → sandbox.status SSE = READY (배지 ○ READY)
            실패 시 ERROR(✗). 동시 생성 수 초과 시 큐잉 또는 429.
```

---

## 6. Thread (★ 핵심: 원본 글 + 에이전트 세션 채팅)

> **Δ 채팅방 = 샌드박스에서 도는 pi agent 세션.** 부모의 "각자 BYOK로 도는 @AI"가 아니라, Thread를 열면 그 방은
> **백엔드 샌드박스에서 도는 단일 pi agent 세션**이며 모든 참여자가 같은 세션에 attach(fan-out)한다. 에이전트 출력은
> 한 번 생성되어 전원에게 동일하게 중계된다. 사람/에이전트 텍스트 버블에 더해 **도구 호출 버블**·**터미널 출력 버블**·
> (선택)**워크스페이스/파일 트리 패널**·**에이전트/샌드박스 상태 인디케이터**가 추가된다.

```
┌────────────────────────────┐
│ ‹  FastAPI 헬스체크 만들어줘  🔖 ⋯│  ← 글 상세 헤더(뒤로·제목 중앙·북마크·메뉴)
│  [ ● RUNNING · pi · 2명 ]    │  ← 에이전트/샌드박스 상태 인디케이터(배지)
│ ┌──────────────────────────┐ │
│ │ 📌 원본 게시글             │ │  ← 음각 라벨(term-faint)
│ │ FastAPI 헬스체크 만들어줘    │ │  ← 제목(term-fg-bright)
│ │ (👤) yoon · 1시간 전 ♡12 💬8│ │  ← 아바타+작성자·시간 / 좋아요·버블수
│ └──────────────────────────┘ │
│ ──────── 세션 ────────        │  ← 평범한 인플로우 구분선
│                            │
│ (🟢)minji                  │  ← 타인 = 좌, 아바타 좌측
│  └‹ /health 도 추가해줘       │     패널 버블, 꼬리 좌하
│    1시간 전                  │
│                            │
│        나 ▶ pytest도 붙여줘 ›┐(👩)│  ← 본인 = 우, CTA 그라디언트, 읽음 ✓
│              1시간 전 ✓     │
│                            │
│ (⚡)pi agent [AGENT]         │  ← 에이전트 = 좌, 앰버 틴트 + [AGENT] 라벨
│  └‹ main.py 에 라우트를 추가… │     (스트리밍 중 ▌ 커서)
│                            │
│ ▌$ write_file main.py        │  ← TOOL_CALL 버블($ <cmd> 풍, term-dim)
│ ┌──────────────────────────┐ │
│ │ + @app.get("/health")     │ │  ← TOOL_RESULT 버블(고정폭, 스크롤)
│ │ + def health(): ...       │ │     성공=기본색 / 실패=term-red
│ │ [exit 0]                  │ │
│ └──────────────────────────┘ │
│ ▌$ bash: pytest -q           │  ← 도구 호출(쉘)
│ ┌──────────────────────────┐ │
│ │ 1 passed in 0.04s         │ │  ← 터미널 출력 누적(tool.output)
│ │ [exit 0]            ✓      │ │
│ └──────────────────────────┘ │
│ (⚡)pi agent ✦ 작성 중… •••   │  ← 스트리밍/타이핑 인디케이터
│ ──────────────────────────  │
│ (＋)( 메시지를 입력하세요…)[🤖⌄](↑)│  ← Composer: AI on/off 칩 + 전송
└────────────────────────────┘
```

> **워크스페이스/파일 트리 패널 (선택, ≥768px 권장)** — 데스크톱에서는 채팅 우측(또는 상단 토글 시트)으로
> 샌드박스 파일 트리 패널을 띄울 수 있다. `GET /posts/:id/files?path=` 로 트리를, `GET /posts/:id/files/content?path=`
> 로 단일 파일 내용을 가져온다. `file.changed` SSE 이벤트(CREATED/MODIFIED/DELETED)로 실시간 갱신. 모바일에서는
> 헤더의 파일 아이콘 토글로 전체화면 시트.
> ```
> ┌── 워크스페이스 ──┐
> │ ▸ src/          │  ← term-panel, 라인 SVG 아이콘
> │   • main.py  M  │  ← M=MODIFIED(term-amber 점)
> │   • test_app.py +│  ← +=CREATED
> │ ▸ venv/         │
> │ • requirements  │
> └─────────────────┘
> ```

> **스크롤 점프 — 우측 하단 방향식 단일 점프 칩.** 부모 패턴 계승. 스크롤 영역 우측 하단에 사각 칩 하나를 띄우되
> **스크롤 방향**을 따른다 — 내리면 `↓`(맨 아래로), 올리면 `↑`(맨 위로). 슬롯에는 항상 한 개만. 상태는 단일
> `activeChip`(`'none'|'top'|'bottom'`), `scrollTop` 변화량 `dY` 부호로 방향 판정(deadzone 2px). 스크롤 멈추면
> 1초 후 페이드아웃. 칩 `bg-term-card/85 backdrop-blur`, hover `shadow-glow-soft`. `prefers-reduced-motion`이면
> smooth→auto. aria-label `thread.jumpTopAria` / `thread.jumpBottomAria`(KO/EN).

### 6.1 버블 타입별 스타일

> 부모의 본인/타인/AI 버블을 계승하고, **도구 호출·터미널 출력·시스템 버블을 신규 추가**한다. 색은 §12(디자인 시스템)
> 의 term-* 표만 사용 — 새 색 도입 없음. `MessageType` = `HUMAN | AGENT_REPLY | TOOL_CALL | TOOL_RESULT | SYSTEM`.

| 타입 (MessageType) | 위치 | 아바타 | 색/표시 |
|------|------|--------|---------|
| **HUMAN (본인)** | 우측 | 우측(본인) | **CTA 그라디언트 채움**(`bg-term-cta`/`border-term-active`), 꼬리 우하, 메타에 **읽음 ✓** |
| **HUMAN (타인)** | 좌측 | 좌측(시드색) | 패널(`bg-term-panel`/`border-term-border`), 상단 작성자명(`term-dim`), 꼬리 좌하 |
| **AGENT_REPLY** | 좌측 | 좌측(⚡ pi 마크) | 앰버 틴트(`rgba(60,48,10,0.22)` 보더 `term-amber-line`) + `pi agent` + `[AGENT]` 라벨(`term-amber`) |
| **TOOL_CALL** | 좌측(전폭) | 없음 | **`$ <cmd>` 프롬프트 풍**, `term-dim`/`term-faint`, 좌측 `▌` 프롬프트 마크. 도구 이름·인자 요약 |
| **TOOL_RESULT** | 좌측(전폭) | 없음 | **고정폭 출력 + 스크롤 컨테이너**(`overflow-x:auto`). 성공=기본색·`[exit 0]`/`✓`, 실패=`term-red`·`[exit N]` |
| **SYSTEM** | 중앙(전폭 띠) | 없음 | `term-dim-3` 미세 텍스트(세션 상태/오류 안내). 예: `— 세션 일시중단됨 (SUSPENDED) —` |
| 로딩(사람) | 해당 위치 | 해당 | `⟳ 입력 중…` 점 애니메이션 |
| 스트리밍(에이전트) | 좌측 | ⚡ | **`✦ 작성 중… •••`**(스파클 + 점) 또는 누적 본문 끝 `▌` 커서 |
| 실패 | 해당 위치 | 해당 | `term-red` 테두리(`border-term-red-line`/`bg-term-red-bg`) + `↻ 재시도`/`[exit N]` |

> 버블 최대폭 78%, 아바타 `h-8 w-8`(32px) 원형, 버블과 `gap-2`. 본인 행은 `flex-row-reverse`. **도구 호출/터미널 출력/시스템
> 버블은 아바타 없이 전폭**(좌측 정렬)으로 렌더해 채팅 흐름 속 "기계 출력"임을 시각적으로 구분한다.

### 6.2 Thread 인터랙션 타임라인 (사람 메시지 → 에이전트 스트리밍 → 도구 → 파일변경, SSE fan-out)

> 부모의 "@AI 타임라인 + 128K 요약 분기"를 **에이전트 세션 타임라인**으로 교체한다. 컨텍스트/요약은 pi agent 런타임이
> 자체 관리하므로 클라/서버 요약 분기는 없다. `seq`가 모든 버블의 정렬·재생 단일 출처(SoT). 모든 이벤트는 동일 세션에
> attach한 **전원에게 동일 중계**된다.

```
세션 attach (Thread 진입 시)
 a0  POST /posts/:id/session
       → READY/SUSPENDED면 pi agent spawn(.env apikey/baseURL/model 주입, 키 미노출)
       → AgentSession(STARTING→IDLE), sandbox.status=RUNNING
       → 이미 활성이면 기존 세션에 attach(새 프로세스 안 띄움)
 a1  GET /posts/:id/stream (SSE 구독)
       → afterSeq 스냅샷 재생 후 라이브. Last-Event-ID(=seq)로 재연결 재생.

사람이 메시지 전송 (aiMode=ON)
 t0  POST /posts/:id/messages { body, aiMode:true, clientId }
       → 서버가 seq 부여 → SSE message.created(HUMAN) 전원 중계 (내 버블 우측 즉시)
 t1  세션에 입력 주입 → session.status=RUNNING
       → SSE message.created(AGENT_REPLY/PENDING) 좌측 placeholder 등록
 t2  agent.token { messageId, seq, delta }* (스트리밍)
       → 해당 AGENT_REPLY body에 delta 누적(타이핑 효과, 끝에 ▌ 커서)
 t3  에이전트가 도구 호출 → tool.call { toolCallId, kind, name, args, RUNNING }
       → SSE message.created(TOOL_CALL) → `$ <cmd>` 버블
 t4  tool.output { toolCallId, chunk }*
       → SSE message.created(TOOL_RESULT) 누적(고정폭 스크롤 컨테이너)
 t5  tool.result { toolCallId, SUCCEEDED|FAILED, exitCode, result }
       → TOOL_RESULT 버블 확정(성공=기본 / 실패=term-red, [exit N])
 t6  file.changed { path, CREATED|MODIFIED|DELETED, size? }
       → 워크스페이스/파일 트리 패널 갱신(path는 샌드박스 루트 상대)
 t7  message.updated { id, body, status:COMPLETE }
       → AGENT_REPLY STREAMING→COMPLETE, session.status=IDLE

인터럽트 / 스티어링
 i0  POST /posts/:id/interrupt { steer? }
       → session.status=INTERRUPTED, 진행 중 STREAMING 메시지 COMPLETE(부분)/FAILED 확정
       → SSE message.updated + session.status 전원 통지

유휴 → 일시중단
 s0  POST /posts/:id/session/suspend (또는 유휴 타이머)
       → pi agent 프로세스 내림, sandbox.status=SUSPENDED(디렉토리 보존)
       → SYSTEM 버블 "— 세션 일시중단됨 —", 다음 attach 시 resume
```

> **AI on/off**: `aiMode=false`로 보낸 사람 메시지는 단순 채팅(HUMAN 버블)만 등록하고 에이전트 턴을 시작하지 않는다.
> 여러 사람이 AI off로 대화하다 누군가 AI on으로 보내면 그 입력이 세션에 주입되어 에이전트가 응답한다(전원 fan-out).

---

## 8. 빈/에러/로딩 상태

> 부모의 "키 무효/쿼터 초과" 문구는 BYOK 폐기로 삭제하고, **서버측 세션/샌드박스 오류 문구**로 의미 교체한다.

```
빈 홈:      "아직 게시글이 없어요. [＋ 첫 글 쓰기]"
빈 스레드:   원본만 + "첫 메시지를 보내거나 AI를 켜고 작업을 지시해보세요"
샌드박스 준비:  상단 배지 ⟳ CREATING… (게시 직후, 에이전트 부착 전)
세션 시작 실패: SYSTEM 버블 "‹ 세션을 시작하지 못했어요 — 잠시 후 재시도  [재시도]›"
에이전트 오류:  SYSTEM 버블 "‹ 에이전트 런타임 오류 (ERROR)›" + 샌드박스 배지 ✗ ERROR
도구 실패:    TOOL_RESULT 버블 term-red + `[exit N]` (세션은 유지)
오프라인:    상단 띠 "오프라인 — 재연결 중…", SSE Last-Event-ID(=seq) 재생
```

> **Δ §7 자동 요약(128K) 절 삭제.** 부모의 클라이언트 128K 요약 엔진·세그먼트 경계·요약 버블·"곧 대화가 요약됩니다"
> 배지는 **존재하지 않는다.** 컨텍스트·히스토리·요약은 pi agent 런타임의 책임이며, 서버는 메시지/이벤트의 SoT(seq 순서)와
> SSE 릴레이만 담당한다.

---

## 9. 프로필 (/me) — 탭형 활동 피드 + 설정 진입점

> **Δ communities 탭 제거.** 부모의 `[ communities | posts | bookmarks ]` 3탭에서 communities 탭을 삭제해
> **`[ posts | bookmarks ]` 2탭**으로 둔다. 나머지(무한 스크롤·sentinel·opaque nextCursor·로딩/EOF·ShellPrompt)는
> Home 피드 패턴과 동일하게 계승.

```
┌────────────────────────────┐
│ aidit@yoon:~$ whoami        │  ← ShellPrompt 헤더 (term-dim)
│ > yoon                     │  ← 로그인 사용자명 (term-amber)
│                    [ ⚙ ]   │  ← 우상단 설정 진입점 → /me/settings
│ ──────────────────────────  │
│ [ posts ][ bookmarks ]      │  ← 세그먼트 탭 컨트롤(communities 삭제)
│   ^^(활성=term-amber 밑줄)    │     비활성=term-dim, hover=term-bright
│ ──────────────────────────  │
│  (활성 탭 콘텐츠 — 아래 참조)   │
└────────────────────────────┘
  [🏠]        [＋]        [👤]
```

### 탭 1 — posts
```
│ [ posts ][ bookmarks ]      │
│ ──────────────────────────  │
│ aidit@yoon:~$ ls ~/posts    │
│                            │
│ ┌────────────────────────┐ │
│ │ ● RUNNING · 2h          │ │  ← PostCard (Home 피드와 동일, 상태배지 포함)
│ │ FastAPI 헬스체크 만들어줘   │ │
│ │ ▲ 128  💬 24            │ │
│ └────────────────────────┘ │
│          ⟳ 로딩 중…         │  ← sentinel(IntersectionObserver)
│  ─────── EOF ───────        │
│  (빈상태: "작성한 글이 없어요") │
```

### 탭 2 — bookmarks
```
│ [ posts ][ bookmarks ]      │
│ ──────────────────────────  │
│ aidit@yoon:~$ ls ~/bookmarks│
│                            │
│ ┌────────────────────────┐ │
│ │ ○ READY                 │ │  ← PostCard (북마크 시각순)
│ │ 모노레포 빌드 캐시 깨짐 해결  │ │
│ │ ▲ 96   💬 41            │ │
│ └────────────────────────┘ │
│          ⟳ 로딩 중…         │
│  ─────── EOF ───────        │
│  (빈상태: "북마크한 글이 없어요") │
```

### 인터랙션 규칙
- **탭 전환**: 클릭 즉시 활성 탭 변경. 처음 진입 시 1페이지만 fetch(지연 로드). 이미 로드된 탭은 캐시 유지.
- **무한 스크롤**: `usePagedList` 훅(`items`, `cursor`, `loading`, `done`, `error`, `sentinelRef`, `loadMore`). 두 탭 모두 사용.
- **커서 페이지네이션**: `GET /users/:id/posts?cursor=`, `GET /users/:id/bookmarks?cursor=` — 각각 `{ items, nextCursor }`. `nextCursor`가 `null`이면 EOF.
  - posts: `post.createdAt desc, post.id desc`; cursor = post.createdAt(ms) + post.id.
  - bookmarks: **bookmark 행 기준** `bookmark.createdAt desc, bookmark.id desc`; cursor = bookmark.createdAt(ms) + bookmark.id (post.createdAt 아님).
- **설정 진입점**: 헤더 우상단 `[ ⚙ ]`(`text-term-dim hover:text-term-bright`, 터치 타깃 ≥44px) → `/me/settings`.
- **비로그인**: 탭 렌더 없이 `EmptyState`("로그인이 필요해요 / [로그인]`openLogin()`").

---

## 9.1 설정 (/me/settings)

> **Δ API Key 섹션 삭제.** 부모의 "Google AI Studio 키 마스킹·변경·로컬 저장 경고"는 BYOK 폐기로 **전면 삭제**한다.
> 대신 (선택) **현재 모델/런타임 read-only 표시**(`GET /runtime`, 키는 절대 미포함)를 둔다. Language + 로그아웃은 계승.
> 라우트: `/me/settings`(`AppLayout` 그룹). 소스: `src/pages/Settings.tsx`.

```
┌──────────────────────────────────────┐
│ ‹ /me                          settings│  ← 헤더: 좌=[ ‹ /me ] 뒤로, 우=워드마크
│ aidit@yoon:~$ cat ~/.config            │  ← ShellPrompt (term-dim)
│ ────────────────────────────────────── │
│ ── Runtime (read-only) ──              │  ← (선택, 신규) GET /runtime
│ 모델   : openai/gpt-4o-mini            │  ← MODEL
│ baseURL: models.github.ai              │  ← 호스트만 표시(키 절대 미포함)
│ ⚠ LLM 키는 서버에서 관리됩니다          │  ← term-dim 안내
│                                        │
│ ── Language ──                         │
│ 언어 / Language                        │
│ [ KO | EN ]                            │  ← LangToggle variant="setting" (term-amber 활성)
│                                        │
│ ── 계정 ──                             │
│ [로그아웃]                             │  ← term-red border, 클릭 → 토큰 삭제 → /login
└──────────────────────────────────────┘
  [🏠]        [＋]        [👤]
```

### 동작 규칙
- **뒤로 링크** `[ ‹ /me ]`: `navigate('/me')`(또는 `navigate(-1)`). `text-term-dim hover:text-term-bright`, 터치 타깃 ≥44px.
- **Runtime 섹션(선택)**: `GET /runtime`의 `model`·`baseURL 호스트`만 read-only로 표시. **키는 응답에 포함되지 않으며 화면에도 절대 노출하지 않는다.** 미구현 시 섹션 생략 가능.
- **Language**: `LangToggle variant="setting"` 재사용. 활성=`text-term-amber`, 비활성=`text-term-dim`. 선택 즉시 `langStore.setLang()` → `localStorage` + `document.documentElement.lang` 갱신.
- **로그아웃**: JWT 토큰 삭제 후 `/login`으로 이동. 스타일 `border border-term-red text-term-red hover:bg-term-red/10`(위험 동작). **BYOK 키 보존 로직 없음**(저장하는 키가 없음).
- **ShellPrompt**: `cat ~/.config`(번역 없음 — 커맨드는 i18n 대상 외).
- **i18n 키** (`src/i18n/dicts/profile.ts`):
  - `settings.title` (ko: "설정" / en: "Settings")
  - `settings.back` (ko: "‹ /me" / en: "‹ /me")
  - `settings.runtime.label` (ko: "런타임" / en: "Runtime")
  - `settings.runtime.serverManaged` (ko: "LLM 키는 서버에서 관리됩니다" / en: "LLM keys are managed on the server")
  - `settings.language.label` (ko: "언어 / Language" / en: "언어 / Language")
  - `settings.logout` (ko: "로그아웃" / en: "Logout")

---

## 10. 컴포넌트 → 요구사항 추적

> 부모 표에서 Community/Persona/contextEngine 행을 삭제하고, 에이전트 세션·도구·파일트리·상태 컴포넌트를 신규 추가.

| 컴포넌트 | 화면 | 요구 |
|----------|------|------|
| `PostCard`(+상태배지) | Home/Profile | FR-1.1 |
| `LoginForm`(2탭+게스트) | Login | FR-2 |
| `PostComposer` | CreatePost | FR-4 |
| `Avatar`(user/me/agent) | Thread/원본카드 | FR-5 |
| `ChatBubble`(human/agent/tool-call/tool-result/system) | Thread | FR-5 |
| `Composer`(AI on/off 토글) | Thread | FR-5.1 |
| `ToolCallBubble` / `ToolResultBubble` | Thread | FR-6 (신규) |
| `WorkspacePanel`(파일 트리/내용) | Thread | FR-6 (신규) |
| `SandboxStatusBadge` / `SessionStatusBadge` | Home/Thread | FR-5 (신규, Gemini 배지 대체) |
| `useThreadStream`(SSE fan-out) | Thread | FR-4.4 |
| `LangToggle`(header/setting variant) | AppLayout 상단바, Settings | FR-9 |

---

## 11. 반응형 규칙
- **<768px**: 단일 컬럼, 하단 탭바(홈/작성/나). Thread가 기본 풀스크린 채팅. 워크스페이스/파일 트리는 헤더 토글 전체화면 시트.
- **≥1024px**: 2컬럼(좌 내비 / 중앙 피드·스레드) + Thread에서 우측 워크스페이스 패널 토글.
- 버블 최대폭 78%, 도구호출/터미널출력/시스템 버블은 전폭. **터미널 출력은 자체 `overflow-x:auto` 컨테이너에서만 가로 스크롤**(페이지 본문은 가로 스크롤 금지). 터치 타깃 ≥44px(NFR-1).

---

## 12. 디자인 시스템 (그린 인광 CRT 레트로 터미널) — **전 화면 적용 (구현 단일 출처)**

> **부모 [DESIGN-SYSTEM.md](../docs/DESIGN-SYSTEM.md) (v2)를 100% 계승**한다. 색·타이포·표면·모션의 단일 출처는 그 문서이며,
> 본 절은 그 토큰을 그대로 옮기고 **Aidit-Code 신규 컴포넌트(도구 호출 버블·터미널 출력 버블·파일 트리 패널·에이전트/샌드박스
> 상태 배지·스트리밍 인디케이터)의 적용 규칙을 기존 term-* 팔레트만으로 추가**한다. **새 색 도입 금지.** 표현 계층만 — 라우팅/
> 스토어/SSE/세션 로직은 불변.

### 12.1 컬러 토큰 (term-*) — 부모에서 그대로 계승

**텍스트 / 인광 단계**

| 토큰 | HEX | 용도 |
| --- | --- | --- |
| `term-fg-bright` | `#9affc4` | 제목·강조 헤딩(약한 글로우), 에이전트 버블 글자 |
| `term-glow` | `#5cff9a` | 워드마크·입력 글자·커서·아이콘 스트로크(가장 밝은 인광) |
| `term-fg` | `#36c46f` | **DEFAULT 본문**, 일반 텍스트 |
| `term-dim` | `#1f9d56` | 보조 텍스트·메타·카운트·**도구 호출 버블 본문** |
| `term-dim-2` | `#1c8f4d` | 라벨·섹션 키커 |
| `term-dim-3` | `#157a3f` | 미세 메타·**SYSTEM 버블 텍스트**·읽음 `✓` |
| `term-faint` | `#176a3b` | 프롬프트 접두·placeholder·배지 글자·**`$` 도구 프롬프트 마크** |

**표면 / 적층**

| 토큰 | HEX | 용도 |
| --- | --- | --- |
| `term-bg` | `#04130b` | 앱 배경 기준색 |
| `term-panel` | `#08220f` | 카드·리스트 항목·열린 패널·**파일 트리 패널**·**타인 버블** 배경 |
| `term-sunken` | `#04130b` | 입력/textarea/검색 배경·**터미널 출력 버블 면** |
| `term-nav` | `#061a0d` | 하단 탭바·Composer 배경 |
| `term-modal` | `#06160c` | 로그인 모달 패널 배경 |
| `term-chart` | `#06140a` | 차트/썸네일 칩 내부 면 |

**앱 배경 그라디언트** (`bg-term-screen`, body/디바이스 셸):
`radial-gradient(125% 80% at 50% -5%, #0c2a18 0%, #04130b 58%, #020a06 100%)`

**보더 / 구분선**

| 토큰 | HEX | 용도 |
| --- | --- | --- |
| `term-line` | `#114e2b` | 헤더/탭바/Composer 구분선, 세션 디바이더 |
| `term-border` | `#1c7a42` | **기본 카드·입력·타인 버블·파일 트리** 외곽선 |
| `term-border-dim` | `#185c33` | 점선(dashed), 스크롤바 thumb |
| `term-active` | `#2bd46f` | **활성/CTA 보더**(전송·게시 버튼, 포커스 강조, 본인 버블) |

**액센트 / 시맨틱**

| 토큰 | HEX | 용도 |
| --- | --- | --- |
| `term-amber` | `#ffcf4a` | **활성 탭·AI on 토글·`[AGENT]` 라벨·RUNNING 상태 배지·키 경고**(유일한 비녹색 강조) |
| `term-amber-line` | `#6e5a1e` | 에이전트 버블/경고 박스 보더 |
| `term-amber-bg` | `rgba(60,48,10,0.4)` | 경고 박스 배경(틴트) |
| `term-red` | `#ff7a7a` | **파괴적/실패 텍스트**(로그아웃·도구 실패·ERROR 상태 배지) |
| `term-red-line` | `#5a2530` | 파괴적/실패 버블·배지 보더 |
| `term-red-bg` | `rgba(60,12,16,0.35)` | 파괴적/실패 배경(틴트) |

**CTA 그라디언트 & 글로우**
- **시그니처 CTA 면**(`bg-term-cta`): `linear-gradient(180deg, #155230 0%, #0c3a20 100%)` — 전송/게시/시작하기 버튼, **본인 버블**. 보더 `term-active`, 글자 `term-fg-bright`, `text-shadow` 글로우 + `box-shadow:0 0 14px rgba(43,212,111,0.28)`.
- **글로우(텍스트)**: 헤딩·CTA·워드마크 `text-shadow:0 0 6~8px rgba(92,255,154,0.4~0.6)`. 전역 본문 미세 `text-shadow:0 0 1px rgba(54,196,111,0.35)`.
- **글로우(아이콘)**: 로고/상태 마크 SVG `filter:drop-shadow(0 0 3~5px rgba(92,255,154,0.7))`.

**채팅 버블 색 (Thread)** — 부모 §1.6 계승 + 도구/시스템 행 추가

| 발신 | 보더 | 배경 | 글자 |
| --- | --- | --- | --- |
| 본인(HUMAN me) | `term-active` `#2bd46f` | `bg-term-cta`(그라디언트) | `#c8ffe0` |
| 타인(HUMAN peer) | `term-border` `#1c7a42` | `term-panel` `#08220f` | `term-fg` `#36c46f` |
| 에이전트(AGENT_REPLY) | `term-amber-line` `#6e5a1e` | `rgba(60,48,10,0.22)`(앰버 틴트) | `term-fg-bright` `#9affc4` |
| **도구 호출(TOOL_CALL)** | 없음/`term-line` | 투명/`term-bg` | `term-dim`(본문) + `term-faint`(`$`·`▌`) |
| **도구 결과(TOOL_RESULT)** | `term-border` | `term-sunken` `#04130b` | `term-fg`(성공) / `term-red`(실패) |
| **시스템(SYSTEM)** | 없음 | 투명 | `term-dim-3` |
| 실패 | `term-red-line` | `term-red-bg` | `term-red` |

라벨 색: 에이전트 = `term-amber`(`pi agent [AGENT] >`), 타인 = `term-dim`(`minji >`). 본인 메타 읽음 `✓ {time}` = `term-dim-3`.

### 12.2 타이포그래피 — 시스템 모노스페이스 (NO 웹폰트 CDN, 부모 계승)
- **본문/UI 스택**(`font-mono` = 전역 기본) — 부모 Aidit와 글자단위 동일. 라틴=시스템 고정폭, 한글=고정폭 코딩 폰트:
  `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'D2Coding', 'NanumGothicCoding'`
  - **끝에 `monospace` generic 금지(의도적).** generic으로 끝나면 Chrome이 한글을 비례폭 Malgun으로 폴백시켜 명시한 D2Coding(고정폭)을 건너뛴다. 명시 폰트로 끝내야 한글이 D2Coding으로 렌더. 한글 폰트 미설치 시 브라우저 최종 폴백.
- 개성은 글꼴 다운로드가 아니라 자간·굵기·터미널 관용구로. 워드마크 `AIDIT-CODE`: `font-bold`, `tracking-[0.18em~0.3em]`, `text-term-glow` + 글로우. 키커/배지: 대문자 + `tracking-[0.1em~0.15em]`, `term-faint`/`term-dim-2`. 수치·시간·ID는 고정폭 `tabular`.
- 스케일(px): 헤딩 22~24 / 화면 제목 18~20 / 카드 제목 15~17 / 본문 13~14 / 메타 11~12 / 배지 9~10.
- **i18n 주의**: 대문자 + 넓은 자간 관용구는 **라틴 라벨에만**. 한글 키커/배지는 `tracking-normal` 이하. 지원 로케일 KO + EN, 한글은 부모 Aidit과 동일하게 **고정폭 코딩 폰트**(`D2Coding`→`NanumGothicCoding`, 로컬 설치 시)로 렌더. **터미널 출력 버블(TOOL_RESULT)은 항상 고정폭 그대로**(번역·자간 가공 없음 — 기계 출력 원문 보존).

### 12.3 CRT 트리트먼트 (스캔라인·비네팅·글로우·커서, 부모 계승)
- **스캔라인**(`z-index:30`, `pointer-events:none`): `repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.16) 2px 3px)`.
- **비네팅**(`z-index:29`): `radial-gradient(125% 100% at 50% 50%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.55) 100%)`.
- **인광 글로우**: 본문 전역 `text-shadow:0 0 1px rgba(54,196,111,0.35)`, 헤딩/CTA/워드마크는 더 강한 녹색 글로우, 활성 CTA 면은 `box-shadow` 발광.
- **블링킹 커서**(`.term-cursor`): 폭 ~8px 발광 녹색 블록, `step-end` 깜빡임. ShellPrompt 줄·**에이전트 스트리밍 본문 끝**에 붙인다.
  ```css
  @keyframes termBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
  .term-cursor { display:inline-block; width:8px; background:#5cff9a;
    box-shadow:0 0 6px rgba(92,255,154,0.7); animation:termBlink 1s step-end infinite; }
  @media (prefers-reduced-motion: reduce){ .term-cursor{ animation:none } }
  ```
- **스크롤바**(웹킷): `width:7px`, thumb `#185c33`(=`term-border-dim`), track `#04130b`, `border-radius:0`. **터미널 출력 버블 내부 스크롤바도 동일**.
- **placeholder**: `color:#176a3b`(=`term-faint`), `opacity:1`. **코너**: `border-radius` 2~4px(거의 각진 박스). pill 금지.

### 12.4 적용 지점 (컴포넌트) — 부모 §4 계승 + Aidit-Code 델타

| 영역 | 적용 |
| --- | --- |
| **앱 셸**(`AppLayout`) | `bg-term-screen` + 스캔라인/비네팅 오버레이 2겹 + 전역 본문 글로우. |
| **헤더** | 좌: 로고 마크 SVG(번개형 "A") + `AIDIT-CODE` 워드마크(`term-glow`, 넓은 자간). 우: `[ {user} ]` 또는 `[ Login ]`(`term-amber`) + `LangToggle`. **Δ GEMINI 배지 없음.** 하단 `border-term-line`. |
| **하단 탭바**(홈/작성/나) | `bg-term-nav` + 상단 `border-term-line`. 라인 아이콘 SVG + 라벨. 활성 = `term-amber`, 비활성 = `term-dim-2`. **Δ 검색 탭 없음.** |
| **피드/탭**(인기·최신) | 컨테이너 `border-term-line`. 활성 탭 = `term-amber` 글자 + `rgba(255,207,74,0.06)` 배경 + 하단 `term-amber` 보더. 비활성 = `term-dim-2`. 상단 `ShellPrompt` 렌더. |
| **`ShellPrompt`** (전 화면 공통) | 최상단 고정 렌더. 형식: `aidit@<user>:~$ <command> ▌` — `<user>`는 인증 스토어 주입(미인증 `'guest'`). 커서 §12.3. 글자 `term-faint`(접두)·`term-dim`(명령)·`term-glow`(커서). **명령어는 번역하지 않는다**(UGC 인자만 보간). **Δ 화면별 명령 매핑(§12.5)**. |
| **카드(POST/내 글)** | `bg-term-panel` + `border-term-border` + radius 2px. 상단 음각 라벨 배지(`POST`, `term-faint`). 제목 `term-fg-bright` + 글로우, 메타 `term-dim`. **Δ 카드에 샌드박스 상태 배지(아래)**. |
| **CTA 버튼**(게시·시작하기·전송) | `bg-term-cta`(녹색 세로 그라디언트) + `border-term-active` + `term-fg-bright` 글자 + 글로우 + box-shadow. 라벨 `[ 게시하기 ]`처럼 대괄호 래핑. |
| **2차/토글 버튼** | `border-term-border` + `term-fg`/`term-dim`. 토글은 `[X]`/`[ ]` 글리프(ON = `term-amber`). |
| **파괴적 버튼**(로그아웃) | `border-term-red-line` + `bg-term-red-bg` + `term-red` 글자. |
| **입력/textarea** | `bg-term-sunken` + `border-term-border` + 글자 `term-glow`, placeholder `term-faint`. radius 2px. |
| **채팅 버블**(`ChatBubble`) | §12.1 표 — 본인=CTA 그라디언트, 타인=패널, 에이전트=앰버 틴트(`[AGENT]` 라벨 `term-amber`). 읽음 `✓ {time}` `term-dim-3`. |
| **이모지 → SVG** | 모든 장식 이모지(🏠＋👤⚡📌✦ 등)는 인라인 라인 SVG(currentColor, stroke 1.5~1.7). 텍스트 글리프(`▲`·`✓`·`▾`·`‹`·`⋯`·`[x]`·`>`·`$`·`▌`)는 모노폰트 그대로. |
| **`LangToggle`** | `[ KO \| EN ]` 세그먼트. 활성 = `text-term-amber`, 비활성 = `text-term-dim` + hover `text-term-bright`. 브래킷·구분자 `term-faint`. `variant='header'`/`variant='setting'`. 터치 타깃 ≥44px. |
| **테마/메타** | `index.html` `theme-color` + manifest `theme_color` → `#04130b`. |

#### 신규 컴포넌트 디자인 규칙 (기존 term-* 팔레트만, 새 색 금지)

| 신규 컴포넌트 | 적용 |
| --- | --- |
| **① 도구 호출 버블**(`TOOL_CALL`) | 전폭 좌측, 아바타 없음. 좌측 `▌`(`term-faint`) + `$ <name> <args요약>`(`term-dim`). 배경 투명/`term-bg`, radius 2px. 셸이면 실제 명령 문자열을, 파일 도구면 `write_file main.py`처럼 표시. 긴 인자는 `truncate`. |
| **② 터미널 출력 버블**(`TOOL_RESULT`) | 전폭 좌측, **고정폭 + 자체 `overflow-x:auto` 스크롤 컨테이너**(페이지 가로 스크롤 금지). 면 `term-sunken`, 보더 `term-border`, radius 2px. 글자 `term-fg`. **성공 = 기본색 + `[exit 0]`/`✓`(`term-dim-3`)**, **실패 = `term-red` + `[exit N]`**(보더 `term-red-line`, 배경 `term-red-bg`). stdout/stderr는 `tool.output`으로 누적. 스크롤바 §12.3. |
| **③ 파일 트리/워크스페이스 패널**(`WorkspacePanel`) | `bg-term-panel` + `border-term-border` + radius 2px. 디렉토리/파일은 **라인 아이콘 SVG**(폴더 `▸`/`▾` 토글, 파일 점). 변경 마크: `+`(CREATED, `term-amber`)·`M`(MODIFIED, `term-amber` 점)·취소선(DELETED, `term-red`). `file.changed` SSE로 갱신. 경로는 샌드박스 루트 상대(경로 탈출 차단). |
| **④ 에이전트/샌드박스 상태 배지**(`SandboxStatusBadge`/`SessionStatusBadge`) | **GEMINI 배지의 대체물.** LED 점 + 대문자 라벨. **활성(RUNNING) = `term-amber`**(점 글로우), **READY/IDLE/SUSPENDED(유휴) = `term-dim`**, **ERROR/FAILED = `term-red`**(`animate-pulse`), **CREATING/STARTING = `term-dim` + `⟳`**. Home 카드(샌드박스 상태 요약)·Thread 헤더(`● RUNNING · pi · N명`)에 렌더. hover 시 KO/EN 툴팁. |
| **⑤ 에이전트 스트리밍/타이핑 인디케이터** | 에이전트 답변 누적 중에는 본문 끝에 `.term-cursor`(▌) 블록. 본문 시작 전(PENDING)에는 `✦ 작성 중… •••`(스파클 SVG + 점 3개, `term-amber` 틴트). 도구 실행 중에는 TOOL_CALL 버블에 `⟳ RUNNING`(`term-dim`). `prefers-reduced-motion`이면 점/커서 애니메이션 정지. |

### 12.5 ShellPrompt 명령 매핑 (Δ from Aidit)

> 부모의 커뮤니티/검색 관련 명령을 삭제하고 에이전트·샌드박스 관용구로 교체. **명령어는 번역하지 않으며, UGC 인자(글 번호·제목 등)만 현재 언어 값으로 보간**한다. `formatPromptArg` 공유 유틸(공백 정규화 → trim → max 32자 말줄임 → 큰따옴표 이스케이프) 계승.

| 화면 | 명령 |
| --- | --- |
| 홈(인기/최신) | `feed --sort=popular` / `feed --sort=new` (대안: `ls ~/posts`) |
| 글 작성 | `post --new`(제목 있으면 `post --new "<title>"`, 본문 미노출) |
| 스레드(에이전트 세션) | `pi attach /p/<id8>` (대안: `agent --session /p/<id8>`) |
| 내 프로필 | `whoami` |
| 설정 | `cat ~/.config` |
| 로그인 화면 | `login` |

> **Δ 삭제된 매핑**: 부모의 검색 `grep -ri "<query>"`, 커뮤니티 상세 `feed r/<slug>`, 커뮤니티 생성 `mkdir /c/new` 는 해당 화면이 없으므로 **삭제**한다. 스레드 라이브 프롬프트는 `tail -f` 대신 `pi attach /p/<id8>` 로 고정(댓글 원문은 의도적으로 미반영 — 키 입력마다 재렌더 방지).

### 12.6 품질 바닥선 (Quality floor, 부모 계승)
- **반응형**: 모바일 360–430px 우선. **가로 스크롤 금지**(넓은 표/터미널 출력은 자체 컨테이너에서만 스크롤).
- **터치 타깃 ≥44px**: 탭바·전송·CTA·닫기·AI 토글 칩 등 인터랙션 요소는 히트 영역 44px 이상.
- **포커스 가시성**: `focus-visible`에 `term-active`(`#2bd46f`) 링/보더. CRT 오버레이는 `pointer-events:none`으로 포커스/클릭 미차단.
- **prefers-reduced-motion**: 커서 블링크·스트리밍 점·상태 배지 pulse 등 모든 애니메이션 정지. 스캔라인/비네팅/글로우는 정적.
- **대비**: 본문 `term-fg`(`#36c46f`) 이상, 강조 `term-fg-bright`/`term-glow`. 최약 `term-faint`는 placeholder·장식 메타에만.
- **로케일 텍스트 오버플로**: EN은 KO 대비 최대 40% 길 수 있음. 고정 폭 컨테이너는 `overflow-hidden text-ellipsis whitespace-nowrap` 또는 `line-clamp-*`. **단, 터미널 출력(TOOL_RESULT) 원문은 줄이지 않고 스크롤로 처리**.
- **날짜·숫자 포맷**: `new Intl.DateTimeFormat(lang)` / `new Intl.NumberFormat(lang)`. 하드코딩 포맷 금지.
- **회귀 금지**: 라우팅·폼 검증·인증 가드·무한 스크롤·SSE·세션 로직은 불변. **표현 계층(클래스/마크업/이모지→SVG)만** 변경.

---

## 13. 보안·격리 표면 (와이어프레임 관점)

> 데이터 모델·라이프사이클의 단일 출처는 PRD/TRD/Foundation이며, 여기서는 **화면이 격리 경계를 어떻게 노출/강제하는지**만 짚는다.

- **샌드박스 내부 = 모든 permission 허용**: 파일 CRUD·venv 세팅·패키지 설치·쉘 실행이 도구 호출 버블/터미널 출력 버블로 그대로 렌더된다. 화면은 이를 숨기지 않고 투명하게 보여준다.
- **격리 경계는 디렉토리**: 파일 트리/내용 API(`/posts/:id/files*`)와 도구 실행 모두 **샌드박스 루트 상대 경로 강제**(`..`/심볼릭 링크 차단). 위반 시 400 → 화면은 SYSTEM 버블/토스트로 "경로를 벗어났습니다" 안내.
- **키 미노출**: 어떤 화면·SSE 이벤트·`GET /runtime` 응답에도 LLM apikey가 포함되지 않는다. Settings의 Runtime 섹션은 model·baseURL 호스트만 read-only로 표시.
- **남용 방지**: 글/메시지 레이트리밋·샌드박스 동시 실행 수 제한. 초과 시 게시/전송 버튼 비활성 + 안내(429는 토스트/SYSTEM 버블).
