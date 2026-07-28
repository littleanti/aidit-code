# Aidit-Code — Technical Requirements Document (TRD)

> Companion to [PRD.md](./PRD.md). Status: PoC · Version: 0.2 · v2(동시 병렬 협업 에이전트) · Date: 2026-06-29
> 핵심 설계 원칙: **백엔드가 코드 에이전트를 호스팅한다.** 게시글마다 백엔드 샌드박스에서 도는 코드 에이전트(pi agent)에 여러 사람이 attach해, AI on/off로 채팅하며 협업 코딩한다. LLM 키는 **서버 `.env`** 에만 있고 클라이언트는 모른다. 서버는 메시지/이벤트의 SoT(순서·seq) + 스레드별 SSE 릴레이 + AgentRuntime 오케스트레이션을 담당한다.

> #### Δ from Aidit (부모 대비 무엇이 바뀌었는가)
> - **백엔드 = 코드 에이전트 호스트.** 웹 백엔드가 opencode server / pi agent처럼 동작한다. 본 프로젝트는 **pi agent를 런타임으로 채택**한다(§1·§5).
> - **BYOK 전면 폐기.** 클라이언트가 Google Gemini로 직접 호출하던 구조 제거. LLM은 **OpenAI-compatible** 로 동작하며 `apikey`/`baseURL`은 **서버 `.env`** 에 저장(클라 미노출, 응답/로그에 키 미포함). 비용은 서버 부담(§2·§5·§8).
> - **커뮤니티/페르소나 제거.** Community/Persona 모델·화면 전면 삭제. **게시글(Post)만** 존재, 홈 = 게시글 피드(§3·§4).
> - **게시글 생성 → 샌드박스 1:1 자동 생성.** 글을 만들면 백엔드가 샌드박스 디렉토리 하나를 만들어 그 게시글에 @unique로 할당(§3·§6).
> - **채팅방 = 샌드박스에서 도는 pi agent 세션.** 각자 LLM(BYOK)에서 도는 게 아니라, 방이 열리면 그 방은 백엔드 샌드박스의 pi agent다. 모든 참여자가 같은 세션에 attach(fan-out)(§1·§5·§7).
> - **클라이언트 128K 요약 엔진(contextEngine.ts)·ContextSegment 폐기.** 컨텍스트(히스토리·요약·툴 결과)는 **pi agent 런타임의 책임**. 서버는 메시지/이벤트 SoT와 SSE 릴레이만(§6).
> - **버블 모델 확장.** `Comment` → `Message`(type=HUMAN|AGENT_REPLY|TOOL_CALL|TOOL_RESULT|SYSTEM). 신규 `Sandbox`/`AgentSession`/`ToolCall` 모델(§3).
> - **CSP `connect-src` Google 화이트리스트·GEMINI 연결 배지·키 입력 폼·키 localStorage 저장 전부 제거.** 격리 경계는 샌드박스 디렉토리(경로 탈출 차단)·리소스·네트워크 정책으로 이동(§8).

> #### Δ v2 — 동시 병렬 협업 에이전트(병렬 추론 + 직렬 부수효과)
> **배경(v0.1 한계)**: 게시글당 단일 pi agent 세션에 N명이 attach(fan-out)하되, 동시 질문은 **단일 활성 턴 + FIFO 큐**로 직렬화된다(`pi.ts` `RuntimeHandle.activeTurn`(단일, pi.ts:109)·`queue`(pi.ts:111), worker `currentTurn`(단일, piWorker.mjs:372)). 내 질문이 남의 긴 턴 뒤로 pending 되는 **head-of-line blocking**이 생긴다. v2는 이 직렬 병목만 제거하고, **단일 세션·단일 공유 컨텍스트(convo)·단일 샌드박스**라는 협업 모델은 그대로 유지한다.
>
> **v2 핵심 결정(계약 수준)**:
> 1. 게시글당 여전히 **단일 에이전트 세션 / 단일 공유 컨텍스트(convo) / 단일 샌드박스 디렉토리**. per-user 프로세스 격리가 아니다(공유 협업 유지).
> 2. **추론(LLM completion 스트리밍)은 병렬**: N명의 메시지가 각자 독립 "턴"으로 동시 inflight. 각 사용자의 답이 남의 긴 작업과 무관하게 즉시 스트리밍(HOL blocking 제거 = 진짜 동시 협업).
> 3. **부수효과(파일 쓰기/도구 실행/컨텍스트 커밋)는 직렬**: 샌드박스 단위 단일 직렬 실행기(lock/queue) 통과. 두 턴이 같은 파일을 써도 순차 적용 → 파일을 머지하지 않고 **쓰기를 직렬화**(충돌·머지 불필요).
> 4. **공유 컨텍스트 보존**: 단일 convo 유지. 각 병렬 턴은 시작 시 convo 스냅샷을 읽고 완료 시 직렬 커밋(OpenAI `assistant.tool_calls` ↔ `role:tool` 짝 정합 보존, piWorker.mjs:313-343). 동시 발사된 턴들은 서로의 '그 순간' 입력을 못 볼 수 있음(staleness, 수용).
> 5. **1:1 귀속 유지**: 각 턴 = 한 사용자 메시지 = 자기 `AGENT_REPLY`(`replyToId` 1:1, turn.ts:57). **배칭하지 않는다.**
> 6. **결과 취합/머지는 별도 로직이 아님** — `seq` 단조 증가 Message 테이블(transcript)에서 자연 발생.
>
> **채택 이유(대안 기각)**: ① per-user 프로세스 격리는 공유 컨텍스트를 파괴하고 N프로세스가 같은 cwd에 lock 없이 써 파일안전 최악 + 프로세스 폭증/회수 부재. ② 입력 배칭(N→1턴)은 귀속 붕괴·무관요청 혼합·per-message `reasoningEffort`(turn.ts:46·pi.ts:40) 소실·인터럽트 윈도우 레이스 4문제 자초. → **병렬 추론 + 직렬 부수효과**가 동시성·협업·파일안전·1:1 귀속을 모두 만족하는 유일 정합. (§1·§5·§6·§7·§8에 반영)
>
> **opt-in 게이트(기본 OFF)**: v2 병렬 동작은 **게시글 생성 시 체크박스**로 켜야 적용된다. `POST /posts` 요청에 `concurrent: boolean`(기본 `false`)을 받아 `Sandbox.meta`(JSON, §3)에 `{ "concurrentTurns": true }`로 저장하고, 런타임(`pi.ts`/`turn.ts`)이 이 플래그로 분기한다 — `false`면 v0.1 단일 활성 턴/FIFO 경로 그대로, `true`면 위 병렬 경로. 모드는 생성 시 1회 확정(단방향). 키는 어떤 경로에도 미노출(불변식 유지).
>
> **알려진 한계(정직히 명시)**: 동시 N턴 = N× 토큰 비용 / convo 캡(piWorker.mjs:179 `N=40`)이 멀티유저로 빨리 참(상향·요약 필요) / 같은 파일 동시 턴의 논리적 레이스(직렬 적용 last-wins) / detached 셸 라이터는 직렬 lock 밖(프로세스그룹 kill 등 별도 하드닝) / convo 스냅샷 staleness.

---

## 1. 아키텍처 개요

```
┌─────────────────────────── Browser (PWA, React) ───────────────────────────┐
│  UI (Home-Feed / CreatePost / Thread-AgentSession)                          │
│  ├─ AuthStore        localStorage: { username, token }   (API 키 저장 없음)   │
│  ├─ RestClient       fetch → Fastify REST (사람 메시지 전송·세션·인터럽트·파일) │
│  ├─ ThreadStream     EventSource(SSE)  ← 서버 실시간 버블/토큰/툴/파일/상태     │
│  └─ WorkspacePanel   파일 트리/내용 조회(선택)  ← REST + file.changed 이벤트   │
└───────────┬───────────────────────────────────────────────┬───────────────┘
            │ REST (사람 메시지·세션 attach·인터럽트, 키 미포함)   │ SSE (구독·fan-out)
            ▼                                                   ▼
┌────────────────────── Aidit-Code Server (Node + Fastify) ───────────────────┐
│  REST API  /posts /posts/:id/messages /session /interrupt /files ...        │
│  SSE Hub   /posts/:id/stream  (post 단위 pub/sub fan-out, seq 재생)          │
│  Domain    Post · Sandbox · AgentSession · Message(=Bubble) · ToolCall      │
│  AgentRuntime 어댑터  spawn / attach / stream / interrupt / suspend          │
│       │  OpenAI-compatible LLM 주입 (.env: API_KEY / BASE_URL / MODEL)      │
└───────────┬───────────────────────────────────┬─────────────────────────────┘
            ▼                                     ▼
   Postgres (PoC는 SQLite 가능)         pi agent 프로세스 (per Sandbox)
   + Redis(선택, 다중 인스턴스 SSE)        └─ 샌드박스 디렉토리(격리 루트)
                                            ├─ 파일 CRUD · venv · 패키지 · 쉘
                                            └─ LLM 호출 → OpenAI-compatible API
                                                          (키는 서버가 주입)
```

**백엔드가 LLM 키를 들고, 샌드박스 안의 pi agent가 LLM을 호출**하는 것이 핵심이다. 클라이언트는 LLM과 직접 통신하지 않으며 키를 절대 받지 않는다. 클라이언트가 받는 것은 서버가 SSE로 중계하는 **에이전트 토큰·도구 호출 이벤트·파일 변경 이벤트·세션/샌드박스 상태**뿐이다. 다중 클라이언트가 동일 세션에 attach하면 에이전트 출력은 **한 번 생성되어 전원에게 동일하게 fan-out**된다.

> **Δ v2 — 동시성 모델**: 위 fan-out(출력 1회 생성·전원 중계)은 유지하되, 게시글당 N명의 **입력(턴)은 더 이상 직렬화되지 않는다**. v2는 게시글당 **단일 세션·단일 공유 컨텍스트(convo)·단일 샌드박스**를 유지한 채, **추론(LLM 스트리밍)은 병렬**(턴별 독립 inflight), **부수효과(도구 실행/파일 쓰기/컨텍스트 커밋)는 샌드박스 단위 직렬 lock**으로 처리한다. 즉 N개의 `AGENT_REPLY` 버블이 **동시에 STREAMING** 될 수 있고(각자 자기 `replyToId`로 1:1 귀속), 도구·파일 효과만 단일 직렬 큐를 통과한다. 상세 계약은 §5·§6·§7·§8.

### 1.1 부모(Aidit)에서 가져오는 것 / 새로 만드는 것

