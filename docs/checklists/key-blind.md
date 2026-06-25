# Key-Blind Checklist (M7)

> LLM 운영자 키(`API_KEY`/`BASE_URL`/`MODEL`)가 클라이언트·로그·응답·SSE·DB 어디에도
> 노출되지 않음을 보증하기 위한 점검 목록(TRD §2·§8, CLAUDE.md HARD RULES).
> "key-blind" = 시스템 외부 표면 어디서도 운영자 키를 관측할 수 없는 상태.

## 1. 저장(at rest)

- [x] LLM 키는 **서버 `.env`** 에만 존재한다(`backend/.env`). 클라이언트 번들·repo 에 키 없음.
- [x] Prisma 스키마에 키 컬럼이 없다. `User`/`Post`/`Sandbox`/`AgentSession`/`Message`/`ToolCall`
      어떤 모델도 `apiKey`/`baseURL` 류 필드를 갖지 않는다(BYOK 키 저장 개념 전면 제거).
- [x] `AgentSession.model` 만 활성 모델명을 저장한다(키/엔드포인트 아님).
- [x] `Sandbox.meta` 에는 정책 플래그(network/maxProcs)만 기록한다 — 키 없음.

## 2. 설정 표면(config)

- [x] `config.llm.{apiKey,baseURL,model}` 은 서버 내부 전용으로만 읽는다.
- [x] `redactConfig()` 는 `apiKey` 를 항상 `[REDACTED]`/`[EMPTY]` 로 마스킹한다.
      로그/헬스/디버그로 config 를 내보낼 때 반드시 이 함수를 통과시킨다.
- [x] `.env.example` 의 `API_KEY` 는 `REPLACE_ME` 플레이스홀더(실키 미커밋).

## 3. 응답 표면(HTTP)

- [x] `GET /runtime` 은 `{ model, baseURLHost }` 만 반환한다(전체 baseURL/키 미반환).
- [x] 글/메시지/북마크/유저/메트릭 라우트의 응답 직렬화에 키 필드가 애초에 없다
      (행에 키가 없으므로 누출 표면 자체가 부재).
- [x] 에러 응답(§11 매트릭스)에 키/원문 baseURL 을 싣지 않는다(일반 문구만).

## 4. 실시간 표면(SSE)

- [x] `message.*`/`agent.token`/`tool.*`/`file.changed`/`session.status`/`sandbox.status`
      이벤트 payload 에 키 필드 없음.
- [x] `tool.call`/`tool.output`/`tool.result` 의 `args`/`result`/`chunk` 는 명령·경로·출력만 —
      키를 주입하지 않는다(주입은 worker 프로세스 ENV 전용, 출력은 그대로 중계).
- [x] 회귀 테스트가 SSE 스트림 직렬화에 `apiKey|API_KEY|baseURL|BASE_URL|sk-[A-Za-z0-9]`
      패턴이 없음을 단언한다(`toolCall.test.ts`).

## 5. 워커/도구 실행 표면

- [x] LLM 키는 pi worker 프로세스의 **자식 ENV** 로만 주입된다(코드/로그 경로에 평문 미등장).
- [x] 도구 자식(SHELL/PACKAGE)은 `process.env` 를 물려받되 출력 청크에 키를 주입하지 않는다.
- [x] M7 격리 하드닝(타임아웃/proc cap/네트워크 플래그)은 PID·카운터·정책 플래그만 다루며
      키를 참조/출력하지 않는다(`backend/src/sandbox/limits.ts`).

## 6. 로깅

- [x] 키 평문을 로깅하지 않는다. config 로깅은 `redactConfig()` 경유.
- [x] 레이트리밋/격리 거부 로그에 식별자는 `userId`/`ip`/PID 뿐(키/PII 없음).

## 7. 자동 강제(CI 게이트 + 통합 회귀) — XC-REDACT

- [x] **CI grep 게이트**: `npm run keygate` (`backend/scripts/key-grep-gate.mjs`).
      커밋된 소스 트리에서 하드코딩 키 모양 리터럴(`sk-[A-Za-z0-9]{16,}`,
      `gh[opusr]_[A-Za-z0-9]{20,}`, 값이 붙은 `API_KEY=`)을 찾고 발견 시 **exit 1**.
      - 제외: `node_modules`/`.git`/`dist`/`.sandboxes`/`.omc`, `.env`(`.env.example` 은 스캔하되
        플레이스홀더만 허용), 테스트 `SENTINEL` 픽스처, 플레이스홀더(`REPLACE_ME`/`xxxx`/`...`),
        코드 식별자 참조(`rt.apiKey`/`process.env.X`).
      - 현재 트리에서 통과(exit 0). 실제 키를 심으면 검출(self-test 로 확인).
- [x] **SENTINEL 통합 회귀**: `backend/test/security/redaction.test.ts`.
      SENTINEL `API_KEY` 로 앱을 부팅하고 전체 미니 플로우(guest→post→session→aiMode turn→tool)를
      구동한 뒤, SENTINEL 이 `GET /runtime`·`POST /posts`/`/messages` 응답·**모든 SSE 이벤트**·
      `AgentSession` 행·`Message`/`ToolCall` 행·**캡처된 서버 로그**에 나타나지 않음을 단언.
      또한 `GET /runtime` 이 `{ model, baseURLHost }` 만 노출함을 단언.
- [x] **E2E 캡스톤**: `backend/test/e2e.test.ts` 의 J1~J4 여정 전 표면에서도 키 패턴 부재 단언
      + 두 동시 SSE 구독자 fan-out 동등성.

## 검증 메모

- 회귀: `toolCall.test.ts` 의 SSE 키-누출 단언, `runtimeConfig.test.ts`/`runtime.test.ts` 의
  `GET /runtime` 표면 검증, `security/redaction.test.ts` 의 SENTINEL 전수 스캔,
  `e2e.test.ts` 의 엔드투엔드 + fan-out.
- CI: `cd backend && npm run keygate` 를 파이프라인에 추가(소스 하드코딩 키 차단).
- 수동 스모크: `GET /runtime`, `GET /metrics`, 북마크/유저 목록 응답 본문을 grep 으로
  키 패턴 부재 확인.

## 범위 외(정직한 deferred)

- 네트워크 격리 **강제**: `NETWORK_POLICY` 플래그는 meta 에 기록만 — 실제 egress 차단은 미구현
  (컨테이너/방화벽 런타임에서 후속). 키 누출과 무관하나, 격리 완전성 차원의 deferred 항목.
- cgroup/메모리/CPU 쿼터: Windows 이식 불가 → deferred(가짜 제한 미구현).
- **per-file 라이선스 헤더(XC-LICENSE deferred)**: 루트 `LICENSE`(MIT, 2026, holder `Aidit-Code`)만
  추가했다. 동시 진행 중인 다른 레인들이 다수 소스 파일을 편집 중이라, 모든 `*.ts`/`*.mjs`
  상단에 라이선스 헤더를 일괄 삽입하면 머지 충돌 위험이 크다. 헤더 적용은 모든 레인 머지 후
  단일 후속 작업으로 미룬다(키 누출과는 무관 — 순수 라이선스 메타데이터).
