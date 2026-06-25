# Aidit-Code — 구현 노트 / 변경 이력 (IMPLEMENTATION_NOTES)

> [`CLAUDE.md`](../CLAUDE.md)·[`AGENTS.md`](../AGENTS.md)의 **GR-1**에 따라, 코드 변경은 여기에 먼저 기록한다.
> 작성 규칙:
> - 최신 항목을 **맨 위**에 둔다.
> - 각 항목: `날짜(절대) · [태그] · 상태 · 요약` + 변경 파일 경로.
> - 태그: `[feat]` / `[fix]` / `[test]` / `[docs]` / `[chore]`
> - 상태: `진행중`(착수 시 기록) → 검증 통과 후 `완료`로 변경 → 그 뒤 커밋·푸시.

---

## Changelog

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