| 부모 Aidit 자산 | Aidit-Code에서 |
|----------------|-----------|
| SSE Hub(`/posts/:id/stream`) post 단위 fan-out + 재생(replay) | **계승.** 이벤트 종류를 에이전트 토큰/툴/파일/상태로 확장(§7) |
| `Comment`(=버블) + `seq` SoT 정렬 | **계승하되 `Message`로 재정의**(type 5종·status·toolCallId)(§3) |
| `authStore`·JWT·게스트#hex4·i18n(langStore/dicts/useT/tn) | **그대로 계승**(§10·§14). 단 키 필드/입력 제거 |
| 클라이언트 `GeminiClient(BYOK)` + `contextEngine.ts`(128K 요약) | **폐기.** 컨텍스트는 pi agent 런타임 책임, LLM 호출은 서버 측 |
| `Community`/`Persona`/`ContextSegment` 모델·화면 | **폐기.** 게시글(Post)만 존재(§3·§4) |
| (신규) **AgentRuntime(pi agent) 어댑터** | 샌드박스 프로세스 spawn/attach/stream/interrupt, OpenAI-compatible LLM 주입(§5) |
| (신규) **Sandbox 격리 레이어** | 호스트 디렉토리 격리 + 경로 탈출 차단 + 리소스/네트워크 정책(§6·§8) |

---

## 2. 기술 스택 (PoC 권장)

| 레이어 | 선택 | 비고 |
|--------|------|------|
| Frontend | **React 18 + TypeScript + Vite**, React Router, Zustand(상태), TailwindCSS(그린 CRT `term-*` 토큰) | 모바일 우선, PWA(vite-plugin-pwa). 부모 그대로 |
| 실시간 | **SSE (EventSource)** | 단방향 서버→클라(토큰/툴/파일/상태) 충분. 쓰기(사람 메시지·인터럽트)는 REST |
| Backend | **Node 20 + Fastify + TypeScript** | 가볍고 SSE 친화적. 부모 그대로 |
| ORM/DB | **Prisma + SQLite(PoC) → Postgres(확장)** | 무상태 서버, `seq`가 메시지 순서의 단일 SoT |
| 인증 | **bcrypt(비밀번호) + @fastify/jwt(서명)** | 비밀번호 해시 저장, Bearer JWT. 게스트#hex4 듀얼모드 |
| Pub/Sub | **인메모리(단일 인스턴스)** → **Redis pub/sub**(다중) | post 채널 fan-out 수평확장 |
| **AgentRuntime** | **pi agent**(런타임 어댑터로 spawn/attach/stream/interrupt) | §5. 샌드박스 프로세스 호스트 |
| **LLM** | **OpenAI-compatible** (`API_KEY`/`BASE_URL`/`MODEL`) — PoC 기본값은 **GitHub Models `openai/gpt-4o-mini`** | **서버 `.env`** 에만 저장. 클라 미노출·로그 미포함. §5·§8 |
| 샌드박스 | **호스트 디렉토리 격리 + 프로세스/cgroup-lite + 경로 탈출 차단** | PoC. 컨테이너(Firecracker/gVisor/Docker) 강화는 Out of Scope(후속) |
| 배포 | 정적 프론트(CDN) + Node 서버(컨테이너, 샌드박스 워크디렉토리 마운트) | |

---

## 3. 데이터 모델

> **Δ from Aidit**: `Community`/`Persona`/`ContextSegment` 제거, BYOK 키 저장 개념 제거. `Comment`→`Message` 재정의, `Sandbox`/`AgentSession`/`ToolCall` 신규. 아래는 단일 출처(SoT) Prisma 스키마 전재.

```prisma
// Aidit-Code — Prisma schema (PoC) · SoT
// Δ from Aidit: Community/Persona/ContextSegment 제거, BYOK 키 저장 개념 제거,
//               Sandbox / AgentSession / Message(=버블, Comment 대체) / ToolCall(=AgentEvent) 신규.
// DB: SQLite(PoC) → Postgres(확장). 무상태 서버, seq가 메시지 순서의 단일 출처(SoT).

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite" // PoC. 확장 시 "postgresql"
  url      = env("DATABASE_URL")
}

// ── 사용자 ──────────────────────────────────────────────
// username 유지(표시·본인 판별). 게스트는 `닉네임#hex4`(예: 철수#a3f9) 결합 문자열, passwordHash=null.
// API 키 저장/전송 개념 전면 제거(LLM 키는 서버 .env에만). User는 키 필드를 갖지 않는다.
model User {
  id           String   @id @default(cuid())
  username     String   @unique          // 전역 유일. 게스트는 서버가 #hex4 부여로 유일화.
  passwordHash String?                   // bcrypt 해시. 게스트(닉네임만 진입)는 null.
  createdAt    DateTime @default(now())

  posts        Post[]
  messages     Message[]
  votes        Vote[]
  bookmarks    Bookmark[]
}

// ── 게시글 ──────────────────────────────────────────────
// communityId 제거. 글 생성 시 Sandbox 1:1 자동 생성(서비스 레이어). 홈=게시글 피드.
model Post {
  id           String   @id @default(cuid())
  authorId     String
  author       User     @relation(fields: [authorId], references: [id])
  title        String
  body         String                     // 초기 작업 지시/설명(에이전트 첫 발화의 시드로 사용 가능)
  score        Int      @default(0)        // Vote 행 수(인기 정렬용)
  commentCount Int      @default(0)        // Message 중 사람/에이전트 답변 수(버블 카운트)
  hotScore     Float    @default(0)        // 비정규화 인기점수
  createdAt    DateTime @default(now())

  sandbox      Sandbox?                    // 1:1(Sandbox.postId @unique)
  messages     Message[]
  votes        Vote[]
  bookmarks    Bookmark[]

  @@index([hotScore])
  @@index([authorId, createdAt])
}

// ── 샌드박스 ────────────────────────────────────────────
// 게시글당 1개(@unique). 호스트 디렉토리 격리(path)가 격리 경계. 내부는 모든 permission 허용.
enum SandboxStatus {
  CREATING   // 폴더/런타임 준비 중
  READY      // 준비 완료, 아직 에이전트 미가동(유휴)
  RUNNING    // 에이전트 세션 활성(작업/스트리밍 중)
  SUSPENDED  // 유휴로 일시중단(프로세스 내려감, 디렉토리 보존)
  ERROR      // 생성/실행 실패
}

model Sandbox {
  id           String        @id @default(cuid())
  postId       String        @unique       // 1:1
  post         Post          @relation(fields: [postId], references: [id])
  path         String                       // 호스트 절대경로(격리 루트). 경로 탈출 차단 기준.
  status       SandboxStatus @default(CREATING)
  runtime      String        @default("pi") // 런타임 식별자(pi agent)
  meta         String?                       // JSON: 리소스/네트워크 정책, 디스크 사용량 등.
  //                                          //   (v2) concurrentTurns: boolean — 동시 병렬 협업 opt-in 플래그.
  //                                          //   글 생성 시 POST /posts {concurrent} 로 1회 확정(기본 false=v0.1 직렬). 변경 불가.
  createdAt    DateTime      @default(now())
  lastActiveAt DateTime      @default(now())

  sessions     AgentSession[]

  @@index([status, lastActiveAt])
}

// ── 에이전트 세션 ──────────────────────────────────────
// 채팅방=샌드박스에서 도는 pi agent 세션. 모든 참여자가 동일 세션에 attach(fan-out).
// Sandbox와 분리(세션 재시작 이력 보존). 동시 활성 세션(=프로세스)은 샌드박스당 1개 권장(PoC).
//   ※ v2: 이는 '세션 1개'를 뜻할 뿐 '턴 직렬'이 아니다. 단일 세션 안에서 여러 사용자 턴이
//      동시 병렬 추론된다(§5.6). 직렬화되는 것은 부수효과뿐(샌드박스 단위 lock, §6.4).
enum AgentSessionStatus {
  STARTING   // 프로세스 spawn/attach 중
  IDLE       // attach됨, 입력 대기(스트리밍 아님)
  RUNNING    // 토큰/툴 스트리밍 중
  INTERRUPTED// 사용자 인터럽트로 현재 턴 중단
  STOPPED    // 정상 종료
  ERROR      // 런타임 오류
}

model AgentSession {
  id          String             @id @default(cuid())
  sandboxId   String
  sandbox     Sandbox            @relation(fields: [sandboxId], references: [id])
  status      AgentSessionStatus @default(STARTING)
  model       String                              // 활성 모델명(.env baseURL/apikey로 주입, 키는 미저장)
  runtimePid  Int?                                // 호스트 프로세스 PID(있으면)
  startedAt   DateTime           @default(now())
  endedAt     DateTime?

  messages    Message[]                            // 이 세션에서 생성/귀속된 버블
  toolCalls   ToolCall[]

  @@index([sandboxId, startedAt])
}

// ── 메시지(=버블, Comment 대체/개명) ──────────────────
// 채팅 버블의 SoT. seq가 post 내 단조 증가 정렬키(SSE 재생/멱등 기준).
enum MessageType {
  HUMAN        // 사람 발화(우=본인, 좌=타인)
  AGENT_REPLY  // 에이전트 텍스트 답변(좌, 앰버 틴트)
  TOOL_CALL    // 도구 호출 버블($ <cmd> 풍, term-dim/faint)
  TOOL_RESULT  // 도구 결과/터미널 출력 버블(고정폭, 성공/실패 색)
  SYSTEM       // 시스템 알림(세션 상태/오류 안내 등)
}

enum MessageStatus {
  PENDING    // 생성 예약(아직 본문 없음/대기)
  STREAMING  // 토큰/출력 누적 중
  COMPLETE   // 완료
  FAILED     // 실패
}

model Message {
  id          String        @id @default(cuid())
  postId      String
  post        Post          @relation(fields: [postId], references: [id])
  sessionId   String?                          // 어느 AgentSession 턴에 속하는지(사람 입력은 null 가능)
  session     AgentSession? @relation(fields: [sessionId], references: [id])
  authorId    String?                          // 사람=userId, AGENT/TOOL/SYSTEM=null
  author      User?         @relation(fields: [authorId], references: [id])
  type        MessageType
  status      MessageStatus @default(COMPLETE)
  body        String                           // 사람 텍스트 / 에이전트 답변 텍스트 / 시스템 문구
  // 어떤 사람 메시지에 대한 에이전트 응답인지(스티어링 추적)
  replyToId   String?
  replyTo     Message?      @relation("ReplyChain", fields: [replyToId], references: [id])
  replies     Message[]     @relation("ReplyChain")
  // TOOL_CALL/TOOL_RESULT 버블이 가리키는 도구 호출 레코드(1:1)
  toolCallId  String?       @unique
  toolCall    ToolCall?     @relation("ToolCallBubble", fields: [toolCallId], references: [id])
  seq         Int                              // post 내 단조 증가(SoT 정렬키). 서버 부여.
  clientId    String?                          // 사람 전송 멱등키(중복 게시 방지)
  createdAt   DateTime      @default(now())

  @@unique([postId, seq])
  @@index([postId, seq])
  @@index([postId, clientId])
}

