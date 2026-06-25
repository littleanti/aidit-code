# Aidit-Code — 구현 노트 / 변경 이력 (IMPLEMENTATION_NOTES)

> [`CLAUDE.md`](../CLAUDE.md)·[`AGENTS.md`](../AGENTS.md)의 **GR-1**에 따라, 코드 변경은 여기에 먼저 기록한다.
> 작성 규칙:
> - 최신 항목을 **맨 위**에 둔다.
> - 각 항목: `날짜(절대) · [태그] · 상태 · 요약` + 변경 파일 경로.
> - 태그: `[feat]` / `[fix]` / `[test]` / `[docs]` / `[chore]`
> - 상태: `진행중`(착수 시 기록) → 검증 통과 후 `완료`로 변경 → 그 뒤 커밋·푸시.

---

## Changelog

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

<!-- 새 항목은 이 줄 위에 추가 -->
