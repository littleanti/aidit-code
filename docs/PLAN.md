# Aidit-Code — 구현 계획서 (PLAN.md)

> 관련 문서: [PRD.md](./PRD.md), [TRD.md](./TRD.md), [WIREFRAME.md](./WIREFRAME.md), [IMPLEMENTATION_NOTES.md](./IMPLEMENTATION_NOTES.md)
> 상태: PoC · 버전: 0.2 · v2(동시 병렬 협업 에이전트) · 날짜: 2026-06-29
> 본 계획서는 5개 영역 계획(Backend / Realtime / Frontend / AgentRuntime / Cross-cutting)을 종합한 것으로, Foundation(단일 출처)의 데이터 모델·API·이벤트·화면·라이프사이클에 엄격히 근거한다. Foundation과 본 계획서의 결정은 **구속력(binding)** 을 가진다.

---

> ## Δ from Aidit (부모 대비 무엇이 바뀌었는가)
>
> Aidit-Code는 부모 **Aidit**의 형제 프로젝트다. **그린 인광 CRT 레트로 터미널 디자인 시스템은 100% 계승**하고, 본 계획서도 부모 PLAN.md의 구조·섹션·톤을 거울처럼 따른다. **동작 모델만** 아래처럼 교체했다.
>
> | 영역 | 부모 Aidit (폐기/교체) | Aidit-Code (신규) |
> |------|------------------------|--------------------|
> | LLM/키 | **BYOK** — 브라우저가 사용자 키로 Google Gemini 직접 호출, 서버 key-blind | **서버 운영자 키** — OpenAI-compatible `apikey`/`baseURL`을 **백엔드 `.env`** 에 저장, 클라 미노출·로그 미포함 |
> | 컨텍스트 | 클라이언트 **128K 지연 요약 엔진**(`contextEngine.ts`) + `ContextSegment` SoT | **pi agent 런타임이 컨텍스트·요약·툴 결과 자체 관리**. 서버는 메시지/이벤트 SoT(seq)와 SSE 릴레이만 |
> | 단위 | 커뮤니티 + 페르소나(생성자 소유) + 글 | **커뮤니티/페르소나 전면 제거**. **게시글(Post)만** 존재. 홈=게시글 피드 |
> | 실행 | LLM 호출만(코드 실행 없음) | **게시글당 백엔드 샌드박스 1:1 자동 생성** → 샌드박스에서 도는 **pi agent**가 파일 CRUD·venv·패키지 설치·쉘 실행 |
> | 채팅방 | 공유 AI 컨텍스트를 함께 쌓는 댓글 스레드 | **샌드박스의 에이전트 세션** — 다중 참여자가 같은 세션에 attach(fan-out), AI on/off 토글 |
> | 데이터 모델 | Community / ContextSegment / Comment | Community·ContextSegment 제거. **Sandbox / AgentSession / Message(=버블, Comment 대체) / ToolCall** 신규 |
> | 실시간 | `comment.created/updated`, `segment.opened` | `message.created/updated`, `agent.token`, `tool.call/output/result`, `file.changed`, `session.status`, `sandbox.status` |
> | UI | GEMINI 연결 배지, 키 입력 폼, API Key 설정 | 배지·키 폼·키 설정 **삭제**. 대신 에이전트/샌드박스 상태 인디케이터 + (선택) `/runtime` read-only |
>
> 계승: User(게스트#hex4)·Vote·Bookmark·JWT 인증(슬라이딩 7일)·i18n(KO/EN)·SSE fan-out 패턴·term-* 디자인 토큰·모바일 우선.

---

> ## Δ v2 — 동시 병렬 협업 에이전트(병렬 추론 + 직렬 부수효과)
>
> v0.1은 게시글당 단일 pi agent 세션에 N명이 attach(fan-out)하되, **동시 질문을 단일 활성 턴 + FIFO 큐로 직렬화**했다(`fix/agent-turn-serial-queue`). 그 결과 내 질문이 남의 긴 턴 뒤로 pending되는 **head-of-line(HOL) blocking**이 발생한다. v2는 이 직렬 병목만 제거하고, **단일 세션·단일 공유 컨텍스트(convo)·단일 샌드박스 디렉토리**라는 협업 모델은 **그대로 유지**한다.
>
> **핵심 결정(v2)**:
> 1. 게시글당 여전히 **단일 에이전트 세션 / 단일 공유 convo / 단일 샌드박스**. per-user 프로세스 격리 아님(공유 협업 유지).
> 2. **추론(LLM completion 스트리밍)은 병렬** — N명의 메시지가 각자 독립 "턴"으로 동시 inflight. 각 답이 남의 긴 작업과 무관하게 즉시 스트리밍(HOL blocking 제거).
> 3. **부수효과(파일 쓰기/도구 실행/컨텍스트 커밋)는 직렬** — 샌드박스 단위 단일 직렬 실행기(lock/queue) 통과. 두 턴이 같은 파일을 써도 순차 적용 → 파일 충돌·머지 불필요(머지하지 않고 **쓰기를 직렬화**).
> 4. **공유 컨텍스트 보존** — 단일 convo. 각 병렬 턴은 시작 시 convo 스냅샷을 읽고 완료 시 직렬 커밋(OpenAI `assistant.tool_calls` ↔ `role:tool` 짝 정합 보존). 동시 발사 턴은 서로의 '그 순간' 입력을 못 볼 수 있음(staleness, 수용).
> 5. **1:1 귀속 유지** — 각 턴 = 한 사용자 메시지 = 자기 AGENT_REPLY(`replyToId` 1:1). **배칭하지 않음.**
> 6. "결과 취합/머지"는 별도 로직이 아니라 transcript(seq 단조 Message)에서 자연 발생.
>
> **기각된 대안**: per-user 프로세스 격리(공유 컨텍스트 파괴 + N프로세스가 같은 cwd에 lock 없이 써 파일안전 최악 + 프로세스 폭증); 입력 배칭(N→1턴)(귀속 붕괴·무관요청 혼합·per-message reasoningEffort 소실·인터럽트 레이스). → **병렬 추론 + 직렬 부수효과**가 동시성·협업·파일안전·1:1 귀속을 모두 만족하는 유일 정합.
>
> **v2는 M1~M7 위의 증분**이다. 데이터 모델·API·이벤트·화면의 골격(M1~M7)은 그대로 두고, M3(런타임)·M4(턴/SSE)·M5(도구) 위에 멀티플렉싱·직렬 lock·동시성 상한·다중 스트리밍 UI를 **추가 마일스톤(M8)** 으로 얹는다. §2 L6은 v2로 갱신, §4에 M8 마일스톤 추가, §5에 v2 WP 추가, §8에 v2 리스크 추가.
>
> 계승(불변): 단일 세션·단일 convo·단일 샌드박스, term-* 디자인 토큰(새 색 0), i18n(KO/EN), 서버 `.env` 키, seq SoT, SSE fan-out.
>
> 알려진 한계(정직히): 동시 N턴 = N× 토큰 비용 / convo 캡이 멀티유저로 빨리 참(상향·요약 필요) / 같은 파일 동시 턴의 논리적 레이스(직렬 적용 last-wins, 필요 시 같은 파일 턴만 직렬 폴백) / detached 셸 라이터는 직렬화 밖(프로세스그룹 kill 등 별도 하드닝) / convo 스냅샷 staleness.

---

## 1. 개요 (Introduction)

Aidit-Code는 **게시글마다 백엔드 샌드박스에서 도는 코드 에이전트(pi agent)에 여러 사람이 함께 붙어, AI on/off로 채팅하며 협업 코딩하는 플랫폼**이다. 사용자가 글을 만들면 백엔드가 **샌드박스 디렉토리 하나를 생성해 그 게시글에 1:1로 할당**하고, 스레드에 진입하면 그 방은 **샌드박스에서 spawn된 pi agent 세션**이 된다. 모든 참여자는 같은 세션에 attach하며, 에이전트의 토큰·도구 호출·파일 변경은 **한 번 생성되어 전원에게 동일하게 SSE로 fan-out**된다.

부모 Aidit과 가장 큰 차이는 **LLM/키 모델**이다. **BYOK를 전면 폐기**하고, LLM은 **OpenAI-compatible** 로 동작하며 `apikey`/`baseURL`은 **백엔드 서버의 `.env`** 에만 저장된다(클라이언트 미노출, 응답·로그에 키 미포함). 비용은 **서버(운영자 키)** 부담이며, 남용 방지는 글/메시지 레이트리밋 + 샌드박스 동시 실행 수 제한으로 한다. 컨텍스트 관리(히스토리·요약)는 부모의 클라이언트 128K 요약 엔진이 아니라 **pi agent 런타임의 책임**이다.

본 문서는 작업을 **5개 영역**, **7개 마일스톤(M1→M7)** 으로 분해한다. **(v2)** 그 위에 동시 병렬 협업 에이전트 증분을 **M8(병렬 추론 + 직렬 부수효과)** 로 추가한다(§4 M8 참조). 아키텍처는 **확정(locked)** 되어 있다: Node 20 + Fastify + Prisma 백엔드(메시지/이벤트 SoT + post별 SSE 릴레이 + **AgentRuntime 어댑터**); React 18 + TypeScript + Vite 모바일 우선 프론트엔드; pi agent 런타임 채택; 샌드박스는 **호스트 디렉토리 격리 + 경로 탈출 차단 + 리소스/네트워크 정책**; 컨테이너(Firecracker/gVisor/Docker) 강화는 Out of Scope(후속).

---

## 2. 핵심 원칙 & 확정 결정 (Guiding Principles & Locked Decisions)

| # | 결정 | 출처 | 계획상 결과 |
|---|------|------|-------------|
| L1 | **LLM 키는 서버 `.env`에만**(OpenAI-compatible `apikey`/`baseURL`). 어떤 모델에도 키 필드 없음; 클라 응답/헤더/로그에 절대 없음. | Foundation keyDecisions; PRD | AgentRuntime이 spawn 시 키를 주입; XC-1 redaction 체크리스트로 강제. BYOK·connect-src·GEMINI 배지 전부 폐기. |
| L2 | **샌드박스 내부는 모든 permission 허용**(파일 CRUD·venv·패키지·쉘). 격리 경계는 (a) 디렉토리 경로 탈출 차단, (b) 리소스 제한(cgroup-lite, PoC), (c) 네트워크 정책. | Foundation sandboxLifecycle §3 | 파일 API·도구 실행 모두 루트 상대 경로 강제(`..`/symlink 차단, BE-FILES/XC-ISO). 컨테이너 강화 Out of Scope. |
| L3 | **컨텍스트/요약은 pi agent 런타임의 책임.** 서버는 보관·요약하지 않는다. 부모 `contextEngine.ts`·`ContextSegment` 폐기. | Foundation keyDecisions | 서버는 메시지/이벤트의 SoT(seq)와 SSE 릴레이만. AR(AgentRuntime) 영역이 히스토리를 런타임에 위임. |
| L4 | **`seq`가 메시지 순서·SSE 재생·멱등성의 단일 출처(SoT)**. post 내 단조 증가, 서버 부여, `@@unique([postId, seq])`. | Foundation prismaSchema(Message) | BE가 `seq` 부여; RT가 `afterSeq`/`Last-Event-ID`로 재생. |
| L5 | **게시글당 Sandbox 1:1(@unique).** 글 생성 시 자동 프로비저닝(CREATING→READY 비동기). | Foundation prismaSchema(Sandbox); sandboxLifecycle §1 | BE-PROV가 디렉토리 생성·할당; sandbox.status SSE 통지. |
| L6 | **채팅방 = 샌드박스에서 도는 pi agent 세션.** 다중 클라가 동일 세션 attach(fan-out); 에이전트 출력 1회 생성·전원 동일 중계. **(v2)** 샌드박스당 **단일 세션·단일 공유 convo·단일 샌드박스를 유지하되, 동시 다중 턴(병렬 추론)을 허용**한다 — 부수효과(파일 쓰기/도구 실행/컨텍스트 커밋)는 **샌드박스 단위 직렬 lock**으로 순차화. (v0.1의 "동시 활성 세션 1개 권장 + 단일 활성 턴/FIFO 큐"는 v2에서 폐기 — 직렬 큐는 HOL blocking을 유발.) **(opt-in)** v2 병렬은 **글 생성 시 `concurrent` 체크박스로 켜야** 동작한다(기본 OFF = v0.1 직렬; `Sandbox.meta.concurrentTurns`, 생성 시 1회 확정·변경 불가). | Foundation keyDecisions; sandboxLifecycle §2; Δ v2 | AR-ATTACH가 spawn/attach; AR-PAR/AR-MUX가 턴 멀티플렉싱; XC-SERIAL이 부수효과 직렬화; RT가 토큰/툴/파일 이벤트 중계. |
| L7 | **LLM은 OpenAI-compatible, 모델명은 단일 config/세션 필드.** 키는 `AgentSession.model`에 저장하지 않고 모델명만. | Foundation prismaSchema(AgentSession.model) | AR-CFG config 모듈; `GET /runtime`이 model·baseURL 호스트만 read-only 노출(키 미포함). |
| L8 | **커뮤니티/페르소나 없음.** Community/Persona 모델·화면 전면 제거. 홈=게시글 피드. | Foundation keyDecisions; screens | 부모의 BE-4(커뮤니티)/FE-5·6(검색/생성)/PersonaEditor 작업 **삭제**. |
| L9 | **모바일 우선, 터치 ≥44px, 그린 인광 CRT(term-*) 100% 계승.** | 공유 결정 브리프; DESIGN-SYSTEM v2 | FE-SHELL 레이아웃; 신규 컴포넌트도 기존 term-* 팔레트만 사용(새 색 없음). |
| L10 | **SQLite(PoC) → Postgres(확장)**, 무상태 서버(메시지/이벤트 외 상태는 런타임), 인메모리 pub/sub → Redis. | Foundation prismaSchema; TRD | BE-SCAF datasource 추상화; RT-PS pub/sub 인터페이스 seam. |
| L11 | **JWT Bearer 인증(슬라이딩 갱신, 기본 7일).** 게스트(닉네임#hex4, passwordHash=null)·회원(username+password, bcrypt) 듀얼모드. 읽기=선택 인증, 쓰기=JWT 필수. | Foundation apiEndpoints(auth/*) | BE-AUTH register/session/guest/refresh + requireAuth/optionalAuth. **API 키 입력/저장 개념 없음.** |
| L12 | **Message가 Comment를 대체/개명.** type = HUMAN \| AGENT_REPLY \| TOOL_CALL \| TOOL_RESULT \| SYSTEM. ToolCall은 TOOL_CALL/TOOL_RESULT 버블과 `toolCallId`로 1:1 연결. | Foundation prismaSchema(Message/ToolCall) | BE-MSG/BE-TOOL; FE-BUBBLE 5변형 렌더. |
| L13 | **i18n(KO/EN) langStore/dicts/useT/tn 계승.** 에이전트 응답 언어는 가능 범위에서 UI 언어를 따른다(런타임에 언어 힌트 전달). | 공유 결정 브리프 | I18N 영역; 부모 BYOK 오류 사전은 **서버측 세션/에이전트 오류 메시지**로 의미 교체. |

---

## 3. 아키텍처 한눈에 보기 (Architecture at a Glance)

- **시스템 다이어그램 & 데이터 흐름**: TRD §1 (클라 ↔ 서버 REST/SSE; 서버 ↔ 샌드박스 pi agent; 서버 ↔ LLM(OpenAI-compatible, `.env` 키). **클라→LLM 직접 호출 없음**).
- **스택**: TRD §2 (React/TS/Vite/Zustand/Tailwind term-*; Node/Fastify; Prisma/SQLite→Postgres; SSE; 인메모리→Redis pub/sub; **AgentRuntime(pi) 어댑터**).
- **데이터 모델**: Foundation prismaSchema (User/Post/Sandbox/AgentSession/Message/ToolCall/Vote/Bookmark). Community/ContextSegment 없음.
- **에이전트 런타임**: TRD §AR (pi agent spawn/attach/stream/interrupt; OpenAI-compatible 백엔드 주입; 컨텍스트는 런타임 책임).
- **샌드박스 격리**: Foundation sandboxLifecycle §3 (디렉토리 경로 탈출 차단 + 리소스 + 네트워크).
- **실시간**: TRD §SSE (post별 SSE, 스냅샷 재생 후 라이브, `Last-Event-ID` 복구, 다중 attach fan-out).
- **프론트엔드 구조**: TRD §FE.

---

## 4. 마일스톤 로드맵 (M1 → M7, +M8 v2)

각 마일스톤은 순서 있는 작업 패키지, 목표, 종료 기준을 나열한다. **(v2)** M1~M7은 단일 세션·단일 turn 직렬 협업 골격을 닫고, **M8**이 그 위에 동시 다중 턴(병렬 추론 + 직렬 부수효과)을 얹는다. 디렉터리 정규화(구속력): 백엔드는 `backend/` 아래, 프론트엔드/스토어/스트림은 `frontend/src/` 아래. AgentRuntime 어댑터는 `backend/src/agent/*`, 샌드박스 프로비저닝은 `backend/src/sandbox/*`, 실시간은 `backend/src/realtime/*`.

### M1 — 골격 (인증, 게시글, 홈 피드)
PRD §M1 매핑. **부모 대비 제거**: 커뮤니티 생성/검색·페르소나 편집(L8), API 키 입력 폼·키 localStorage 저장(L1).

| 순서 | WP | 제목 | 종료 관련 |
|------|----|------|-----------|
| 1 | BE-SCAF | 프로젝트 스캐폴드, Fastify+Prisma, datasource 설정 | 서버 부팅 |
| 2 | BE-DB | Prisma 스키마(Foundation) + 마이그레이션 | DB 준비 |
| 3 | BE-AUTH | `/auth/register` `/auth/session` `/auth/guest` `/auth/refresh` (JWT, bcrypt, 게스트#hex4) | 인증 계약 |
| 4 | BE-MW | JWT 미들웨어 + requireAuth/optionalAuth | 쓰기 경로 보호 |
| 5 | BE-HOT | hotScore 순수 재계산 함수 | 정렬 유틸 |
| 6 | BE-POST | 게시글: `POST /posts`(+Sandbox 1:1 자동생성 훅), `GET /posts/:id`, `GET /posts?sort=hot|new&cursor=` | FR-POST |
| 7 | BE-VOTE | `POST/DELETE /posts/:id/upvote` (멱등 토글, hot 갱신) | 인기 피드 |
| 8 | FE-SHELL | 앱 셸, 라우터, 모바일 레이아웃, 헤더(GEMINI 배지 없음), 탭바 | 내비게이션 |
| 9 | FE-API | API 클라이언트(`rest.ts`) + `api/types.ts`(키 필드 없음, Bearer 헤더 인터셉터) | 계약 |
| 10 | FE-AUTH | authStore(`{userId, username, token}` 영속화, **키 없음**) + Login 모달(2탭+게스트, API 키 필드 삭제) | L1, L11 |
| 11 | FE-HOME | 홈 피드 (PostCard, hot/new 탭, cursor, 카드에 sandbox.status 요약) | FR-FEED |
| 12 | FE-CREATE | CreatePost(제목/본문=작업 지시) → 게시 후 Thread 이동 | FR-POST |

**M1 종료 기준**: 회원가입/로그인/게스트가 `{userId,username,token}`을 영속화; 글 작성이 Post 등록 + Sandbox 행 생성 후 스레드 라우트 반환; 홈 hot/new 피드가 cursor로 렌더; 카드에 샌드박스 상태 요약 표시; 서버 어디에도 LLM 키 필드 없음(XC-1 스폿 체크); Login·Settings에 API 키 입력/섹션 없음.

### M2 — 샌드박스 프로비저닝 (글 생성 → 폴더 생성·할당)
PRD §M2 매핑. Foundation sandboxLifecycle §1.

| 순서 | WP | 제목 | 종료 관련 |
|------|----|------|-----------|
| 1 | BE-SBX | Sandbox 서비스: 디렉토리 생성·할당(postId @unique), `path`/`status`/`runtime`/`meta` 영속화 | L5 |
| 2 | BE-PROV | 글 생성 훅: Post 등록 직후 비동기 프로비저닝(CREATING→READY, 실패 ERROR), sandbox.status publish | 라이프사이클 §1 |
| 3 | BE-ISO | 경로 해석/탈출 차단 유틸(루트 상대 강제, `..`/symlink 차단) — 파일 API·도구 실행 공용 | L2 |
| 4 | BE-LIMIT | 동시 생성 수 제한(운영자 키 비용/리소스 보호) — 초과 시 큐잉 또는 429 | 남용 방지 |
| 5 | RT-PS | pub/sub 인터페이스(`PubSub` seam) + 인메모리 구현 + `publish(postId, event)` | RT 기반 |
| 6 | RT-SBXEV | `sandbox.status` 이벤트 스키마 + 발행 연결 | 상태 표면 |
| 7 | FE-SBXBADGE | 샌드박스 상태 배지(READY/RUNNING=term-amber, ERROR=term-red, 유휴=term-dim) | 인디케이터 |

**M2 종료 기준**: 글 생성 시 샌드박스 디렉토리 1개가 생성되어 그 글에 1:1(@unique) 할당; status가 CREATING→READY로 전이되며 `sandbox.status` SSE가 시청자에게 도달; 프로비저닝 실패 시 ERROR로 표면화; 동시 생성 초과 시 429/큐잉; 경로 탈출 차단 유틸이 `..`/symlink를 거부.

### M3 — pi agent 런타임 어댑터 (spawn / attach / OpenAI-compatible 주입)
PRD §M3 매핑. Foundation sandboxLifecycle §2. **부모 대비 제거**: 클라이언트 GeminiClient·BYOK 호출·128K 요약 엔진(L1/L3).

| 순서 | WP | 제목 | 종료 관련 |
|------|----|------|-----------|
| 1 | AR-CFG | LLM config 모듈: `.env`의 `API_KEY`/`BASE_URL`/`MODEL` 로드(단일 출처, PoC 기본 GitHub Models `openai/gpt-4o-mini`, 키는 메모리·미로깅) | L1, L7 |
| 2 | AR-RT | AgentRuntime 어댑터 인터페이스: `spawn` / `attach` / `sendInput` / `interrupt` / `suspend` / `streamEvents` | L6 |
| 3 | AR-PI | pi agent 구현 바인딩: 프로세스 spawn(키/baseURL/model·언어힌트 주입), PID 추적, 종료 처리 | 런타임 채택 |
| 4 | BE-SESS | `POST /posts/:id/session` attach/시작: READY/SUSPENDED→spawn(STARTING→IDLE), 활성 시 기존 세션 attach. Sandbox.status=RUNNING | 라이프사이클 §2 |
| 5 | BE-SUSPEND | `POST /posts/:id/session/suspend`: 프로세스 내림, Sandbox=SUSPENDED(디렉토리 보존), resume 시 재spawn | 라이프사이클 §5–6 |
| 6 | RT-SESSEV | `session.status` 이벤트 스키마 + 발행 연결 | 상태 표면 |
| 7 | GET-RUNTIME | `GET /runtime`: model·baseURL 호스트 read-only(키 절대 미포함) | Settings 표시 |

**M3 종료 기준**: 스레드 진입 시 READY/SUSPENDED 샌드박스에서 pi agent 프로세스가 spawn되어 AgentSession(STARTING→IDLE) 생성; `.env`의 OpenAI-compatible 키/baseURL/model이 주입되되 응답·로그에 키 미포함; 이미 활성 세션이면 새 프로세스 없이 attach; suspend가 프로세스를 내리고 디렉토리 보존, 다음 attach가 resume; `session.status`/`sandbox.status` SSE가 인디케이터를 갱신; `GET /runtime`이 키 없이 model/host만 반환.

### M4 — 협업 채팅 + SSE fan-out (다중 attach)
PRD §M4 매핑. Foundation sandboxLifecycle §3, realtimeEvents. **부모 SSE fan-out 패턴 계승**.

| 순서 | WP | 제목 | 종료 관련 |
|------|----|------|-----------|
| 1 | BE-MSG | `POST /posts/:id/messages`(HUMAN): seq 부여, clientId 멱등, RT publish, aiMode=true면 활성 세션에 입력 주입 | FR-MSG, 멱등성 |
| 2 | BE-MSGPAGE | `GET /posts/:id/messages?afterSeq=` keyset 페이지네이션(연결 toolCall 요약 포함) | NFR-PAGE |
| 3 | RT-STREAM | `GET /posts/:id/stream`: afterSeq 스냅샷 재생 후 라이브 구독 | FR-RT |
| 4 | RT-EV | 이벤트 스키마: `message.created`/`message.updated`/`agent.token` | 메시지 스트림 |
| 5 | RT-REPLAY | `Last-Event-ID`(=seq) 재접속 갭 재생 | 복구 |
| 6 | AR-TURN | 에이전트 턴: 입력 주입 → AGENT_REPLY PENDING 게시 → `agent.token` 누적 → COMPLETE/FAILED PATCH | 라이프사이클 §3 |
| 7 | BE-INT | `POST /posts/:id/interrupt`: 진행 턴 중단(steer 선택), STREAMING→COMPLETE(부분)/FAILED 확정, session=INTERRUPTED | 라이프사이클 §4 |
| 8 | FE-THREAD | threadStore(버블 리스트, 활성 세션, seq dedupe, 낙관적 삽입) | 상태 |
| 9 | FE-BUBBLE | ChatBubble: HUMAN(좌 타인/우 본인 `authorId===userId`), AGENT_REPLY(좌, 앰버 틴트) + 스트리밍/타이핑 인디케이터 | L12 |
| 10 | FE-STREAM | `useThreadStream` EventSource 훅(구독+재생+seq dedupe, fan-out 수신) | FR-RT |
| 11 | FE-COMPOSER | Composer: 메시지 전송, AI on/off 토글, clientId 전송, 인터럽트/스티어링 버튼 | FR-MSG |

**M4 종료 기준**: 한 스레드를 보는 두 브라우저가 동일 에이전트 출력을 P95 < 1.5초에 확인(NFR); 본인 메시지 우측, 타인/에이전트 좌측; aiMode=true 전송이 활성 세션 턴을 시작해 `agent.token` 스트리밍; 재접속 시 놓친 버블 재생(`Last-Event-ID`); clientId 재요청은 동일 버블 반환; 인터럽트가 진행 턴을 중단하고 부분 답변 보존.

### M5 — 도구 실행 표면 (파일 CRUD·쉘·venv) + 터미널/툴 버블
PRD §M5 매핑. Foundation prismaSchema(ToolCall), realtimeEvents(tool.*). **부모에 없던 신규 영역**.

| 순서 | WP | 제목 | 종료 관련 |
|------|----|------|-----------|
| 1 | BE-TOOL | ToolCall 영속화: kind(SHELL/FILE_*/PACKAGE/OTHER)·name·args·result·exitCode·status, Message(TOOL_CALL/TOOL_RESULT) `toolCallId` 1:1 연결 | L12 |
| 2 | AR-TOOL | 런타임 도구 이벤트 캡처: 에이전트가 샌드박스에서 실행한 쉘/파일/패키지 호출을 ToolCall + 버블로 매핑 | 도구 표면 |
| 3 | RT-TOOLEV | 이벤트 스키마: `tool.call`/`tool.output`/`tool.result` 발행 연결(stdout/stderr 스트리밍) | 실시간 도구 |
| 4 | FE-TOOLCALL | TOOL_CALL 버블(`$ <cmd>` 프롬프트 풍, term-dim/faint) | 디자인 규칙 ① |
| 5 | FE-TOOLRESULT | TOOL_RESULT 버블(고정폭 스크롤 컨테이너, 성공=기본/실패=term-red, exitCode 표시) | 디자인 규칙 ② |
| 6 | FE-TOOLSTREAM | tool.output 청크 누적(실행 중 라이브 출력), tool.result로 색·상태 확정 | 라이프사이클 §3 |

**M5 종료 기준**: 에이전트가 샌드박스 내부에서 파일 생성/삭제·venv 세팅·패키지 설치·쉘 실행을 수행(모든 permission 허용); 각 호출이 TOOL_CALL 버블(`$ cmd`)로 시작해 `tool.output` 스트리밍 후 TOOL_RESULT로 확정(성공/실패 색·exitCode); 도구 실행이 경로 탈출 차단(BE-ISO)을 강제; 모든 도구 이벤트가 동일 세션 attach 전원에게 fan-out.

### M6 — 워크스페이스 / 파일 트리 패널
PRD §M6 매핑. Foundation apiEndpoints(`/files`, `/files/content`), realtimeEvents(file.changed).

| 순서 | WP | 제목 | 종료 관련 |
|------|----|------|-----------|
| 1 | BE-FILES | `GET /posts/:id/files?path=`(디렉토리 트리, 루트 상대·BE-ISO 강제, 위반 400) | 워크스페이스 |
| 2 | BE-FILECONTENT | `GET /posts/:id/files/content?path=`(단일 파일, 바이너리 거부/메타, 대용량 잘라 반환) | 파일 열람 |
| 3 | RT-FILEEV | `file.changed`(CREATED/MODIFIED/DELETED, size?) 발행 — 도구 실행에서 트리거 | 트리 갱신 |
| 4 | FE-FILETREE | 파일 트리/워크스페이스 패널(term-panel, 라인 아이콘 SVG, 접기/펼치기) | 디자인 규칙 ③ |
| 5 | FE-FILEVIEW | 파일 내용 뷰어(고정폭, term-* 신택스 없는 단순 표시) + file.changed 라이브 갱신 | 워크스페이스 |

**M6 종료 기준**: 워크스페이스 패널이 샌드박스 파일 트리를 렌더(루트 상대 경로만, `..`/symlink 거부 400); 파일 클릭 시 내용 조회(바이너리 거부, 대용량 truncate); 에이전트의 파일 변경이 `file.changed`로 패널을 라이브 갱신; 패널은 term-* 팔레트·라인 SVG만 사용(새 색 없음).

### M7 — 다듬기 (레이트리밋·격리 강화·i18n·상태·지표)
PRD §M7 매핑. NFR + 지표 + i18n + 라이선스.

| 순서 | WP | 제목 | 종료 관련 |
|------|----|------|-----------|
| 1 | XC-ISO | 격리 강화: 리소스 제한(프로세스/메모리/CPU, cgroup-lite) + 네트워크 정책 적용 | L2 |
| 2 | XC-RATE | 레이트리밋(글/메시지) + 샌드박스 동시 실행 수 제한 | 남용 방지 |
| 3 | XC-REDACT | 키 redaction 테스트(서버 로그/응답에 키 형태 0건) + key-blind 체크리스트 | L1 |
| 4 | BE-BOOKMARK | `POST/DELETE /posts/:id/bookmark` + `GET /users/:id/bookmarks`(커서) | 계승 |
| 5 | BE-USERPOSTS | `GET /users/:id/posts`(커서) | 프로필 |
| 6 | BE-METRICS | `GET /metrics`: 글당 평균 에이전트 턴·스레드 고유 참여자·세션 성공률 | 지표 |
| 7 | FE-PROFILE | Profile(/me): 탭 [posts \| bookmarks](communities 탭 제거), usePagedList 무한 스크롤 | 화면 |
| 8 | FE-SETTINGS | Settings(/me/settings): Language(LangToggle) + 로그아웃 + (선택) `GET /runtime` read-only. **API Key 섹션 삭제** | 화면 |
| 9 | I18N | langStore/dicts/useT/tn 계승, 신규 버블·패널·상태 문자열 키화, 에이전트 언어 힌트, 서버 세션/에이전트 오류 사전 | L13 |
| 10 | FE-STATES | 빈/에러/오프라인 + SSE 재접속 배너 + 세션/샌드박스 ERROR 안내(SYSTEM 버블) | 신뢰성 |
| 11 | XC-LICENSE | MIT LICENSE + 헤더 | 라이선스 |
| 12 | XC-T | 통합 테스트 스위트(unit/contract/integration/E2E) | TRD §테스트 |

**M7 종료 기준**: 모든 PRD 수용 항목이 E2E로 통과; 격리(경로 탈출+리소스+네트워크) 강제; 레이트리밋·동시 실행 제한 동작; 키 redaction green; Profile 2탭 무한 스크롤; Settings에 API Key 섹션 없음·Language/로그아웃 동작; i18n KO↔EN 전환 + 에이전트 응답 언어 추종; 지표 엔드포인트 존재; LICENSE 존재; 통합 테스트 green.

### M8 — 동시 병렬 협업 에이전트 (v2: 병렬 추론 + 직렬 부수효과)
Δ v2 매핑. **M1~M7 위의 증분** — 데이터 모델·API 골격은 유지, 워커/부모 런타임/세션 상태/스레드 UI를 멀티플렉싱한다. 목표: v0.1의 단일 활성 턴 + FIFO 직렬 큐가 만든 **HOL blocking 제거** — 단일 세션·단일 convo·단일 샌드박스를 유지한 채 N명의 질문이 동시에 추론·스트리밍되고, 파일/도구 부수효과만 샌드박스 단위로 직렬화한다.

| 순서 | WP | 제목 | 종료 관련 |
|------|----|------|-----------|
| 0 | XC-MODE | **opt-in 게이트(선행)**: `POST /posts`에 `concurrent:boolean`(기본 false) → `Sandbox.meta.concurrentTurns` 저장. 런타임(pi.ts/turn.ts)이 플래그로 분기 — false면 v0.1 단일 활성 턴/FIFO 직렬 경로 **그대로 보존**, true면 아래 병렬 경로. CreatePost에 체크박스 + 설명/경고(i18n, term-*) 신설. 모드 생성 시 1회 확정·변경 불가. | opt-in 게이트 선행 |
| 1 | XC-SERIAL | 샌드박스 단위 부수효과 직렬 lock: 모든 도구 실행(toolBridge/toolExec, cwd=sandboxRoot)을 **턴 간에도** 단일 직렬 실행기로 순차화 → 동시 파일 쓰기 진입 0. (turn.ts 턴 내 toolChain을 넘어 샌드박스 lock으로 격상) | 파일안전 선행 |
| 2 | AR-PAR | 워커(piWorker) 턴 멀티플렉싱: 전역 단일 상태 제거 — currentTurn·toolAck(단일 resolver)·convo(단일 mutable)를 **턴별**로. 스트림별 독립 AbortController, 도구 ack는 callId/turnId 라우팅(Map), convo는 스냅샷 읽기 + 완료 순 직렬 커밋. 새 입력이 이전 턴을 abort하던 동작 제거 | 병렬 추론 |
| 3 | AR-MUX | 부모 런타임 turnId 라우팅: `RuntimeHandle.activeTurn`(단일 sink)을 `Map<turnId,TurnSink>`로; stdout 라인을 turnId로 디스패치(pumpTurnLines); send가 turnId 부여, stdin 프로토콜 `{type:'input',turnId,...}` 멀티플렉싱; ackTool/interrupt도 turnId 라우팅 | 턴 격리 중계 |
| 4 | XC-CAP | 동시성 상한 + 공정 큐: 샌드박스당 동시 inflight 턴 수 cap(`MAX_CONCURRENT_TURNS`, LLM 비용/부하 제어), 초과분은 공정(라운드로빈) 큐. **1인 1활성턴(per-user inflight=1)**: 같은 사용자의 2번째 입력은 자기 턴 완료까지 대기 → 병렬은 사용자 간에만, 동시 턴 ≤ 활성 사용자 수(자연 상한) | 비용/부하 제어·자기 직렬 |
| 5 | RT-MULTI | 세션 상태 다중 턴: 단일 IDLE/RUNNING → **활성 턴 카운트**(RUNNING = 활성 턴 ≥1, isBusy = 활성 턴 0?). `session.status` 이벤트에 활성 턴 수 표면화 | 상태 표면 |
| 6 | FE-MULTI | 다중 스트리밍 + 귀속 UI: Thread에 **여러 AGENT_REPLY 동시 스트리밍**(다중 타이핑 인디케이터 공존), 각 답글의 `replyToId` 1:1 시각 연결(내 질문 답글 하이라이트/앵커), 세션 배지 "N개 작업 진행 중", Composer 게이팅을 단일 streaming → **'내 턴'** 기준으로 해제 | 동시 협업 UX |

**M8 종료 기준**: 한 스레드에서 두 사용자가 거의 동시에 질문하면 **각 AGENT_REPLY가 서로의 긴 작업을 기다리지 않고 동시에 스트리밍**(HOL blocking 0); 각 답글이 자기 HUMAN 질문에 `replyToId` 1:1로 귀속(배칭 0); 두 턴이 같은 샌드박스에 파일을 써도 **직렬 lock으로 순차 적용**되어 동시 파일 쓰기 진입 0; convo는 단일 공유본 유지(OpenAI `tool_calls`↔`role:tool` 짝 정합 보존, 완료 순 커밋); 동시 inflight 턴이 cap을 넘으면 공정 큐로 대기; `session.status`가 활성 턴 수를 표면화; UI에 다중 "타이핑 중" 인디케이터가 공존하고 내 질문 답글이 하이라이트; term-* 팔레트만 사용(새 색 0). **알려진 한계 명시**: 동시 N턴 = N× 토큰, convo 캡 빨리 참, 같은 파일 동시 턴 last-wins, detached 셸 라이터 직렬화 밖, convo 스냅샷 staleness. **v2 경로는 `concurrent` 체크박스로 opt-in한 글에서만** 활성화되며(XC-MODE), opt-in 안 한 기본 글은 v0.1 직렬 동작이 그대로 보존됨을 함께 검증한다.

---

## 5. 상세 작업 패키지 (Detailed Work Packages)

> 5개 영역. 누락 없음. **부모 대비 제거된 WP(WP 없음)**: 커뮤니티 CRUD(BE-4)·커뮤니티 검색/상세·CreateCommunity·PersonaEditor·PersonaBadge(L8); 클라이언트 GeminiClient·buildContents·128K 요약 오케스트레이션·ContextSegment 생명주기·세그먼트 전환(L1/L3); CSP connect-src Google 화이트리스트·GEMINI 배지·키 입력 폼·키 redaction은 서버측으로 의미 교체(XC-REDACT).

### Backend (`backend/`)

| id | 제목 | 설명 | deps | files | est |
|----|------|------|------|-------|-----|
| BE-SCAF | 스캐폴드 | Fastify+TS, Prisma 초기화, datasource 추상화(SQLite→Postgres), config, health | — | `backend/src/app.ts`, `backend/src/config.ts`, `backend/prisma/schema.prisma`(init) | S |
| BE-DB | 스키마+마이그레이션 | Foundation prismaSchema 구현: User/Post/Sandbox/AgentSession/Message/ToolCall/Vote/Bookmark + enum. **어떤 모델에도 LLM 키 필드 없음.** `Message.@@unique([postId, seq])`, `[postId, clientId]` 인덱스. 마이그레이션 생성. | BE-SCAF | `backend/prisma/schema.prisma`, `backend/prisma/migrations/*` | M |
| BE-AUTH | Auth | `/auth/register`(bcrypt, 중복 409), `/auth/session`(검증 401), `/auth/guest`(닉네임≤16·'#'금지, 서버 #hex4 부여·충돌 재생성, passwordHash=null), `/auth/refresh`(슬라이딩 7일). 모두 `{id,token,username}`. 키 미수령. | BE-DB | `backend/src/routes/auth.ts` | M |
| BE-MW | JWT 미들웨어 | `Authorization: Bearer` 파싱·검증 → `request.user`. `requireAuth`(401)/`optionalAuth`(null). | BE-AUTH | `backend/src/plugins/auth.ts` | S |
| BE-HOT | hotScore 함수 | 순수 재계산 `hotScore(score, commentCount, createdAt)`. | BE-DB | `backend/src/domain/hotScore.ts` | S |
| BE-POST | 게시글 | `POST /posts`(등록 후 BE-PROV 훅 트리거), `GET /posts/:id`(sandbox/session 요약·voted·bookmarked), `GET /posts?sort=hot\|new&cursor=`(카드에 sandbox.status). `PATCH /posts/:id`(작성자만, 403). | BE-DB, BE-MW, BE-HOT, BE-SBX | `backend/src/routes/posts.ts` | M |
| BE-VOTE | Upvote | `POST/DELETE /posts/:id/upvote` 멱등, score=Vote count 재계산 + hotScore 갱신, `{voted}`. | BE-MW, BE-HOT, BE-POST | `backend/src/routes/posts.ts` | S |
| BE-SBX | Sandbox 서비스 | 디렉토리 생성·할당(postId @unique), path/status/runtime/meta 영속화, 상태 전이 헬퍼. | BE-DB, BE-ISO | `backend/src/sandbox/service.ts` | M |
| BE-PROV | 프로비저닝 훅 | Post 등록 직후 비동기: 폴더/런타임 메타 준비(CREATING→READY, 실패 ERROR), sandbox.status publish. | BE-SBX, RT-PS | `backend/src/sandbox/provision.ts` | M |
| BE-ISO | 경로 격리 유틸 | 루트 상대 경로 강제, `..`/symlink/절대경로 탈출 차단(파일 API·도구 실행 공용). | BE-SCAF | `backend/src/sandbox/pathGuard.ts` | S |
| BE-LIMIT | 동시 생성 제한 | 샌드박스 동시 프로비저닝/실행 수 제한 — 초과 시 큐잉 또는 429. | BE-SBX | `backend/src/sandbox/limiter.ts` | S |
| BE-SESS | 세션 attach | `POST /posts/:id/session`: READY/SUSPENDED→spawn(AR-RT), 활성 시 attach, Sandbox=RUNNING. `{session}`. | BE-DB, BE-MW, AR-RT, BE-SBX | `backend/src/routes/session.ts` | M |
| BE-SUSPEND | 세션 suspend | `POST /posts/:id/session/suspend`: 프로세스 내림, Sandbox=SUSPENDED(디렉토리 보존). 유휴 타이머 호출 경로 포함. | BE-SESS, AR-RT | `backend/src/routes/session.ts` | S |
| BE-INT | 인터럽트/스티어링 | `POST /posts/:id/interrupt`: 진행 턴 중단(steer 선택), STREAMING→COMPLETE(부분)/FAILED 확정, session=INTERRUPTED, SSE 통지. | BE-SESS, AR-RT, BE-MSG | `backend/src/routes/session.ts` | M |
| BE-MSG | 메시지 게시(HUMAN) | `POST /posts/:id/messages`: seq 부여, sessionId 해석, clientId 멱등(재요청 시 기존 반환), RT publish, aiMode=true면 세션에 입력 주입(AR-TURN). | BE-DB, BE-MW, RT-PS, AR-RT | `backend/src/routes/messages.ts` | M |
| BE-MSGPAGE | 메시지 페이지네이션 | `GET /posts/:id/messages?afterSeq=` seq keyset(페이지 50), 연결 toolCall 요약 포함. | BE-DB, BE-MSG | `backend/src/routes/messages.ts` | S |
| BE-TOOL | ToolCall 영속화 | kind/name/args/result/exitCode/status 저장, Message(TOOL_CALL/TOOL_RESULT) `toolCallId` 1:1 연결, 상태 전이. | BE-DB, BE-MSG | `backend/src/domain/toolCall.ts` | M |
| BE-FILES | 파일 트리 | `GET /posts/:id/files?path=` 디렉토리 엔트리(BE-ISO 강제, 위반 400). | BE-DB, BE-ISO, BE-SBX | `backend/src/routes/files.ts` | M |
| BE-FILECONTENT | 파일 내용 | `GET /posts/:id/files/content?path=`(바이너리 거부/메타, 대용량 truncate, BE-ISO). | BE-FILES | `backend/src/routes/files.ts` | S |
| BE-BOOKMARK | 북마크 | `POST/DELETE /posts/:id/bookmark`(멱등), `GET /users/:id/bookmarks?cursor=`(bookmark 행 기준 정렬). | BE-DB, BE-MW | `backend/src/routes/bookmarks.ts` | M |
| BE-USERPOSTS | 사용자 글 | `GET /users/:id/posts?cursor=`(post.createdAt desc, id desc). | BE-DB | `backend/src/routes/users.ts` | S |
| BE-METRICS | 지표 | `GET /metrics`: 글당 평균 에이전트 턴, 스레드 고유 참여자, 세션 성공률. | BE-DB | `backend/src/routes/metrics.ts` | M |
| GET-RUNTIME | 런타임 정보 | `GET /runtime`: model·baseURL 호스트 read-only(**키 절대 미포함**). | AR-CFG | `backend/src/routes/runtime.ts` | XS |

### Realtime (`backend/src/realtime/*`)

| id | 제목 | 설명 | deps | files | est |
|----|------|------|------|-------|-----|
| RT-PS | Pub/sub seam | `PubSub` 인터페이스 + 인메모리 구현 + `publish(postId, event)`(Redis 교체 가능). | BE-SCAF | `backend/src/realtime/pubsub.ts`, `publish.ts` | M |
| RT-STREAM | Stream 엔드포인트 | `GET /posts/:id/stream`: afterSeq 스냅샷 재생 후 라이브 구독, heartbeat. **BE-MSG/AR-TURN 이벤트 소비**. | RT-PS, BE-MSG | `backend/src/realtime/stream.ts` | M |
| RT-EV | 메시지 이벤트 스키마 | 타입 지정 `message.created`/`message.updated`/`agent.token`. | RT-PS | `backend/src/realtime/events.ts` | S |
| RT-REPLAY | 재접속 재생 | `Last-Event-ID`(=seq) 갭 재생. | RT-STREAM, RT-EV, BE-MSGPAGE | `backend/src/realtime/stream.ts` | S |
| RT-TOOLEV | 도구 이벤트 | `tool.call`/`tool.output`/`tool.result` 스키마 + 발행 연결(stdout/stderr 청크). | RT-PS, BE-TOOL | `backend/src/realtime/events.ts` | M |
| RT-FILEEV | 파일 이벤트 | `file.changed`(CREATED/MODIFIED/DELETED, size?) 발행. | RT-PS | `backend/src/realtime/events.ts` | S |
| RT-SESSEV | 세션 이벤트 | `session.status`(STARTING/IDLE/RUNNING/INTERRUPTED/STOPPED/ERROR) 발행. | RT-PS | `backend/src/realtime/events.ts` | S |
| RT-SBXEV | 샌드박스 이벤트 | `sandbox.status`(CREATING/READY/RUNNING/SUSPENDED/ERROR, lastActiveAt) 발행. | RT-PS | `backend/src/realtime/events.ts` | S |
| **RT-MULTI** *(v2)* | 다중 턴 세션 상태 | 단일 IDLE/RUNNING → 활성 턴 카운트(RUNNING = 활성 턴 ≥1, isBusy = 활성 턴 0?). `session.status` 이벤트에 활성 턴 수 표면화. | RT-SESSEV, AR-MUX | `backend/src/realtime/events.ts`, `backend/src/routes/session.ts` | S |

### AgentRuntime (`backend/src/agent/*`)

| id | 제목 | 설명 | deps | files | est |
|----|------|------|------|-------|-----|
| AR-CFG | LLM config | `.env`의 OpenAI-compatible `API_KEY`/`BASE_URL`/`MODEL` 로드(단일 출처, PoC 기본 GitHub Models `openai/gpt-4o-mini`, 메모리만, 미로깅). | BE-SCAF | `backend/src/agent/config.ts` | S |
| AR-RT | 어댑터 인터페이스 | `AgentRuntime`: `spawn`/`attach`/`sendInput`/`interrupt`/`suspend`/`streamEvents`(런타임 교체 가능 seam). | AR-CFG | `backend/src/agent/runtime.ts` | M |
| AR-PI | pi agent 바인딩 | pi agent 프로세스 spawn(키/baseURL/model·언어힌트 주입), PID 추적, attach/resume, 종료. 컨텍스트·요약은 런타임 책임(L3). | AR-RT | `backend/src/agent/pi.ts` | L |
| AR-TURN | 에이전트 턴 | 입력 주입 → AGENT_REPLY PENDING 게시 → `agent.token` 누적(seq) → COMPLETE/FAILED. session=RUNNING. | AR-PI, BE-MSG, RT-EV | `backend/src/agent/turn.ts` | L |
| AR-TOOL | 도구 이벤트 캡처 | 런타임이 보고한 쉘/파일/패키지 호출을 ToolCall(BE-TOOL) + TOOL_CALL/TOOL_RESULT 버블로 매핑, tool.* 발행. | AR-PI, BE-TOOL, RT-TOOLEV | `backend/src/agent/toolBridge.ts` | M |
| **AR-PAR** *(v2)* | 워커 턴 멀티플렉싱 | piWorker 전역 단일 상태 제거: currentTurn·toolAck(단일 resolver, ~mjs:375)·convo(단일 mutable, ~mjs:170)를 턴별로. 스트림별 독립 AbortController, 도구 ack는 callId/turnId 라우팅(Map), convo는 스냅샷 읽기 + 완료 순 직렬 커밋. 새 입력이 이전 턴 abort하던 동작(~mjs:519-524) 제거. | AR-PI, XC-SERIAL | `backend/src/agent/piWorker.mjs` | L |
| **AR-MUX** *(v2)* | 부모 turnId 라우팅 | `RuntimeHandle.activeTurn`(단일 sink, ~pi.ts:109)을 `Map<turnId,TurnSink>`로; pumpTurnLines(~pi.ts:195-214)가 stdout 라인의 turnId로 디스패치; send가 turnId 부여, stdin `{type:'input',turnId,...}` 멀티플렉싱; ackTool/interrupt도 turnId 라우팅. | AR-PI, AR-PAR | `backend/src/agent/pi.ts` | L |

### Frontend (`frontend/src/`)

| id | 제목 | 설명 | deps | files | est |
|----|------|------|------|-------|-----|
| FE-SHELL | 앱 셸 | 라우터, 모바일 우선 레이아웃, 하단 탭바, 헤더(**GEMINI 배지 없음**, ShellPrompt 매핑 갱신), term-* 토큰. | — | `frontend/src/App.tsx`, `frontend/src/layout/*` | M |
| FE-API | API 클라이언트 + 타입 | `rest.ts`, `api/types.ts` — 세션/Post/Message/Sandbox/Session/ToolCall DTO(**키 필드 없음**), Bearer 헤더 인터셉터, 메시지 게시 `clientId`. | BE 계약 | `frontend/src/api/rest.ts`, `frontend/src/api/types.ts` | M |
| FE-AUTH | authStore + Login | `{userId,username,token}` 영속화(**키 없음**); Login 모달 2탭(register/session)+게스트; **API 키 입력 필드 삭제**; 로그아웃 시 토큰 삭제. | FE-API, BE-AUTH | `frontend/src/stores/authStore.ts`, `frontend/src/components/LoginModal.tsx` | M |
| FE-HOME | 홈 피드 | PostCard(sandbox.status 요약 + 업보트), hot/new 탭, cursor 무한 스크롤. | FE-SHELL, FE-API | `frontend/src/pages/Home.tsx`, `frontend/src/components/PostCard.tsx` | M |
| FE-CREATE | CreatePost | 제목/본문(작업 지시), 게시 후 Thread 이동(+편집 모드 재사용). | FE-API | `frontend/src/pages/CreatePost.tsx` | S |
| FE-THREAD | threadStore | 버블 리스트, 활성 세션, 낙관적 삽입, seq dedupe. | FE-API | `frontend/src/stores/threadStore.ts` | M |
| FE-BUBBLE | ChatBubble | HUMAN(좌 타인/우 본인 `authorId===userId`), AGENT_REPLY(좌, 앰버 틴트) + 스트리밍/타이핑 인디케이터(디자인 규칙 ⑤). | FE-AUTH, FE-THREAD | `frontend/src/components/ChatBubble.tsx` | M |
| FE-TOOLCALL | TOOL_CALL 버블 | `$ <cmd>` 프롬프트 풍, term-dim/faint(디자인 규칙 ①). | FE-BUBBLE | `frontend/src/components/ToolCallBubble.tsx` | S |
| FE-TOOLRESULT | TOOL_RESULT 버블 | 고정폭 스크롤 컨테이너, 성공=기본/실패=term-red, exitCode(디자인 규칙 ②). | FE-BUBBLE | `frontend/src/components/ToolResultBubble.tsx` | M |
| FE-COMPOSER | Composer | 메시지 입력, **AI on/off 토글**, clientId 전송, 인터럽트/스티어링 버튼. | FE-THREAD, FE-BUBBLE | `frontend/src/components/Composer.tsx` | M |
| FE-STREAM | useThreadStream | EventSource 구독+재생+seq dedupe, fan-out 수신(메시지/토큰/도구/파일/상태). | RT-STREAM, RT-EV, FE-THREAD | `frontend/src/stream/useThreadStream.ts` | M |
| FE-SBXBADGE | 상태 배지 | 샌드박스/세션 상태 배지(활성=term-amber, 실패=term-red, 유휴=term-dim)(디자인 규칙 ④). | FE-API | `frontend/src/components/StatusBadge.tsx` | S |
| FE-FILETREE | 파일 트리 패널 | term-panel, 라인 SVG, 접기/펼치기, file.changed 라이브 갱신(디자인 규칙 ③). | BE-FILES, FE-STREAM | `frontend/src/components/FileTree.tsx` | M |
| FE-FILEVIEW | 파일 뷰어 | 고정폭 단순 표시, 대용량 truncate 안내, file.changed 갱신. | BE-FILECONTENT, FE-FILETREE | `frontend/src/components/FileView.tsx` | S |
| FE-PROFILE | Profile(/me) | 탭 [posts \| bookmarks], usePagedList 무한 스크롤, ⚙→/me/settings. | FE-API | `frontend/src/pages/Profile.tsx`, `frontend/src/hooks/usePagedList.ts` | M |
| FE-SETTINGS | Settings | Language(LangToggle) + 로그아웃 + (선택) `GET /runtime` read-only. **API Key 섹션 삭제**. | FE-API, GET-RUNTIME | `frontend/src/pages/Settings.tsx` | S |
| FE-STATES | 상태 | 빈/에러/오프라인, SSE 재접속 배너, 세션/샌드박스 ERROR 안내. | FE-HOME, FE-THREAD | `frontend/src/components/states/*` | S |
| **FE-MULTI** *(v2)* | 다중 스트리밍 + 귀속 UI | 여러 AGENT_REPLY 동시 스트리밍(다중 타이핑 인디케이터 공존), `replyToId` 1:1 시각 연결(내 질문 답글 하이라이트/앵커), 세션 배지 "N개 작업 진행 중", Composer 게이팅을 단일 streaming→'내 턴' 기준으로 해제. term-* 팔레트만(새 색 0). | FE-THREAD, FE-BUBBLE, FE-STREAM, FE-COMPOSER, RT-MULTI | `frontend/src/components/ChatBubble.tsx`, `frontend/src/components/Composer.tsx`, `frontend/src/stores/threadStore.ts`, `frontend/src/components/StatusBadge.tsx` | M |

### Cross-cutting (`backend/` + `frontend/`)

| id | 제목 | 설명 | deps | files | est |
|----|------|------|------|-------|-----|
| XC-ISO | 격리 강화 | 리소스 제한(프로세스/메모리/CPU, cgroup-lite) + 네트워크 정책. 컨테이너 강화 Out of Scope. | BE-SBX, AR-PI | `backend/src/sandbox/limits.ts` | M |
| **XC-MODE** *(v2)* | 동시 병렬 opt-in 게이트 | `POST /posts` `concurrent:boolean`(기본 false) → `Sandbox.meta.concurrentTurns`; 런타임이 플래그로 분기(false=v0.1 직렬 경로 보존, true=병렬). CreatePost 체크박스 + 설명/경고(i18n, term-amber/term-dim). 생성 시 1회 확정·변경 불가. | BE-POST, BE-SBX | `backend/src/routes/posts.ts`, `backend/src/sandbox/*`, `frontend/src/pages/CreatePost.tsx`, `frontend/src/i18n/dicts/*` | S |
| **XC-SERIAL** *(v2)* | 부수효과 직렬 lock | 샌드박스 단위 단일 직렬 실행기: 모든 도구 실행(toolBridge/toolExec, cwd=sandboxRoot)을 **턴 간에도** 순차화(turn.ts 턴 내 toolChain ~turn.ts:160을 샌드박스 lock으로 격상) → 동시 파일 쓰기 진입 0. 같은 파일 동시 턴은 last-wins, 필요 시 같은 파일 턴만 직렬 폴백. | BE-SBX, BE-ISO, AR-TOOL | `backend/src/agent/sandboxLock.ts`, `backend/src/agent/turn.ts` | M |
| **XC-CAP** *(v2)* | 동시성 상한 + 공정 큐 | 샌드박스당 동시 inflight 턴 수 cap(`MAX_CONCURRENT_TURNS`) — LLM 비용/부하 제어; 초과분은 공정(라운드로빈) 큐. | AR-MUX, XC-RATE | `backend/src/agent/turnLimiter.ts` | S |
| XC-RATE | 레이트리밋 | 글/메시지 레이트리밋 + 샌드박스 동시 실행 수 제한. | BE-AUTH, BE-POST, BE-MSG, BE-LIMIT | `backend/src/plugins/rateLimit.ts` | S |
| XC-REDACT | 키 redaction | 서버 로그/응답에 LLM 키 형태 payload 0건 단언 + key-blind 체크리스트 + CI grep 게이트. | AR-CFG, BE 전체 | `backend/test/security/redaction.test.ts`, `docs/checklists/key-blind.md` | S |
| I18N | 다국어 | langStore/dicts/useT/tn 계승, 신규 버블·패널·상태 문자열 키화, 에이전트 언어 힌트(systemInstruction), 서버 세션/에이전트 오류 사전(KO/EN). | FE-SHELL, AR-PI | `frontend/src/i18n/*`, `frontend/src/stores/langStore.ts` | M |
| XC-LICENSE | 라이선스 | MIT LICENSE + 소스 헤더. | — | `LICENSE` | XS |
| XC-T | 통합 테스트 | 단일 스위트: hotScore/pathGuard/seq 멱등(unit); clientId 멱등 + 파일 경로 탈출 차단 + session attach(contract); 다중 클라 SSE fan-out + 도구 스트리밍 + suspend/resume(integration); E2E(글→샌드박스→세션→AI 턴→도구→파일, pi 모킹+실런타임). | 모든 구현 WP | `backend/test/**`, `frontend/src/**/*.test.ts`, `e2e/**` | L |

---

## 6. 의존성 / 순서 노트 (Dependency / Sequencing Notes)

**임계 경로(Critical path)**: BE-SCAF→BE-DB→BE-AUTH→BE-POST→BE-SBX→BE-PROV→AR-CFG→AR-RT→AR-PI→BE-SESS→BE-MSG→AR-TURN→RT-STREAM→BE-TOOL→AR-TOOL→XC-T. **(v2 증분 경로)**: AR-TOOL→XC-SERIAL→AR-PAR→AR-MUX→XC-CAP→RT-MULTI→FE-MULTI.

**순서 노트**:
- **프로비저닝은 세션과 분리**: BE-PROV(M2, 폴더 생성)는 AgentRuntime에 의존하지 않는다 — Sandbox는 READY까지만 가고, 실제 pi agent spawn은 BE-SESS(M3)에서 일어난다. M2는 디렉토리·상태 표면까지만 닫는다.
- **publish seam 선행**: RT-PS(M2)가 BE-MSG/AR-TURN보다 먼저 와야 BE 쓰기 경로가 stream 엔드포인트(RT-STREAM)에 결합되지 않는다. RT-STREAM(M4)이 BE-MSG 이벤트를 *소비*한다(역방향 아님).
- **ToolCall ↔ Message 연결**: BE-TOOL(M5)은 BE-MSG(M4) 이후에 와야 `toolCallId` 1:1 연결이 성립. AR-TOOL은 AR-PI(M3) + BE-TOOL을 모두 소비.
- **경로 격리 공용화**: BE-ISO(M2)를 파일 API(BE-FILES, M6)와 도구 실행(AR-TOOL, M5) 양쪽이 공유 — 격리 로직 단일 출처.
- **(v2) 직렬 lock이 멀티플렉싱보다 먼저**: XC-SERIAL(M8)이 AR-PAR/AR-MUX보다 선행해야, 워커가 동시 다중 턴을 허용하는 순간 도구 실행이 무방비로 동시 진입하지 않는다(파일안전 선결). 순서: **XC-MODE → XC-SERIAL → AR-PAR → AR-MUX → XC-CAP → RT-MULTI → FE-MULTI**(XC-MODE 게이트가 가장 먼저 — 기본 OFF로 깔아두면 이후 WP를 점진 도입하는 동안에도 기본 글은 v0.1 직렬로 안전).
- **(v2) M8은 M5 위**: AR-PAR/AR-MUX는 AR-PI(M3)·AR-TURN(M4)·AR-TOOL(M5)을 모두 전제한다 — 단일 턴 경로가 닫힌 뒤 멀티플렉싱으로 격상. FE-MULTI는 FE-THREAD/FE-STREAM/FE-COMPOSER(M4) 위에서 단일 streaming 가정만 '내 턴' 기준으로 해제.

**영역 간 의존성**:
- FE↔BE 인터페이스: 구현 전에 `api/types.ts`(세션/Post/Message/Sandbox DTO, **키 필드 없음**, Bearer 헤더, 메시지 `clientId`) early-freeze.
- AR↔BE: BE-SESS/BE-MSG/AR-TURN 전에 `AgentRuntime` 인터페이스(AR-RT)와 LLM config(AR-CFG) 동결.
- RT 이벤트 스키마(RT-EV/TOOLEV/FILEEV/SESSEV/SBXEV)는 FE-STREAM 전에 동결.

**병렬 레인**: M1 FE(FE-SHELL..FE-CREATE)는 FE-API 계약 동결 후 BE(BE-SCAF..BE-VOTE)와 병렬. M5 도구 버블 FE는 RT-TOOLEV 도착 후 병렬. **(v2)** FE-MULTI(M8 UI)는 turnId/replyToId·session.status 활성-턴 스키마(AR-MUX/RT-MULTI) 동결 후 백엔드 멀티플렉싱과 병렬.

**Early-freeze 항목**: `api/types.ts` 계약; RT 이벤트 스키마; `AgentRuntime` 인터페이스(AR-RT); LLM config(AR-CFG); 경로 격리 계약(BE-ISO). **(v2 추가)** turnId 멀티플렉싱 프로토콜(stdin `{type:'input',turnId,...}` / stdout 라인 turnId / ackTool·interrupt turnId 라우팅, AR-MUX); `replyToId` 1:1 귀속 계약; `session.status` 활성-턴 카운트 스키마(RT-MULTI); 샌드박스 직렬 lock 계약(XC-SERIAL).

---

## 7. 요구사항 추적 매트릭스 (Requirement Traceability Matrix)

모든 요구사항이 ≥1개의 커버 WP에 매핑. 미커버 요구사항 없음.

| 요구사항 | 커버 WP |
|----------|---------|
| 인증(register/session/guest/refresh, JWT 슬라이딩) | BE-AUTH, BE-MW, FE-AUTH, L11 |
| 게스트#hex4(passwordHash=null) | BE-AUTH, FE-AUTH |
| **LLM 키 서버 .env 전용, 클라/로그 미노출** | L1, AR-CFG, XC-REDACT, GET-RUNTIME |
| 홈 게시글 피드(hot/new, cursor, sandbox.status) | BE-POST, BE-HOT, FE-HOME, RT-SBXEV |
| 글 작성 | BE-POST, FE-CREATE |
| 글 작성 → 샌드박스 1:1 자동 생성 | BE-PROV, BE-SBX, L5 |
| 샌드박스 격리(경로 탈출+리소스+네트워크) | BE-ISO, XC-ISO, L2 |
| 동시 생성/실행 제한 | BE-LIMIT, XC-RATE |
| 세션 attach/시작(다중 fan-out) | BE-SESS, AR-RT, AR-PI, L6 |
| **(v2) 동시 다중 턴(병렬 추론, HOL blocking 제거)** | AR-PAR, AR-MUX, XC-CAP, L6, Δ v2 |
| **(v2) 부수효과 직렬화(동시 파일 쓰기 진입 0)** | XC-SERIAL, AR-PAR(convo 직렬 커밋), BE-ISO |
| **(v2) 1:1 귀속(replyToId, 배칭 0) + 다중 스트리밍 UI** | AR-TURN(replyToId), FE-MULTI, RT-MULTI |
| 세션 suspend/resume | BE-SUSPEND, AR-PI, sandboxLifecycle §5–6 |
| 인터럽트/스티어링 | BE-INT, AR-PI |
| pi agent 런타임(OpenAI-compatible 주입) | AR-CFG, AR-RT, AR-PI, L7 |
| 컨텍스트/요약 = 런타임 책임 | AR-PI, L3 |
| 사람 메시지 전송(HUMAN, clientId 멱등) | BE-MSG, FE-COMPOSER |
| AI on/off 토글 | FE-COMPOSER, BE-MSG(aiMode) |
| 에이전트 턴(AGENT_REPLY 스트리밍) | AR-TURN, RT-EV, FE-BUBBLE |
| 본인=우/타인·에이전트=좌 | FE-BUBBLE(`authorId===userId`), BE-AUTH |
| 실시간 SSE fan-out | RT-PS, RT-STREAM, RT-EV, FE-STREAM |
| 재접속 재생(Last-Event-ID) | RT-REPLAY, BE-MSGPAGE |
| 도구 실행(파일CRUD·쉘·venv·패키지) | BE-TOOL, AR-TOOL, L2 |
| TOOL_CALL/TOOL_RESULT 버블 | FE-TOOLCALL, FE-TOOLRESULT, RT-TOOLEV |
| 워크스페이스/파일 트리 패널 | BE-FILES, BE-FILECONTENT, RT-FILEEV, FE-FILETREE, FE-FILEVIEW |
| 상태 인디케이터(session/sandbox) | RT-SESSEV, RT-SBXEV, FE-SBXBADGE |
| 추천(업보트) | BE-VOTE, FE-HOME(PostCard) |
| 북마크 + 프로필 | BE-BOOKMARK, BE-USERPOSTS, FE-PROFILE |
| Settings(Language+로그아웃, API Key 없음) | FE-SETTINGS, GET-RUNTIME |
| i18n KO/EN + 에이전트 언어 추종 | I18N, L13 |
| 지표(턴 수/참여자/세션 성공률) | BE-METRICS |
| 신뢰성(세션/도구 실패 보존·안내) | AR-TURN, FE-STATES, FE-TOOLRESULT |
| 라이선스 MIT | XC-LICENSE |
| 성능 P95 < 1.5s 전파 | RT-STREAM, XC-T |

**부모 대비 제거되어 매트릭스에서 빠진 요구사항**: 커뮤니티 검색/생성·페르소나=systemInstruction·생성자 페르소나 편집(L8); BYOK 키 로컬 저장·키 서버 미전송·CSP connect-src Google·GEMINI 성공률 배지(L1); 128K 요약 버블·요약 후 컨텍스트 재조립·요약 색 구분 경계·작성자 D1 VisitEvent(L3, PoC 범위 외).

---

## 8. 통합 리스크 & 미해결 질문 (Consolidated Risks & Open Questions)

### 리스크 (완화책 포함)
1. **운영자 키 비용/남용**(서버 부담) → 글/메시지 레이트리밋 + 샌드박스 동시 실행 수 제한(XC-RATE, BE-LIMIT); 유휴 suspend(BE-SUSPEND).
2. **키 유출**(클라/로그) → 키는 `.env`·메모리만, 응답·로그 redaction 단언(XC-REDACT, L1).
3. **샌드박스 탈출**(경로/리소스/네트워크) → 루트 상대 강제·`..`/symlink 차단(BE-ISO) + 리소스/네트워크 정책(XC-ISO). 컨테이너 강화는 후속.
4. **동시성 하의 메시지 일관성** → 서버 `seq` SoT, `@@unique([postId, seq])`(L4, BE-MSG).
5. **다중 attach 출력 중복** → 에이전트 출력 1회 생성·전원 동일 중계(L6, AR-TURN, RT-STREAM).
6. **재접속 시 SSE 이벤트 누락** → `Last-Event-ID` 재생(RT-REPLAY).
7. **clientId 충돌/악용** → `[postId, clientId]` 인덱스 + 서버 신뢰 seq(BE-DB, BE-MSG).
8. **본인 버블 오귀속** → 영속화된 `userId`로 `authorId===userId` 판정(FE-AUTH, FE-BUBBLE).
9. **샌드박스 프로비저닝 실패** → status=ERROR 표면화 + SYSTEM 버블 안내(BE-PROV, FE-STATES).
10. **장시간 도구 실행/행(hang)** → 인터럽트(BE-INT) + 리소스 타임아웃(XC-ISO).
11. **단일 인스턴스 pub/sub 한계** → Redis 인터페이스 seam(RT-PS, L10).
12. **suspend 후 컨텍스트 손실** → 파일은 디렉토리 보존, 인메모리 컨텍스트는 런타임 재구성 정책(AR-PI, L3).
13. **대용량 도구 출력/파일** → tool.output 스트리밍 + 파일 truncate(RT-TOOLEV, BE-FILECONTENT).
14. **에이전트 응답 언어 불일치** → 런타임 언어 힌트(I18N, L13) — best-effort.
15. **지표 데이터 희박(PoC)** → DB 산출 best-effort(BE-METRICS).
16. **(v2) 동시 N턴 토큰 N배 비용** → 샌드박스당 동시 inflight 턴 cap + 공정 큐(XC-CAP); 글/메시지 레이트리밋(XC-RATE).
17. **(v2) 동시 다중 턴의 파일/도구 레이스** → 샌드박스 단위 부수효과 직렬 lock(XC-SERIAL); 같은 파일 동시 턴은 직렬 적용 last-wins, 필요 시 같은 파일 턴만 직렬 폴백.
18. **(v2) 공유 convo 정합/staleness** → 턴별 스냅샷 읽기 + 완료 순 직렬 커밋(OpenAI `tool_calls`↔`role:tool` 짝 정합 보존, AR-PAR); 동시 발사 턴의 staleness는 수용(문서화).
19. **(v2) convo 캡이 멀티유저로 빨리 참** → convo 상향·요약 정책(런타임 책임, L3) — best-effort, 후속 하드닝.
20. **(v2) detached 셸 라이터가 직렬 lock 밖** → 프로세스그룹 kill 등 별도 하드닝(연기, 명시적 한계).

### 미해결 질문 (비차단; 필요 시 기본값)
1. pi agent 런타임 바인딩 형태(라이브러리 vs 프로세스 프로토콜) — AR-RT 인터페이스 뒤로 추상화, PoC는 프로세스 spawn 기본.
2. 샌드박스당 동시 활성 세션 — **여전히 단일 세션 유지**(공유 협업). **(v2 정정)** 단, 그 단일 세션 안에서 **동시 다중 턴(병렬 추론)을 허용**한다 — v0.1의 "동시 활성 세션 1개 권장"은 단일 세션 유지로 의미가 좁혀졌고, 동시성은 세션 격리가 아니라 턴 멀티플렉싱(AR-PAR/AR-MUX) + 부수효과 직렬 lock(XC-SERIAL)으로 달성한다.
3. 리소스 제한 강도(cgroup-lite 한계) — PoC 보수적 기본값(XC-ISO).
4. 네트워크 정책 범위(아웃바운드 허용 여부) — PoC 제한적 허용, 정책 연기.
5. suspend 유휴 타이머 임계 — 보수적 기본값(BE-SUSPEND).
6. 동시 attach 시 입력 처리(누가 턴을 시작?) — **(v2 정정)** v0.1의 "seq 순 단일 활성 턴 직렬 처리 + 진행 중 인터럽트 권장"은 HOL blocking을 유발하므로 **폐기**. v2는 **각 입력이 독립 턴으로 동시 inflight**(병렬 추론, 배칭 0); 부수효과만 샌드박스 직렬 lock으로 순차화. 인터럽트는 이제 '내 턴'에만 적용(turnId 라우팅, AR-MUX).
7. ToolCall 결과 보존 크기 상한 — 소프트 캡 + truncate, 연기.
8. 컨테이너(Firecracker/gVisor/Docker) 전환 시점 — Out of Scope, 다중 테넌트 시 재검토.
9. SQLite→Postgres 전환 — 추상화만(L10), 단일 인스턴스 데모는 SQLite 유지.
10. 파일 트리 대형 디렉토리 페이지네이션 — PoC 단순 트리, 대형은 lazy 연기.
11. 에이전트 모델 교체 UX — `.env` 재시작 기반, 런타임 핫스왑 연기.
12. CI에서 pi 런타임 모킹 vs 실런타임 — 양쪽 레인(XC-T).
13. 게스트 권한 범위(글 작성·세션 가능?) — PoC 쓰기 JWT 필수, 게스트도 토큰 보유로 허용(레이트리밋 강화).
14. 최대 버블 페이지 크기 — 50(BE-MSGPAGE).
15. 업로드/첨부(이미지 등) — PoC 범위 외, 후속.

---

## 9. 완료 정의 (Definition of Done)

> 범례: `[ ]` 미착수(PoC v0.1 계획 단계) · 구현 후 `[x]`(자동검증/스모크) 또는 `[~]`(코드검증 완료, 명시 항목 미측정)로 갱신. 상세는 [IMPLEMENTATION_NOTES.md](./IMPLEMENTATION_NOTES.md)에 기록.

### PRD 수용기준 (각각 검증 WP/여정에 연결)
- [x] **#1** 홈 게시글 피드(hot/new) + 카드 샌드박스 상태 요약 — BE-POST/BE-HOT/FE-HOME + RT-SBXEV. (M1/M2)
- [x] **#2** 글 작성 → Sandbox 1:1 자동 생성 → Thread 이동 — BE-POST/BE-PROV/FE-CREATE. (M1/M2)
- [x] **#3** 스레드 진입 → pi agent 세션 spawn/attach(OpenAI-compatible 주입, 키 미노출) — BE-SESS/AR-PI/AR-CFG. (M3; PoC stub 런타임)
- [x] **#4** 다중 참여자 동일 세션 attach, 에이전트 출력 전원 fan-out — AR-TURN/RT-STREAM/FE-STREAM. (M4; 2-구독자 바이트 동일 검증)
- [x] **#5** AI on/off 토글 채팅; 본인=우/타인·에이전트=좌 — FE-COMPOSER/FE-BUBBLE(`authorId===userId`). (M4)
- [x] **#6** 도구 실행(파일CRUD·쉘·venv·패키지) → TOOL_CALL/TOOL_RESULT 버블(성공/실패 색) — BE-TOOL/AR-TOOL/FE-TOOL*. (M5)
- [x] **#7** 워크스페이스/파일 트리 패널 + file.changed 라이브 갱신(경로 탈출 차단) — BE-FILES/RT-FILEEV/FE-FILETREE. (M6)
- [x] **#8** 인터럽트/스티어링·suspend/resume — BE-INT/BE-SUSPEND/AR-PI. (M3/M4)
- [x] **키 모델** 모든 LLM 호출이 서버 `.env` 키로, 클라/로그에 키 0건 — L1/AR-CFG/XC-REDACT. (센티넬 누출 0 검증)

### 엔지니어링 게이트
- [~] **실시간**: 재접속 재생 정확 + message/agent.token/tool.*/file.changed/session.status/sandbox.status seq 순서 — SSE integration green. (P95 < 1.5s는 미측정)
- [~] **격리**: 경로 탈출 차단(`..`/symlink/절대경로 거부) green + 도구 wall-clock 타임아웃·프로세스 캡. (cgroup/메모리·CPU·네트워크 egress 강제는 크로스플랫폼 한계로 연기, 플래그만)
- [x] **신뢰성**: 세션/도구 실패 시 메시지 보존, FAILED/ERROR 표면화(SYSTEM 버블) — AR-TURN/FE-STATES.
- [x] **보안**: LLM 키 redaction(로그/응답/소스 0건, keygate) + 레이트리밋 + 동시 실행 제한 — XC-REDACT/XC-RATE.
- [x] **디자인**: term-* 팔레트만 사용(새 색 0), 신규 버블/패널/상태 배지 — DESIGN-SYSTEM v2 계승.
- [x] **i18n**: KO↔EN 전환 + 에이전트 응답 언어 추종(best-effort, LANG_HINT 전파) + 서버 오류 사전 — I18N.
- [x] **지표**: 글당 평균 에이전트 턴·고유 참여자·세션 성공률 — BE-METRICS.
- [~] **배포**: 정적 프론트 + Node 서버 + 샌드박스 호스트 구조 확립(로컬 실행·검증). SQLite→Postgres는 추상화만(L10). (실 배포 파이프라인 미구성)
- [~] **라이선스**: MIT LICENSE 존재 — XC-LICENSE. (per-file 소스 헤더는 동시 레인 충돌 회피로 연기)
- [x] **테스트**: 통합 스위트 unit/contract/integration green — **백엔드 36파일/152건 + 프론트 9파일/127건**(2026-07-28 기준, 최초 기재값 52에서 확충); E2E(글→샌드박스→세션→AI 턴→도구→파일)는 pi 모킹 스캐폴드 레인(XC-T `test/e2e.test.ts`) + **단언형 브라우저 E2E**(`frontend/e2e/concurrent-turns.assert.mjs`).
- [x] **(v2) 동시 병렬 협업(M8)**: 두 사용자의 동시 질문이 각자 독립 턴으로 동시 스트리밍(HOL blocking 0) — AR-PAR/AR-MUX; 각 AGENT_REPLY가 자기 HUMAN에 `replyToId` 1:1 귀속(배칭 0); 같은 샌드박스 동시 턴의 부수효과 직렬 적용(동시 파일 쓰기 진입 0) — XC-SERIAL; convo 단일 공유본 정합 보존(`tool_calls`↔`role:tool`, 완료 순 커밋); 동시 inflight 턴 cap + 공정 큐 — XC-CAP; `session.status` 활성 턴 수 표면화 — RT-MULTI; UI 다중 타이핑 인디케이터 공존 + 내 답글 하이라이트(term-* 새 색 0) — FE-MULTI. **한계 명시**: N× 토큰 / convo 캡 / 같은 파일 last-wins / detached 셸 직렬화 밖 / convo staleness.
  - **완료 근거(2026-07-28 실측)**: ① HOL blocking 제거 — `B TTFT ~ L` 회귀 기울기 직렬 1.000 vs 병렬 **0.000**, L=15s에서 14930→235ms(n=20/셀, EXPERIMENTS §E2) ② 부수효과 직렬 — 락 우회 시 같은 파일 동시 쓰기 위반률 **74%**·최종 파일 오염, 락 적용 시 **0%**(§E1 W1) ③ 1:1 귀속·동시 스트리밍·활성 턴 표면화 — **실제 브라우저 2개**에서 단언 통과, 직렬 계약 음성 대조군은 겹침 −277ms로 실패(테스트가 실제로 분별함을 증명).
  - **적용 범위(정직히)**: ①의 큰 이점은 동시 질문이 **추론 중심**일 때 성립한다. 두 턴이 모두 파일을 수정하면 직렬 실행기가 병목이 되어 **1.07×(결정적)~1.35×(실 LLM)** 로 줄어든다(§E2-B). 부수효과 직렬화를 택한 계약의 필연적 귀결이며, 대가로 파일 깨짐 0·머지 불필요·1:1 귀속을 얻는다.

### 후속(범위 밖 — 별도 판단 필요)

- **논문 실험 잔여**: E1 W1b(디렉토리 레이스)·W2(convo 짝 정합 — 워커에 `BENCH_COMMIT=naive` 게이트 신설 필요)·E3(스케일 스윕)·E4(적대적 격리)·E6(사용자 연구). **사용자 결정으로 후속 시행**.
  - E3 는 로컬 단일 LLM 인스턴스로는 측정 불가(상류 큐가 교란변수 — 우리 cap 포화와 구분 불가). E4 는 모델 행동 자체가 측정 대상이라 로컬 무제한 모델(ollama 등)이 적합.
- **운영 담당**: CI 파이프라인·컨테이너 격리는 **실 서버 배포 시 구축**(README §6, TRD §6.3). 적용할 컨테이너 플래그는 이미 실측 검증됨(PASS 7/FAIL 0, EXPERIMENTS 부록 B).
- **문서 정합**: `PATENT.html`/`PAPER.html` 은 부수효과 직렬화를 "샌드박스 단위"로 서술한다. XC-SCOPE 는 이를 "충돌하는 부수효과를 직렬화"로 일반화한 것이다(보장 동일, 입도만 세분화). 청구항 문구 조정은 별도 판단 대상으로 **미처리**.