// ── 도구 호출 / 에이전트 이벤트 ─────────────────────────
// pi agent가 샌드박스에서 실행한 도구(쉘/파일/패키지)의 이름·인자·결과·상태.
// 채팅에는 TOOL_CALL/TOOL_RESULT Message 버블로 렌더(Message.toolCallId로 연결).
enum ToolCallStatus {
  RUNNING    // 실행 중
  SUCCEEDED  // 종료코드 0/성공
  FAILED     // 실패(비0 종료/예외)
}

enum ToolKind {
  SHELL        // 쉘 명령 실행
  FILE_WRITE   // 파일 생성/수정
  FILE_DELETE  // 파일 삭제
  FILE_READ    // 파일 읽기
  PACKAGE      // 패키지 설치/venv 세팅
  OTHER        // 기타 런타임 도구
}

model ToolCall {
  id         String         @id @default(cuid())
  sessionId  String
  session    AgentSession   @relation(fields: [sessionId], references: [id])
  kind       ToolKind
  name       String                          // 도구/명령 이름(예: "bash", "write_file")
  args       String                          // JSON 직렬화 인자(명령 문자열·경로 등)
  result     String?                         // stdout/stderr/요약(스트리밍 누적 후 확정)
  exitCode   Int?
  status     ToolCallStatus @default(RUNNING)
  startedAt  DateTime       @default(now())
  endedAt    DateTime?

  bubble     Message?       @relation("ToolCallBubble") // 연결된 TOOL_CALL/RESULT 버블

  @@index([sessionId, startedAt])
}

// ── 추천(업보트) ───────────────────────────────────────
model Vote {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  postId    String
  post      Post     @relation(fields: [postId], references: [id])
  createdAt DateTime @default(now())

  @@unique([userId, postId])   // 사용자당 글당 1표
  @@index([postId])
}

// ── 북마크 ─────────────────────────────────────────────
model Bookmark {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  postId    String
  post      Post     @relation(fields: [postId], references: [id])
  createdAt DateTime @default(now())

  @@unique([userId, postId])
  @@index([userId, createdAt]) // 프로필 북마크 최신순
}
```

**설계 포인트**

- **버블 = `Message`**, 종류는 `type`(HUMAN/AGENT_REPLY/TOOL_CALL/TOOL_RESULT/SYSTEM). 좌/우는 클라가 `authorId === me ? 우 : 좌`로 판정(에이전트/도구/시스템은 `authorId=null` → 항상 좌).
- **`seq`** 는 post 내 전역 단조 증가 — SSE 재생/정렬/멱등의 단일 출처. `@@unique([postId, seq])` 로 강제. 부모의 `ContextSegment`/`tokenSum` 기반 128K 판정은 **삭제**(컨텍스트는 pi agent 런타임 책임, §6).
- **`Sandbox`**(postId @unique 1:1): 게시글당 하나. `path`(호스트 절대경로)가 격리 루트이자 경로 탈출 차단 기준. `status` 5종(§6 라이프사이클).
- **`AgentSession`**: 샌드박스에서 도는 pi agent 세션. Sandbox와 분리(재시작 이력 보존). `model`은 활성 모델명만 저장하고 **키는 절대 저장하지 않는다**(서버 `.env`에만).
- **`ToolCall`**: 에이전트가 샌드박스에서 실행한 도구의 이름·인자·결과·상태. `Message.toolCallId`(@unique)로 TOOL_CALL/TOOL_RESULT 버블과 1:1 연결 → 채팅에 터미널 출력 버블로 렌더.
- **`replyToId`**: 어떤 사람 메시지에 대한 에이전트 응답/스티어링인지 추적.
- **`clientId`**: 사람 메시지 전송 멱등키(네트워크 재시도 안전).
- **추천(`Vote`)/북마크(`Bookmark`)**: 부모 계승. `@@unique([userId, postId])`로 사용자당 글당 1표/1북마크. `Post.score`는 `Vote` 행 수(count). `GET /posts/:id`·피드 카드는 선택 인증 시 `voted`/`bookmarked` 불린 계산. PoC에서 유지하되 부차적.

---

## 4. REST API (요약)

> **인증 정책(확정)**: 모든 쓰기 요청은 **`Authorization: Bearer <jwt>` 헤더로 서명된 JWT 토큰**을 보낸다. 서버는 토큰을 **JWT_SECRET(환경변수)** 로 검증해 `userId`를 파생한다. 토큰은 **JWT_EXPIRES(기본 7일)** 후 만료하되 **슬라이딩 갱신**(`POST /auth/refresh`)으로 마지막 활동 기준 연장된다. **비밀번호는 bcrypt 해시로 저장**(평문 비전송). **게스트·회원 듀얼모드**는 런타임에 공존하며 요청 본문의 `password` 유무로 분기한다 — 없으면 `POST /auth/guest`(닉네임만, `passwordHash=null`), 있으면 `POST /auth/register`(신규)|`POST /auth/session`(기존). 게스트 닉네임은 최대 16자·`#` 입력 금지이며 서버가 `#hex4` 식별자를 부여한다. **읽기(피드/스레드/파일 조회)는 선택 인증, 쓰기(글/메시지/세션/인터럽트/투표/북마크)는 JWT 필수.** 남용 방지는 레이트리밋 + 샌드박스 동시 실행 수 제한. **API 키 입력/저장 엔드포인트는 없다(LLM 키는 서버 `.env`).** 전체 구현 차이·KPI 형상은 [IMPLEMENTATION_NOTES.md](./IMPLEMENTATION_NOTES.md) 참조.

| Method · Path | 설명 | 인증 | 비고 |
|---------------|------|------|------|
| `POST /auth/register` | 회원가입(username+password) → User 생성, **`{ id, token, username }` 반환** | - | username 중복 409. bcrypt 해시 저장. **LLM 키 입력/저장 없음(서버 .env).** JWT 서명·반환 |
| `POST /auth/session` | 로그인(username+password) → **`{ id, token, username }`**, 토큰 검증·발급 | - | 실패 401. JWT 서명·반환 |
| `POST /auth/guest` | **게스트 진입**(닉네임만, password 없는 경로) → `passwordHash=null` User, **`{ id, token, username }`** | - | 닉네임 ≤16자·`#` 입력 금지. 서버가 `#hex4` 부여(예 `철수#a3f9`, 충돌 시 재생성) |
| `POST /auth/refresh` | **토큰 슬라이딩 갱신**(유효 Bearer → 새 토큰) | **Bearer** | 마지막 활동 기준 JWT_EXPIRES(기본 7일) 연장. 무효/만료 401. 게스트·회원 공통 |
| `GET /posts?sort=hot&cursor=` | **홈 게시글 피드**(hotScore 정렬, 커서 페이지네이션) | 선택 **Bearer** | sort=hot\|new. 각 카드에 `sandbox.status` 요약 포함. 선택 인증 시 voted/bookmarked 계산 |
| `POST /posts` | **글 작성**(title, body, **(v2) `concurrent?: boolean` 기본 false**) → Post 등록 후 **Sandbox 1:1 자동 생성**(CREATING→READY 비동기), **`{ post, sandbox }`** | **Bearer** | 레이트리밋·샌드박스 동시 생성 수 제한. 커뮤니티 피커/페르소나 없음(§6). **(v2) `concurrent=true`면 `Sandbox.meta.concurrentTurns=true` 저장 → 동시 병렬 협업 opt-in(기본 false=직렬, 생성 시 1회 확정·변경 불가)** |
| `GET /posts/:id` | 게시글 + 메타 조회. `sandbox(status/runtime)`·활성 `session` 요약·`voted`·`bookmarked` 포함 | 선택 **Bearer** | (BYOK/persona 필드 없음) |
| `PATCH /posts/:id` | **글 수정**(title/body, 작성자만) | **Bearer** | 토큰 파생 `userId`로 작성자 검증, 비작성자 403 |
| `GET /posts/:id/messages?afterSeq=` | **버블 페이지네이션 조회** | - | type=HUMAN\|AGENT_REPLY\|TOOL_CALL\|TOOL_RESULT\|SYSTEM, `seq` 오름차순. 연결된 toolCall 요약 포함 |
| `POST /posts/:id/messages` | **사람 메시지 전송**(type=HUMAN). 본문 `{ body, aiMode, clientId }` | **Bearer** | 서버가 `seq` 부여·SSE fan-out 후, `aiMode=true`면 활성 세션에 입력 주입해 에이전트 턴 시작(AGENT_REPLY/TOOL_* 스트리밍은 SSE). `clientId` 멱등(§4.1) |
| `POST /posts/:id/session` | **에이전트 세션 attach/시작** → **`{ session }`** | **Bearer** | READY/SUSPENDED면 pi agent spawn 후 RUNNING 전환, 활성이면 기존 세션 attach. 다중 클라 동일 세션 공유(fan-out)(§5·§6) |
| `POST /posts/:id/interrupt` | **현재 턴 인터럽트/스티어링**(생성 중단). 본문에 선택 `steer` 텍스트 | **Bearer** | session.status=INTERRUPTED, 진행 중 STREAMING 메시지 FAILED/COMPLETE 확정 후 SSE 통지 |
| `POST /posts/:id/session/suspend` | **세션 일시중단**(유휴 해제). pi agent 프로세스 내림, Sandbox=SUSPENDED(디렉토리 보존) | **Bearer** | 작성자/참여자 또는 유휴 타이머가 호출(§6) |
| `GET /posts/:id/files?path=` | **샌드박스 파일 트리 조회**(워크스페이스 패널). 디렉토리 엔트리 목록 | 선택 **Bearer** | `path`는 샌드박스 루트 상대(경로 탈출 차단, 위반 시 400)(§6.3) |
| `GET /posts/:id/files/content?path=` | **샌드박스 단일 파일 내용 조회** | 선택 **Bearer** | path 루트 상대(경로 탈출 400). 바이너리는 메타만/거부, 대용량은 잘라서 반환 |
| `GET /posts/:id/stream` | **SSE 구독**(text/event-stream). 연결 시 `afterSeq` 스냅샷 재생 후 라이브 | 선택 **Bearer** | 에이전트 토큰/도구호출/도구결과/파일변경/세션·샌드박스 상태 fan-out. `Last-Event-ID`(=seq) 재연결 재생(§7) |
| `POST /posts/:id/upvote` | **추천**(멱등 upsert). `{ id, score, hotScore, voted:true }` | **Bearer** | score=Vote count 재계산 + hotScore 갱신 |
| `DELETE /posts/:id/upvote` | **추천 취소**(멱등). `{ id, score, hotScore, voted:false }` | **Bearer** | score=Vote count 재계산 + hotScore 갱신 |
| `POST /posts/:id/bookmark` | **북마크 추가**(idempotent upsert). 201 `{ bookmarked:true }` | **Bearer** | |
| `DELETE /posts/:id/bookmark` | **북마크 제거**(idempotent delete). 200 `{ bookmarked:false }` | **Bearer** | |
| `GET /users/:id/posts?cursor=` | 사용자 작성 글 목록(피드 카드). `{ items, nextCursor }` | - | `post.createdAt desc, id desc`(§4.2) |
| `GET /users/:id/bookmarks?cursor=` | 사용자 북마크 글 목록(피드 카드). `{ items, nextCursor }` | - | 정렬·커서 앵커는 **Bookmark 행** 기준(`bookmark.createdAt desc, bookmark.id desc`)(§4.2) |
| `GET /runtime` | **현재 LLM 런타임/모델 read-only 정보**(model명, baseURL 호스트 표시 가능, **키는 절대 미포함**) | 선택 **Bearer** | Settings의 read-only 표시용(§10·GEMINI 배지 대체) |
| `GET /metrics` | §8 KPI 집계 반환(글당 평균 에이전트 턴 수, 스레드 고유 참여자 수, 세션 성공률 등) | - | BE-13 |

