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

<!-- 새 항목은 이 줄 위에 추가 -->