### 4.1 `POST /posts/:id/messages` — 사람 메시지 전송 계약

요청 본문(**키 없음**):
```jsonc
{
  "body": "사람 텍스트",
  "aiMode": true,            // AI on/off 토글 (Composer). true면 전송 후 에이전트 턴 시작
  "clientId": "uuid"         // 멱등키(중복 게시 방지, 네트워크 재시도 안전)
}
```
- 서버는 `type=HUMAN` Message에 **`seq` 부여** 후 즉시 **SSE `message.created` fan-out**(전원 좌/우 버블 즉시 표시).
- `aiMode=true`면 활성 `AgentSession`에 사람 입력을 주입 → 에이전트 턴 시작. `AGENT_REPLY`(PENDING→STREAMING→COMPLETE)·`TOOL_CALL`/`TOOL_RESULT` 버블과 토큰은 모두 **SSE 스트리밍**으로 도착(§7). `aiMode=false`면 사람끼리 채팅만(에이전트 미호출).
- **Δ v2**: 다른 사용자의 턴이 진행 중이어도 이 요청은 **대기 없이 즉시 자기 턴을 시작**한다(병렬 추론, §5.6). `MAX_CONCURRENT_TURNS` 초과 시에만 공정 큐 대기(429 아님). 부수효과(도구·파일)는 §6.4 직렬 lock을 통과.
- 활성 세션이 없는데 `aiMode=true`면 서버가 먼저 세션을 attach/spawn(§5)하거나 `SYSTEM` 버블로 "세션을 시작하세요" 안내.
- `clientId` 멱등: 동일 clientId 재요청은 기존 버블 반환.

### 4.2 프로필 엔드포인트 커서 페이지네이션

부모와 동일한 keyset 커서 패턴(`encodeCursor`/`decodeCursor`, base64url of `createdAtMs + id`)을 공유 유틸(`backend/src/domain/cursor.ts`)로 재사용한다.

**공통 규칙**

| 항목 | 값 |
|------|----|
| 쿼리 파라미터 | `cursor` (선택, 없으면 첫 페이지) |
| 응답 봉투 | `{ items: T[], nextCursor: string \| null }` |
| 페이지 크기 | `PAGE_SIZE`(프로필 전용 상수, 권장 20) |
| 끝 표시 | `nextCursor: null` |
| 잘못된 커서 | **400** |

**`GET /users/:id/posts`**
- 정렬: `post.createdAt DESC, post.id DESC`
- keyset 조건(cursor 있을 때): `(createdAt, id) < (cursorCreatedAt, cursorId)`

**`GET /users/:id/bookmarks`** _(커서 기준이 다름 — 주의)_
- items는 Post 피드 카드이지만 **정렬·커서 앵커는 Bookmark 행** 기준.
- 정렬: `bookmark.createdAt DESC, bookmark.id DESC`(북마크한 시각 최신순)
- `nextCursor`도 마지막 Bookmark 행의 `(createdAt, id)`로 인코딩한다.

> **Δ from Aidit**: 부모의 `GET /users/:id/communities`(생성 커뮤니티 목록)는 **삭제**(커뮤니티 없음). 프로필 탭은 `[ posts | bookmarks ]` 2개.

**클라이언트 타입 (`frontend/src/api/`)**

```ts
// types.ts — 추가
export interface PostsPage { items: Post[]; nextCursor: string | null; }

// rest.ts — 변경 요약
// getUserPosts(userId, cursor?)     → Promise<PostsPage>
// getUserBookmarks(userId, cursor?) → Promise<PostsPage>
```

홈 피드와 동일한 `IntersectionObserver` 센티널 + `usePagedList` 훅 패턴. 프로필 탭 전환 시 해당 탭 첫 활성화 때만 첫 페이지를 lazy 로드, 탭별 독립 커서 유지.

---

## 5. AgentRuntime (pi agent 어댑터)

> **Δ from Aidit**: 부모의 클라이언트 `GeminiClient(BYOK)`를 폐기하고, **서버 측 AgentRuntime 어댑터**가 샌드박스에서 pi agent 프로세스를 띄워 LLM을 호출한다. LLM 키는 서버 `.env`에만, 컨텍스트는 런타임 책임.

### 5.1 책임과 인터페이스

AgentRuntime은 도메인(서비스 레이어)과 pi agent 프로세스 사이의 어댑터다. 인터페이스(개념):

```ts
interface AgentRuntime {
  // 샌드박스에서 pi agent 프로세스 spawn (.env의 LLM 설정 주입)
  spawn(sandbox: Sandbox): Promise<{ pid: number; sessionId: string }>;
  // 기존 세션에 attach(다중 클라 fan-out — 프로세스 재사용)
  attach(session: AgentSession): Promise<void>;
  // 사람 입력을 세션에 주입 → 에이전트 턴 시작. 토큰/툴/파일 이벤트를 콜백으로 스트림
  send(session: AgentSession, input: string, lang: 'ko' | 'en', emit: EmitFn): Promise<void>;
  // 현재 턴 인터럽트(+ 선택 steer 텍스트)
  interrupt(session: AgentSession, steer?: string): Promise<void>;
  // 프로세스 내림(디렉토리 보존)
  suspend(session: AgentSession): Promise<void>;
}

// emit: 런타임이 내보내는 이벤트를 도메인이 받아 Message/ToolCall 영속 + SSE fan-out
type EmitFn = (e: RuntimeEvent) => void; // token / tool.call / tool.output / tool.result / file.changed / status
```

> **Δ v2 — AgentRuntime 인터페이스 계약 변경점**. 실제 PoC 어댑터(`backend/src/agent/pi.ts`)의 시그니처는 위 개념 인터페이스와 달리 `messageId/seq`를 모르고 토큰 delta만 흘린다(turn.ts가 부여). v0.1과 v2의 **계약 차이**는 다음과 같다:
>
> | 메서드 | v0.1 (현재 코드) | v2 (병렬 추론 + 직렬 부수효과) |
> |--------|------------------|-------------------------------|
> | `send(session, input, lang, onToken, onTool, options)` | 같은 샌드박스 동시 호출은 **FIFO 큐로 직렬화**(`pi.ts` `pumpQueue`, pi.ts:119/417). 한 번에 활성 턴 1개. | **즉시 자기 턴을 inflight**으로 띄움(직렬화 안 함). 반환값은 turn 핸들(아래 `turnId`). 동시성 상한 초과 시에만 공정 큐 대기. |
> | (신규) 반환/식별 | 없음(Promise<void>) | 각 호출에 서버가 **`turnId` 부여**. `onToken`/`onTool`/done/error 콜백이 이 turnId에 1:1 귀속(토큰이 어느 `AGENT_REPLY`로 갈지 라우팅). |
> | `ackTool(session, result)` | 단일 resolver(`toolAck`, piWorker.mjs:375)로 되먹임 | **`{callId, turnId}` 라우팅**(Map). 도구 ack가 올바른 턴·올바른 tool_call로 매칭. |
> | `interrupt(session, steer)` | 단일 활성 턴을 중단(`activeTurn=null`, pi.ts:457) | **`turnId` 지정 인터럽트**(내 턴만 중단, 남의 병렬 턴은 무관). steer는 그 턴의 새 입력. |
> | `isBusy(session)` | 활성 턴 ≥1 또는 큐 ≥1 (pi.ts:480) | **활성 턴 수(count) ≥ 1**. 세션 IDLE 전이는 활성 턴이 0이 될 때만(turn.ts:240 패턴 일반화). |
> | (신규) 동시성 상한 | 없음(항상 1턴) | `MAX_CONCURRENT_TURNS`(샌드박스당 동시 inflight 턴 상한). 초과분은 라운드로빈 공정 큐. LLM 비용/부하 제어. |
>
> EmitFn 이벤트 스키마 자체는 불변이나, 모든 이벤트에 **턴 귀속 식별자**가 따라붙는다(서버가 `messageId`로 변환·publish). 새 색/이벤트 타입 추가 없음 — §7의 `agent.token{messageId,…}`이 이미 turn-scoped라 다중 턴 동시 스트리밍을 그대로 표현한다.

### 5.2 OpenAI-compatible LLM 주입

- pi agent는 **OpenAI-compatible** 백엔드로 LLM을 호출한다. 서버 `.env`(세 변수가 단일 출처):
  ```dotenv
  # OpenAI-compatible LLM 설정 — 서버 .env 에만 존재(클라 미노출, 응답/로그/SSE에 절대 미포함)
  BASE_URL="https://models.github.ai/inference"      # OpenAI-compatible 엔드포인트(여기선 GitHub Models)
  MODEL="openai/gpt-4o-mini"                          # 활성 모델명, 공급자 프리픽스 포함 (AgentSession.model 에 기록)
  API_KEY="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # 운영자 키 (GitHub Models는 GitHub PAT `ghp_…`). 실제 값은 커밋 금지
  ```
  > PoC 기본 런타임은 **GitHub Models** OpenAI-compatible 엔드포인트(`https://models.github.ai/inference`)다. 모델명은 **`openai/gpt-4o-mini`** 처럼 공급자 프리픽스를 포함한다. `API_KEY`는 GitHub PAT(`ghp_…`)이며 **실제 키는 문서/코드/로그 어디에도 적지 않는다**(위 값은 자리표시자). 다른 OpenAI-compatible 공급자로 바꾸려면 세 변수(`BASE_URL`/`MODEL`/`API_KEY`)만 교체하면 된다.
- AgentRuntime은 `spawn` 시 이 값들을 **프로세스 환경/설정으로만 주입**(OpenAI 클라이언트의 `baseURL`/`apiKey`/`model`에 매핑)하고, 어떤 응답·로그·SSE 이벤트에도 키를 포함하지 않는다(§8).
- 비용은 **서버 부담**(운영자 키). 남용 방지는 글/메시지 레이트리밋 + 샌드박스 동시 실행 수 제한(§8).
- `GET /runtime`은 model명·baseURL 호스트 정도만 read-only 노출(키 제외).

### 5.3 컨텍스트는 런타임 책임 (요약 엔진 폐기)

- 부모의 **클라이언트 128K 요약 엔진(`contextEngine.ts`)·`ContextSegment`는 폐기**한다.
- 대화 히스토리·요약·도구 결과 누적·컨텍스트 윈도우 관리는 **전적으로 pi agent 런타임**이 자체적으로 수행한다. 서버는 컨텍스트를 보관/조립/요약하지 않는다.
- 서버의 책임은 ① 메시지/이벤트의 SoT(`seq` 부여·순서·멱등), ② SSE fan-out 릴레이, ③ Sandbox/AgentSession 라이프사이클(§6)로 한정한다.
- `resume` 시 파일 상태(샌드박스 디렉토리)는 보존되나 에이전트 인메모리 컨텍스트는 런타임 정책에 따라 재구성된다(pi agent가 결정).

### 5.4 다중 클라이언트 fan-out

- 다중 클라이언트가 동일 세션에 attach해도 **새 프로세스를 띄우지 않고 기존 세션 공유**한다. 에이전트 출력은 **한 번 생성되어** 그 post의 모든 SSE 구독자에게 동일하게 중계된다.
- 샌드박스당 동시 활성 세션(=프로세스)은 **1개 권장**(PoC). ※ '세션 1개'일 뿐 **턴은 직렬이 아니다** — 단일 세션 내에서 사용자 턴이 동시 병렬 추론된다(§5.6). 직렬화는 부수효과뿐(§6.4).
- ~~입력 주입의 순서는 서버가 `seq`/주입 큐로 직렬화한다.~~ → **Δ v2 정정**: 입력(턴)은 더 이상 직렬화하지 않는다. 각 사용자 입력은 즉시 자기 턴으로 inflight(병렬 추론)되며, 단일 convo에는 시작 시 스냅샷 읽기 + 완료 순 직렬 커밋으로 반영된다. **직렬화되는 것은 부수효과(도구 실행·파일 쓰기·컨텍스트 커밋)뿐**(샌드박스 단위 lock, §6.4). `seq`는 여전히 모든 버블의 단조 정렬키이나, 더 이상 입력 게이팅 용도가 아니라 transcript 순서·재생 기준으로만 쓰인다.

### 5.5 i18n 언어 힌트

- 사람 메시지 전송 시 클라 UI 언어(`useLangStore.getState().lang`)를 `send`의 `lang` 인자로 전달 → 런타임이 "가능 범위에서 UI 언어를 따르도록" 시스템 지시(예: `Respond in Korean.`/`Respond in English.`)를 주입한다(§14.5). UGC(코드/파일/사람 발화)는 번역 대상 아님.

### 5.6 Δ v2 — 워커/부모 멀티플렉싱 계약

v0.1 코드는 워커·부모 모두 **전역 단일 상태**를 전제한다. v2는 이를 턴별로 다중화한다(코드 근거 포함):

**워커(`piWorker.mjs`) 멀티플렉싱**
- `currentTurn`(단일, piWorker.mjs:372) → `turns: Map<turnId, Turn>`. 각 턴은 자기 `interrupted` 플래그·`AbortController`(piWorker.mjs:198-199 `streamOneCompletion`의 controller를 턴별로).
- `toolAck`(단일 resolver, piWorker.mjs:375·414-419) → `{callId|turnId}` 키 라우팅(Map). `tool-done` 라인(piWorker.mjs:507-515)이 올바른 턴의 resolver만 깨운다.
- `convo`(단일 mutable, piWorker.mjs:170) → **단일 유지(공유 컨텍스트)**. 각 턴은 시작 시 스냅샷을 읽고, completion/도구결과 push(piWorker.mjs:297·313-343)는 **완료 순 직렬 커밋**으로 `assistant.tool_calls` ↔ `role:tool` 짝 정합을 보존. `capConvo()`(piWorker.mjs:179)는 커밋 직후 1회.
- **제거**: 새 `input`이 이전 턴을 인터럽트하던 동작(piWorker.mjs:519-522) — v2는 동시 다중 턴을 허용하므로 이전 턴을 abort하지 않는다.

**부모(`pi.ts`) 멀티플렉싱**
- `RuntimeHandle.activeTurn`(단일 sink, pi.ts:109) → `Map<turnId, TurnSink>`. `queue`(pi.ts:111)는 동시성 상한 초과분 전용 공정 큐로 의미 축소.
- `pumpTurnLines`(pi.ts:172-216)는 stdout 라인의 `turnId`로 sink 디스패치(현재는 단일 `activeTurn`만 참조, pi.ts:195).
- `send`(pi.ts:399)가 `turnId` 부여, stdin 프로토콜을 `{type:'input', turnId, …}`로 멀티플렉싱(현재 단일, pi.ts:147). `ackTool`(pi.ts:427)·`interrupt`(pi.ts:443)도 `turnId` 라우팅(현재 `tool-done`/`interrupt`에 turnId 없음, pi.ts:432·450).
- exit 핸들러(pi.ts:340-354)는 살아있는 **모든** 턴 sink와 공정 큐를 일괄 error 마감.

---

## 6. 샌드박스 & 세션 라이프사이클 (제품의 심장)

> **Δ from Aidit**: 부모의 "컨텍스트 & 요약 엔진" 자리를 **샌드박스 + 에이전트 세션 라이프사이클**이 대체한다. 게시글당 샌드박스 1:1, 채팅방 = 샌드박스에서 도는 pi agent 세션.

### 6.1 라이프사이클 (SoT)

```
1) create (POST /posts)
   - 글 등록 직후 서버가 샌드박스 디렉토리 1개 생성 → 게시글에 1:1(@unique) 할당. Sandbox=CREATING.
   - 폴더/런타임(pi) 메타 준비 완료 → READY 전환 + sandbox.status SSE 통지. 실패 시 ERROR.
   - 동시 생성 수 제한(운영자 키 비용/리소스 보호) — 초과 시 큐잉 또는 429.

2) ready → attach (POST /posts/:id/session)
   - Thread 진입해 세션 시작/attach. READY/SUSPENDED면 pi agent spawn(.env의 OpenAI-compatible
     apikey/baseURL/model 주입, 키 미노출) → AgentSession(STARTING→IDLE).
   - 이미 활성 세션이 있으면 spawn 없이 기존 세션 attach. 다중 클라 동일 세션 공유(fan-out).
     Sandbox=RUNNING. 컨텍스트/히스토리/요약은 pi agent 런타임이 자체 관리(§5.3).

3) run (POST /posts/:id/messages with aiMode=true)
   - 사람 메시지(HUMAN) seq 부여·SSE fan-out 후, 세션에 입력 주입 → 에이전트 턴 시작. session=RUNNING.
   - 스트리밍: agent.token(AGENT_REPLY 누적), tool.call/tool.output/tool.result(도구 실행),
     file.changed(파일 변경)가 SSE로 전원 중계. 모든 버블은 seq SoT로 정렬.
   - 권한: 샌드박스 내부는 모든 permission 허용(§6.2).
   - **Δ v2**: 여러 사람이 동시에 aiMode=true로 보내면 **N개의 턴이 동시 inflight**(병렬 추론). 각 턴은 자기 AGENT_REPLY(STREAMING)를 가지며 N개 버블이 동시 스트리밍될 수 있다. session=RUNNING은 "활성 턴 ≥1"을 의미하고, 활성 턴이 0이 될 때만 IDLE로 내린다(turn.ts:240 `isBusy` 패턴). 도구·파일 부수효과는 §6.4의 샌드박스 단위 직렬 lock을 통과한다.

4) interrupt / steer (POST /posts/:id/interrupt)
   - 진행 중 턴 중단. session=INTERRUPTED, 진행 중 STREAMING 메시지는 COMPLETE(부분)/FAILED 확정 후 SSE 통지.
     선택 steer 텍스트로 방향 수정.

5) suspend (POST /posts/:id/session/suspend 또는 유휴 타이머)
   - 유휴 시 pi agent 프로세스 내림 + Sandbox=SUSPENDED(디렉토리·파일 보존). 비용/리소스 회수.

6) resume
   - SUSPENDED 샌드박스에 새 attach → 프로세스 재 spawn(디렉토리 그대로) → READY/RUNNING.
     파일 상태 보존, 에이전트 인메모리 컨텍스트는 런타임 정책에 따라 재구성.

7) cleanup
   - 게시글 삭제/장기 미사용 시 프로세스 종료 + 디렉토리 정리. AgentSession.endedAt 기록(이력 보존).
```

**상태 표면**: `Sandbox`(CREATING/READY/RUNNING/SUSPENDED/ERROR)와 `AgentSession`(STARTING/IDLE/RUNNING/INTERRUPTED/STOPPED/ERROR)는 `sandbox.status`/`session.status` SSE 이벤트로 클라 인디케이터에 반영된다(GEMINI 배지 대체, §7·§10).

### 6.2 권한 모델 — 샌드박스 내부는 모든 permission 허용

클라이언트가 코드 에이전트에 붙는 형태이므로, 샌드박스 디렉토리 **내부**에서는 다음을 모두 허용한다:

- 파일 생성/수정/삭제/읽기(FILE_WRITE/FILE_DELETE/FILE_READ)
- 가상환경(venv) 세팅 · 패키지 설치(PACKAGE)
- 쉘 명령 실행(SHELL) · 기타 런타임 도구(OTHER)

### 6.3 격리 경계 — 경로 탈출 차단 + 리소스 + 네트워크

격리 경계는 **샌드박스 디렉토리·리소스·네트워크 정책으로만** 둔다(내부 권한은 제한하지 않음):

- **(a) 경로 탈출 차단**: 파일 트리/내용 API(`GET /posts/:id/files`, `.../content`)와 **FILE_\* 도구 실행**은 `Sandbox.path`를 루트로 한 **상대 경로를 강제**한다. `..` 상위 탈출·심볼릭 링크·절대경로 주입을 정규화(realpath) 후 루트 prefix 검사로 차단. 위반 시 파일 API는 **400**, 도구 실행은 거부.
  - **⚠️ 실측된 한계(2026-07-28, 부록 B)**: 이 가드는 **`FILE_*` 도구의 `relPath` 인자만** 검사한다.
    `SHELL`/`PACKAGE` 의 **명령 문자열 안에 든 경로는 검사 대상이 아니다** — 에이전트가
    `cat ../package.json` 한 줄로 샌드박스 밖 리포 파일을 읽을 수 있음을 컨테이너 PoC 대조 실험에서
    확인했다. 즉 §6.2의 "경계는 경로 탈출뿐"이라는 서술은 **FILE_\* 경로에만 참**이고 셸 경로에는
    서 있지 않다. 셸 인자를 파싱해 막는 것은 (파이프·변수 전개·서브셸 때문에) 신뢰할 수 없으므로
    **정공법은 컨테이너 마운트 범위**다 — 호스트 파일이 파일시스템에 존재조차 하지 않게 만든다.
    측정 결과와 적용할 플래그는 `docs/EXPERIMENTS.md` 부록 B, 하네스는
    `backend/bench/docker-isolation-poc.mjs`(검증 전용, 실코드 미반영).
- **(b) 리소스 제한**: 프로세스/메모리/CPU 상한(PoC는 cgroup-lite). 동시 활성 샌드박스/세션 수 상한.
- **(c) 네트워크 정책**: 아웃바운드 제한(필요 도메인 화이트리스트 등). PoC 수준 정책.
- **(d) ENV 화이트리스트(XC-ENV, 2026-07-28 추가)**: 도구 셸 자식은 **부모 `process.env` 를 상속하지 않는다**.
  `toolExec.sandboxChildEnv()` 가 만든 **허용 목록만** 전달한다(기본 거부).
  - 허용: `PATH`·`HOME`·`LANG`·`LC_ALL`·`TZ`·`TERM`·`USER`·`LOGNAME`·`SHELL`(공통),
    `SystemRoot`·`SystemDrive`·`windir`·`COMSPEC`·`PATHEXT`·`TEMP`·`TMP`·`USERPROFILE`·`HOMEDRIVE`·
    `HOMEPATH`·`APPDATA`·`LOCALAPPDATA`·`NUMBER_OF_PROCESSORS`·`PROCESSOR_ARCHITECTURE`·`OS`(Windows).
  - 주입(상속 아님): `PYTHONIOENCODING=utf-8`·`PYTHONUTF8=1`·`AIDIT_SANDBOX=1`.
  - 운영자 확장: `SANDBOX_ENV_PASSTHROUGH="FOO,BAR"`. 단 `API_KEY`/`BASE_URL`/`DATABASE_URL`/`JWT_SECRET`/
    `OPENAI_API_KEY`/`PI_API_KEY` 및 `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD` 패턴은 **denylist 가
    화이트리스트를 이겨** 절대 통과하지 못한다.
  - **왜 필요한가**: `config.ts` 의 `loadDotenv()` 가 `.env` 를 `process.env` 에 싣기 때문에, 상속을 끊지
    않으면 에이전트가 `echo $API_KEY` 를 실행해 운영자 키를 TOOL_RESULT 버블로 **스레드 참가자 전원에게**
    스트리밍할 수 있었다(§8 위반). 워커(`piWorker.mjs`)는 LLM 호출 주체라 키 주입을 유지하지만 셸을
    띄우지 않으므로, 신뢰 경계는 이 한 지점으로 모인다.
  - 회귀 감시: `backend/test/security/sandboxEnv.test.ts` 가 **실제 셸을 돌려** 자식 ENV 를 덤프하고
    키 값·키 이름 부재와 `PATH` 생존(과잉 차단 방지)을 동시에 단언한다.
- **컨테이너(Firecracker/gVisor/Docker) 강화는 Out of Scope(후속)** — PoC는 호스트 디렉토리 격리 + 프로세스/cgroup-lite로 시작.
  **책임 경계(2026-07-28 확정)**: 컨테이너 격리(`--network none`·read-only 마운트·메모리/CPU 쿼터)와
  CI 파이프라인은 **리포 범위 밖이며 실 서버 배포 시 운영자가 구축**한다. 이 리포는 격리를 흉내내지 않고
  (가짜 제한 금지 — `limits.ts` 주석과 동일 원칙) 위 (a)·(b)·(d)만 보장한다.

### 6.4 Δ v2 — 부수효과 직렬 lock & 동시성 상한

v2에서 **추론은 병렬, 부수효과는 직렬**이다. 직렬 경계를 어디에 두는지가 계약이다:

- **샌드박스 단위 직렬 lock**: 모든 도구 실행(`toolBridge.runToolIntent` → `toolExec.executeTool`, cwd=`sandboxRoot` 단일)을 **턴 간에도** 단일 직렬 큐로 통과시킨다. v0.1은 `turn.ts`의 `toolChain`(턴 **내** 직렬, turn.ts:160-184)만 있어 서로 다른 턴의 도구가 동시 진입할 수 있다 — v2는 이 lock을 **샌드박스 단위**로 끌어올려 턴 간 동시 파일 쓰기 진입을 0으로 만든다. `executeTool`은 이미 `sandboxId`(=`sandboxRoot`) 키로 per-sandbox proc cap을 받으므로(toolBridge.ts:106-109), 같은 키에 직렬 게이트를 추가하는 형태.
- **충돌·머지 불필요**: 두 턴이 같은 파일을 써도 lock으로 순차 적용된다(파일을 머지하지 않고 쓰기를 직렬화). 논리적 결과는 **last-wins**(아래 한계 참조).
- **동시성 상한**: `MAX_CONCURRENT_TURNS`(샌드박스당 동시 inflight 턴 수 상한). LLM 비용/부하 제어용. 초과분은 **라운드로빈 공정 큐**로 대기(pi.ts의 `queue`(pi.ts:111)를 이 용도로 재정의). 단일 활성 세션·단일 샌드박스는 유지.
- **세션 상태**: 단일 IDLE/RUNNING 개념을 **활성 턴 수(count)**로 일반화한다. RUNNING = 활성 턴 ≥1, IDLE 전이 = 활성 턴 0(turn.ts:240의 `isBusy` 가드가 count 기반으로 동작). `session.status` SSE는 동일 enum을 그대로 쓴다(§7).
- **(v2) opt-in 게이트**: 위 병렬 경로(직렬 lock·턴 멀티플렉싱·동시성 상한 포함)는 `Sandbox.meta.concurrentTurns === true`일 때만 활성화된다. `false`(기본)면 런타임이 v0.1 단일 활성 턴 + FIFO 직렬 경로를 그대로 탄다. 플래그는 `POST /posts`의 `concurrent`로 글 생성 시 1회 설정되며 이후 변경 불가 — 따라서 같은 샌드박스 안에서 직렬/병렬이 섞이지 않는다.
- **(v2) 1인 1활성턴(per-user inflight = 1)**: 한 사용자는 동시에 자기 턴 1개만 inflight 한다. 같은 사용자의 다음 입력은 자기 직전 턴이 끝날 때까지 대기(Composer가 '내 활성 턴' 기준으로 게이팅, 인터럽트도 '내 턴' 기준). 병렬은 **서로 다른 사용자** 턴 사이에서만 발생하므로 동시 inflight 턴 수 ≤ 동시 활성 사용자 수이며, `MAX_CONCURRENT_TURNS`와 함께 동시성·비용의 자연 상한이 된다. (turnId↔ownerUserId 매핑은 `send`가 보유; per-user 활성 턴 유무는 isBusy를 userId로 좁혀 판정.)

**알려진 한계(이 섹션 한정, 정직히 명시)**
- **N배 토큰 비용**: 동시 N턴 = N× LLM 토큰(동시성의 본질 비용).
- **convo 캡**: 단일 공유 convo의 길이 캡(piWorker.mjs:179 `N=40`)이 멀티유저로 빠르게 참 → 상향 또는 요약 필요.
- **같은 파일 논리적 레이스**: 직렬 lock은 파일 안전(쓰기 깨짐 방지)을 보장하지만 **논리적 last-wins**는 남는다. 필요 시 "같은 파일을 건드리는 턴만 직렬"로 좁히는 폴백 가능.
- **detached 셸 라이터**: 도구가 띄운 백그라운드/detached 프로세스의 쓰기는 직렬 lock 밖이다 — 프로세스그룹 kill 등 별도 하드닝 대상.
- **convo 스냅샷 staleness**: 동시 발사된 턴들은 서로의 '그 순간' 입력/응답을 못 볼 수 있다(스냅샷 읽기 → 완료 순 커밋이라 수용).

---

## 7. 실시간 (SSE)

> **Δ from Aidit**: 부모의 `comment.*`/`segment.opened` 이벤트를 **에이전트 토큰·도구·파일·세션/샌드박스 상태**로 확장. fan-out·재생 패턴은 계승.

- `GET /posts/:id/stream`: `text/event-stream`. 연결 시 **현재 버블 스냅샷(`afterSeq` 기준) 재생 후 라이브**. 다중 클라가 동일 세션 attach → 에이전트 출력 1회 생성·전원 동일 중계.
- 재연결: `Last-Event-ID`(=마지막 `seq`)로 누락분 재생.
- 다중 인스턴스: Redis pub/sub로 post 채널 fan-out, 또는 SSE sticky 라우팅.

> **Δ v2 — 다중 턴 동시 스트리밍**: 이벤트 스키마는 그대로다. `agent.token`은 이미 `{messageId, seq, delta}`로 **메시지(턴) 단위 귀속**이라, N개의 `AGENT_REPLY` 버블이 동시에 STREAMING 되면 **여러 messageId의 `agent.token`이 인터리브되어 도착**한다(클라는 messageId로 각 버블에 누적). `message.created`(AGENT_REPLY/PENDING)도 턴마다 하나씩 발생하며 `replyToId`로 어느 HUMAN 질문의 답인지 1:1 연결된다. `tool.*`/`file.changed`는 §6.4 직렬 lock 덕에 **순차 도착**(인터리브 없음). `session.status=RUNNING`은 "활성 턴 ≥1", `IDLE`은 "활성 턴 0"을 의미한다(단일 토글이 아니라 카운트 기반).

**이벤트(Foundation realtimeEvents 전재)**

| event | payload | 설명 |
|-------|---------|------|
| `message.created` | `{ message: { id, type, status, body, authorId, seq, replyToId, toolCallId, createdAt } }` | 새 버블 생성. 사람(HUMAN)/에이전트 시작(AGENT_REPLY/PENDING)/도구 호출·결과(TOOL_CALL/TOOL_RESULT)/시스템(SYSTEM). `seq`가 정렬·재생 기준 |
| `agent.token` | `{ messageId, seq, delta }` | 에이전트 답변(AGENT_REPLY) 토큰 스트림. delta를 해당 message.body에 누적(타이핑 효과). 동일 세션 attach 전원에 동일 중계(fan-out) |
| `message.updated` | `{ id, body, status }` | 버블 상태/본문 확정. AGENT_REPLY STREAMING→COMPLETE/FAILED, 또는 인터럽트로 중단된 턴 확정 |
| `tool.call` | `{ toolCallId, messageId, kind, name, args, status:'RUNNING', startedAt }` | 에이전트가 샌드박스에서 도구 호출 시작(쉘/파일/패키지). TOOL_CALL 버블(`$ <cmd>` 풍)로 렌더 |
| `tool.output` | `{ toolCallId, messageId, chunk }` | 도구 실행 중 stdout/stderr 스트리밍 청크. TOOL_RESULT 버블(고정폭 스크롤 컨테이너)에 누적 |
| `tool.result` | `{ toolCallId, messageId, status:'SUCCEEDED'\|'FAILED', exitCode, result }` | 도구 호출 종료. 성공/실패 색으로 확정(성공=기본, 실패=term-red) |
| `file.changed` | `{ path, change:'CREATED'\|'MODIFIED'\|'DELETED', size? }` | 샌드박스 파일 변경 알림. 워크스페이스/파일 트리 패널 갱신(path는 루트 상대) |
| `session.status` | `{ sessionId, status:'STARTING'\|'IDLE'\|'RUNNING'\|'INTERRUPTED'\|'STOPPED'\|'ERROR' }` | 에이전트 세션 상태 변화. 세션 상태 인디케이터 갱신 |
| `sandbox.status` | `{ sandboxId, status:'CREATING'\|'READY'\|'RUNNING'\|'SUSPENDED'\|'ERROR', lastActiveAt }` | 샌드박스 상태 변화. 상태 배지(RUNNING=term-amber 활성, ERROR=term-red, 유휴=term-dim) 갱신 |

---

## 8. 보안 & 프라이버시

> **Δ from Aidit**: 부모의 "키 격리(클라 localStorage + CSP connect-src Google 화이트리스트)" 모델을 폐기하고, **서버 키 비노출 + 임의 코드 격리(샌드박스)** 모델로 교체.

- **서버 키 비노출(최우선)**: LLM `apikey`/`baseURL`은 **서버 `.env`에만** 존재한다. 클라이언트로 전송하지 않고, **서버 응답/로그/SSE 이벤트에 절대 포함하지 않는다**. AgentRuntime이 pi agent 프로세스에 환경으로만 주입한다. `GET /runtime`은 model명·baseURL 호스트 정도만 노출(키 제외). 코드리뷰 체크리스트로 강제.
- **임의 코드 격리(샌드박스)**: 에이전트는 샌드박스 내부에서 임의 코드/쉘을 실행한다. 경계는 ① 경로 탈출 차단(파일 API·도구 실행 모두 루트 상대 강제, `..`/symlink/절대경로 차단), ② 리소스 제한(프로세스/메모리/CPU, PoC는 cgroup-lite), ③ 네트워크 정책(§6.3). 컨테이너 강화는 Out of Scope(후속).
- **레이트/남용**: 운영자 키 비용 보호를 위해 글/메시지 게시 레이트리밋(서버) + **샌드박스 동시 생성/실행 수 제한**. 초과 시 큐잉 또는 429.
- **Δ v2 — 부수효과 직렬 lock(파일 안전 경계)**: 병렬 추론으로 여러 턴이 동시에 도구를 호출해도, 실제 fs/shell 효과는 **샌드박스 단위 단일 직렬 lock**을 통과한다(§6.4). 같은 cwd(`sandboxRoot`)에 lock 없는 동시 쓰기가 발생하지 않아 파일 깨짐·부분 쓰기·디렉토리 레이스를 차단한다. 경로 탈출 가드(§6.3)는 턴 수와 무관하게 모든 도구 실행에 그대로 적용된다. **알려진 갭(정직히 명시)**: 도구가 띄운 detached/백그라운드 프로세스의 쓰기는 직렬 lock 밖이다 — 프로세스그룹 kill·아웃리치 차단 등 별도 하드닝이 필요하다.
- **Δ v2 — 동시성 비용 가드**: 동시 N턴 = N× LLM 토큰이므로 `MAX_CONCURRENT_TURNS`(샌드박스당 동시 inflight 턴 상한)로 비용·부하를 캡한다. 초과분은 공정 큐 대기(429 아님). 키는 어떤 병렬 경로에서도 응답/로그/SSE에 노출되지 않는다(redactSpawnEnv 등 기존 불변식 유지, pi.ts:245).
- **XSS / 사용자 콘텐츠**: 사용자 콘텐츠(글/메시지/터미널 출력)는 렌더 시 escape, 마크다운은 DOMPurify sanitize. **CSP**: `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`. (BYOK가 없으므로 `connect-src` Google 화이트리스트는 **삭제** — connect는 동일 출처 API/SSE만 허용.)
- **인증/권한**: JWT Bearer 검증으로 `userId` 파생(읽기 선택·쓰기 필수). 글 수정은 작성자만(403). 세션 attach/인터럽트는 인증 참여자.
- **프라이버시**: 게스트는 `passwordHash=null`, 키 저장 개념 없음. 샌드박스 디렉토리는 게시글 단위로 격리·정리.

---

## 9. 인기(Hot) 정렬

PoC 공식(Reddit hot 변형, 부모 계승):
```
hotScore = log10(max(score, 1)) + (commentCount * 0.5) / 1.0
           + ageDecay(createdAt)
ageDecay = -(epochHours(now - createdAt)) / 12     // 12h 반감 느낌
```
- `score`는 `Vote` 행 수, `commentCount`는 사람/에이전트 답변(버블) 수. 게시/추천/메시지 시 비정규화 `hotScore` 갱신, `ORDER BY hotScore DESC` + 커서 페이지네이션.
- PoC는 단순 재계산(쓰기 시) → 추후 배치/윈도우.

---

## 10. 프론트엔드 구조

```
src/
 ├─ stores/        authStore(username, token)   ← 키 필드 제거
 │                 threadStore(messages, session, sandboxStatus)
 │                 langStore.ts  (i18n, §14, 부모 계승)
 ├─ api/           rest.ts(서버: 메시지·세션·인터럽트·파일·runtime)   ← gemini.ts 삭제
 ├─ stream/        useThreadStream.ts (EventSource 구독·재생·토큰/툴/파일/상태 핸들)
 ├─ i18n/          dicts/<namespace>.ts, index.ts, useT.ts, tn.ts  (부모 계승)
 ├─ pages/         Home(feed), CreatePost, Thread, Profile(/me), Settings(/me/settings), Login(modal)
 │                 └─ Community / CreateCommunity 삭제
 └─ components/    PostCard, ChatBubble(left/right/agent)
                   ToolCallBubble, ToolResultBubble        ← NEW (TOOL_CALL/TOOL_RESULT)
                   WorkspacePanel(파일 트리/내용)            ← NEW (선택)
                   AgentStatusBadge(READY/RUNNING/ERROR)     ← NEW (GEMINI 배지 대체)
                   Composer(AI on/off 토글), LangToggle
                   └─ PersonaBadge 삭제
```
- **`useThreadStream.ts`** 가 SSE를 구독해 `message.created`/`agent.token`(타이핑 누적)/`message.updated`/`tool.*`/`file.changed`/`session.status`/`sandbox.status`를 `threadStore`에 반영.
- **낙관적 UI**: 사람 메시지 즉시 우측 표시, AGENT_REPLY PENDING placeholder → 토큰 도착 시 누적, TOOL_CALL/TOOL_RESULT 버블은 도착 순(`seq`)대로 삽입.
- **부모 `contextEngine.ts`(엔진 디렉토리) 삭제** — 컨텍스트는 서버/런타임 책임(§5.3).
- i18n 상세는 §14 참조.

---

## 11. 에러 & 상태 매트릭스

> **Δ from Aidit**: BYOK 키 오류(401/403/429) 대신 **세션/런타임/도구 실패** 중심으로 교체.

| 상황 | 사람 메시지 | 에이전트/세션 | UX |
|------|-----------|--------------|-----|
| 샌드박스 생성 실패 | 보존(글은 생성됨) | Sandbox=ERROR | 카드/스레드에 ERROR 배지(term-red) + "샌드박스 재생성" |
| 세션 spawn/attach 실패 | 보존 | session=ERROR, SYSTEM 버블 | "세션 시작 실패 — 재시도" |
| LLM 백엔드 오류(서버 키 무효/쿼터) | 보존 | AGENT_REPLY=FAILED, SYSTEM 버블 | "에이전트 응답 실패"(키는 노출 안 함) + 재시도 |
| 도구 실행 실패(비0 종료) | 보존 | ToolCall=FAILED, TOOL_RESULT 버블 term-red | exitCode·stderr 표시(고정폭) |
| 인터럽트 | 보존 | session=INTERRUPTED, STREAMING→부분 COMPLETE/FAILED | "중단됨" + 선택 steer 반영 |
| 네트워크 실패(메시지 전송) | 멱등 재시도(clientId) | - | 토스트 |
| 경로 탈출 시도(파일 API) | - | - | **400** + "경로 위반" |
| 동시 생성 한도 초과 | 큐잉 또는 **429** | Sandbox=CREATING 대기 | "잠시 후 재시도" |

---

## 12. 테스트 전략 (PoC)

> **Δ from Aidit**: contextEngine/128K 경계 테스트 대신 **AgentRuntime·샌드박스 격리·스트리밍** 중심으로 교체.

- **단위**: `seq` 부여/멱등(clientId), hotScore, **경로 탈출 차단 정규화(`..`/symlink/절대경로 거부)**, AgentRuntime 이벤트→Message/ToolCall 매핑.
- **계약**: REST 멱등(clientId), `POST /posts`→Sandbox 1:1 자동 생성, `/messages`(aiMode on/off) 분기, `/interrupt` 상태 전이, `/files` 루트 상대 강제(400).
- **통합**: 다중 클라 SSE fan-out(토큰/툴/파일/상태 동일 중계), 세션 attach 공유(프로세스 재사용), suspend→resume(디렉토리 보존), **서버 키가 응답/로그/SSE에 절대 노출되지 않음** 회귀 테스트.
- **E2E(여정 매핑)**: J1(글 작성→샌드박스 생성→READY), J2(세션 attach→사람 메시지 aiMode=true→에이전트 턴 스트리밍), J3(도구 호출→터미널 출력 버블→파일 변경→워크스페이스 갱신), J4(인터럽트/스티어링). pi agent/LLM은 모킹·실연동 양면.
- **수동 검증**: 두 브라우저로 같은 스레드 attach — 좌/우 버블·에이전트 토큰·툴 출력·상태 배지 실시간 동일성 확인.

---

## 13. 미해결/후속 결정

- 샌드박스 격리 강화(Firecracker/gVisor/Docker) — PoC는 호스트 디렉토리+cgroup-lite, 컨테이너화는 후속.
- ~~동시 활성 세션 정책(샌드박스당 1개 권장 → 다중 입력자 직렬화 큐 세부) 정교화.~~ → **Δ v2 정정**: 다중 입력자는 더 이상 입력을 직렬화하지 않는다(병렬 추론 + 직렬 부수효과, §5.6·§6.4). 샌드박스당 단일 세션은 유지. 남은 미해결: `MAX_CONCURRENT_TURNS` 임계값 튜닝, 같은 파일 동시 턴의 논리적 레이스 정책(전역 직렬 vs 같은 파일만 직렬 폴백), convo 캡(piWorker.mjs:179) 상향·요약 전략.
- pi agent 런타임의 컨텍스트/요약 정책 튜닝(resume 시 인메모리 컨텍스트 재구성 범위).
- 네트워크 아웃바운드 정책 화이트리스트 범위(패키지 설치 vs 임의 외부 호출).
- 운영자 키 비용 가드(레이트리밋·동시 실행 수)의 임계값 — 사용량 데이터 후 보정.
- ~~모델 ID 확정~~ → **OpenAI-compatible `MODEL`(서버 .env 설정값, PoC 기본 `openai/gpt-4o-mini`)로 운영, `GET /runtime` 노출.**
- ~~localStorage 키 XSS~~ → **BYOK 폐기로 해소.** 키는 서버 .env에만, 클라에 키 없음(§8).
- **로케일 기본값**: 첫 방문 시 `navigator.language`가 `'ko'`로 시작하면 한국어, 아니면 영어. 명시적 선택은 `localStorage('aidit-lang')`에 영구 저장(§14).

---

## 14. 다국어 (i18n)

> SoT: 이 섹션. 지원 로케일: **`ko`(한국어) · `en`(영어)**. 외부 i18n 라이브러리 없음 — 경량 커스텀 구현. URL/라우트 변경 없음(state-based). UGC(글·메시지·사용자명·코드/파일)는 번역 대상 아님 — UI 크롬과 에이전트 언어 힌트만. **부모 Aidit에서 그대로 계승**하되, BYOK 오류 사전(`errors.ko/en`)은 **서버측 에이전트/세션 오류 메시지로 의미 교체**한다.

### 14.1 언어 스토어 (`src/stores/langStore.ts`)

부모와 동일. `authStore.ts`의 `persist + onRehydrateStorage` 패턴을 따른다.

```ts
// src/stores/langStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'ko' | 'en';

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggle: () => void;
}

export const useLangStore = create<LangState>()(
  persist(
    (set, get) => ({
      lang: navigator.language.startsWith('ko') ? 'ko' : 'en',
      setLang: (l) => {
        set({ lang: l });
        document.documentElement.lang = l;
      },
      toggle: () => get().setLang(get().lang === 'ko' ? 'en' : 'ko'),
    }),
    {
      name: 'aidit-lang',
      onRehydrateStorage: () => (state) => {
        if (state) document.documentElement.lang = state.lang;
      },
    }
  )
);
```

- **`name: 'aidit-lang'`** — localStorage 키. 리하이드레이션 즉시 `document.documentElement.lang` 동기화.
- 비 React 코드에서 현재 언어를 읽을 때는 `useLangStore.getState().lang` 사용.

### 14.2 사전 구조 (`src/i18n/`)

```
src/i18n/
 ├─ dicts/
 │   ├─ common.ts      // 범용: 버튼, 레이블, 날짜 포맷 등
 │   ├─ auth.ts        // 로그인/회원가입 화면
 │   ├─ post.ts        // 글 작성·목록·상세(피드)
 │   ├─ thread.ts      // 스레드 채팅 버블·컴포저·도구/터미널/상태 라벨
 │   ├─ profile.ts     // 프로필·설정 화면
 │   └─ errors.ts      // 에이전트/세션/도구/네트워크 오류 메시지  ← BYOK 오류에서 의미 교체
 ├─ index.ts           // DICTS 집계·재수출
 ├─ useT.ts            // React 컴포넌트용 훅
 └─ tn.ts              // 비 React 모듈용 함수
```

> **Δ from Aidit**: `community.ts` 사전 네임스페이스 **삭제**(커뮤니티 없음). `thread.ts`에 도구 호출/터미널 출력/세션·샌드박스 상태 라벨 추가.

**네임스페이스 파일 형태** (예: `thread.ts`):

```ts
// src/i18n/dicts/thread.ts
export const thread = {
  ko: {
    composerPlaceholder: '메시지를 입력하세요…',
    aiToggleOn: 'AI 켜짐',
    aiToggleOff: 'AI 꺼짐',
    agentThinking: '에이전트가 작업 중…',
    sandboxRunning: '실행 중',
    sandboxReady: '준비됨',
    sandboxError: '오류',
    toolRunning: '실행 중…',
  },
  en: {
    composerPlaceholder: 'Type a message…',
    aiToggleOn: 'AI on',
    aiToggleOff: 'AI off',
    agentThinking: 'Agent is working…',
    sandboxRunning: 'Running',
    sandboxReady: 'Ready',
    sandboxError: 'Error',
    toolRunning: 'Running…',
  },
} as const;
```

- 플레이스홀더 보간은 `{name}` `{count}` 스타일. 모든 네임스페이스 객체는 `as const`.

**`src/i18n/index.ts`**:

```ts
import { common } from './dicts/common';
import { auth } from './dicts/auth';
import { post } from './dicts/post';
import { thread } from './dicts/thread';
import { profile } from './dicts/profile';
import { errors } from './dicts/errors';

export const DICTS = { common, auth, post, thread, profile, errors } as const;
export type { Lang } from '../stores/langStore';
```

### 14.3 해석 함수

부모와 동일. `src/i18n/useT.ts`(React 훅)·`src/i18n/tn.ts`(비 React 모듈)는 동일 해석 로직을 공유한다.

```ts
// src/i18n/useT.ts (요약)
export function useT() {
  const lang = useLangStore((s) => s.lang);
  return function t(key: string, vars?: Record<string, string | number>): string {
    const [ns, sub] = key.split(/\.(.+)/);          // 첫 점에서만 분리
    const dict = (DICTS as Record<string, Record<Lang, Record<string, string>>>)[ns];
    const value = dict?.[lang]?.[sub] ?? dict?.['ko']?.[sub] ?? key;  // ko 폴백 → 원시 키
    if (import.meta.env.DEV && value === key) console.warn(`[i18n] missing key: "${key}"`);
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
  };
}
```

- 키 해석 순서: `DICTS[ns][lang][sub]` → `DICTS[ns].ko[sub]`(한국어 폴백) → 원시 키. `t`는 항상 `string` 반환.
- `tn(key, vars?)`은 `useLangStore.getState().lang`로 훅 없이 동일 로직 수행(`stores/`, `api/`, `lib/` 등에서 사용).

### 14.4 `LangToggle` 컴포넌트

부모와 동일한 `[ KO | EN ]` 세그먼트 컨트롤. 활성=`text-term-amber`, 비활성=`text-term-dim hover:text-term-bright`. 헤더·설정 양쪽 배치(`variant='header'|'setting'`), `aria-pressed`로 접근성.

### 14.5 에이전트 언어 연동

> **Δ from Aidit**: 부모는 클라이언트 `contextEngine.ts`에서 `systemInstruction`에 언어 지시문을 삽입했다. 본 프로젝트는 **클라가 UI 언어를 서버에 힌트로 전달**하고, **서버 AgentRuntime이 pi agent에 언어 지시를 주입**한다(컨텍스트/시스템 지시는 런타임 책임, §5.5).

- 클라: `POST /posts/:id/messages` 시 현재 언어를 함께 전달(또는 세션 attach 시 1회). `tn('errors.<key>')`로 클라측 오류 표시.
- 서버: `send(session, input, lang, emit)`에서 `lang === 'en' ? 'Respond in English.' : '반드시 한국어로 답변하세요.'` 지시를 런타임 시스템 메시지로 주입. 단, **에이전트 응답 언어는 "가능 범위에서" UI 언어를 따른다**(코드/명령/파일 내용은 그대로).

### 14.6 오류 메시지 사전 (`src/i18n/dicts/errors.ts`)

> **Δ from Aidit**: 부모의 BYOK 키 오류(invalidKey/quota) 대신 **세션/런타임/도구 오류**로 의미 교체.

```ts
export const errors = {
  ko: {
    sessionFailed: '에이전트 세션 시작에 실패했습니다. 다시 시도하세요.',
    agentFailed:   '에이전트 응답 생성에 실패했습니다.',
    toolFailed:    '도구 실행이 실패했습니다. (종료코드 {code})',
    sandboxError:  '샌드박스 오류 — 재생성이 필요할 수 있습니다.',
    pathDenied:    '샌드박스 경로 밖은 접근할 수 없습니다.',
    rateLimited:   '요청이 많습니다 — 잠시 후 재시도하세요.',
    networkError:  '네트워크 오류 — 재시도 중…',
  },
  en: {
    sessionFailed: 'Failed to start the agent session. Please retry.',
    agentFailed:   'Failed to generate the agent response.',
    toolFailed:    'Tool execution failed. (exit code {code})',
    sandboxError:  'Sandbox error — it may need to be recreated.',
    pathDenied:    'Access outside the sandbox path is not allowed.',
    rateLimited:   'Too many requests — please retry shortly.',
    networkError:  'Network error — retrying…',
  },
} as const;
```

- 서버 LLM 키는 어떤 오류 메시지에도 노출하지 않는다(§8).

### 14.7 날짜·숫자 로케일 · 설계 제약

- 날짜·숫자는 `Intl.DateTimeFormat`/`Intl.NumberFormat`(`lang === 'ko' ? 'ko-KR' : 'en-US'`). `lang`은 `useLangStore` 구독.
- URL/라우트 변경 없음(state-based), UGC 번역 없음, DB 모델 변경 없음, 외부 i18n 라이브러리 미사용, CSR 전용 + `<html lang>` 동기화. 지원 로케일 `ko`/`en` 2개 고정(PoC, 3번째는 `DICTS` 타입 확장).
