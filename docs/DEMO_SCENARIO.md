# Aidit-Code 데모 시나리오 — "게시글 하나 = 살아있는 코드 에이전트 세션"

> 목적: 게시글이 곧 샌드박스 코드 에이전트 세션이 되고, 여러 사용자가 같은 스레드에 붙어
> **함께 코딩을 지시하고, 결과(파일·터미널 출력)를 실시간으로 공유하며, 서로의 작업을 리뷰**하는
> 흐름을 3개 창으로 시연한다. 하이라이트는 ① 멀티유저 SSE 실시간 스트리밍,
> ② 툴콜/터미널 버블(진짜 코드가 실행됨), ③ 라이브 파일 트리,
> ④ **v2 실시간 동시 협업(병렬 추론 + 직렬 부수효과)**, ⑤ 중단/방향조정(steer)이다.
>
> 주의: Aidit(부모 프로젝트)과 달리 **BYOK 없음**(LLM 키는 서버 `.env`만), **페르소나 없음**,
> 라인 코멘트/diff 뷰/문서생성 기능 없음. 시나리오에 넣지 말 것.

---

## 1. 등장인물 & 창 배치

모니터 해상도 **3440×1440 (울트라와이드 1대)** 기준, 가로 3분할:

| 창 | 인물 | 닉네임 | 역할 |
|----|------|--------|------|
| 왼쪽 | **A** | `아라` | 게시글(세션) 개설자 · 작업 지시 |
| 가운데 | **B** | `바다` | 기능 추가 요청자 · 동시 협업 시연 |
| 오른쪽 | **C** | `찬` | 코드 리뷰어 · 테스트 검증자 |

**화면을 꽉 채우는 타일링** — 창을 화면 전체가 아니라 **작업영역(work area)**에 맞춰야 공백이 안 생긴다.
실측(PowerShell `WorkingArea`) 결과 이 PC는 작업표시줄이 **왼쪽 66px**에 있어 작업영역이
`3374×1440 at (66,0)`, 하단엔 작업표시줄이 없다(DPI 100%). 따라서:

- 시작 x = 66, 사용 폭 = 3374, 높이 = **1440(전체)**. (하단 -48을 빼면 오히려 하단에 공백이 생김.)
- 3분할 폭 ≈ 1124. 이웃 창을 **8px씩 겹쳐(FUDGE)** Windows의 보이지 않는 리사이즈 테두리로 생기는
  창 사이 틈을 가린다.
- 자기 환경 값은 런타임에 조회하거나 위 수치를 자기 모니터에 맞게 바꾼다.

| 창 | window-position | window-size |
|----|-----------------|-------------|
| A | `66,0` | `1132,1440` |
| B | `1182,0` | `1140,1440` |
| C | `2306,0` | `1134,1440` |

- 인증 토큰이 localStorage(`aidit-auth`)에만 저장되므로, **별도 `chromium.launch()` 인스턴스 3개**를
  띄우면 자동으로 3명의 독립 게스트가 된다. headed 모드 + `viewport: null` +
  `--window-size/--window-position` 사용.

```ts
// 작업영역을 n분할하고 이웃 창을 fudge만큼 겹쳐 테두리 틈을 가린다.
function tileWindows(x0, w, h, n, fudge) {
  const base = Math.floor(w / n);
  return Array.from({ length: n }, (_, i) => {
    const left = x0 + i * base;
    const width = i === n - 1 ? w - i * base : base;
    return {
      x: Math.max(0, left - (i > 0 ? fudge : 0)),
      w: width + (i > 0 ? fudge : 0) + (i < n - 1 ? fudge : 0),
      h,
    };
  });
}
const TILES = tileWindows(66, 3374, 1440, 3, 8); // 실측 작업영역

// 창 1개 띄우기 (A = TILES[0])
const t = TILES[0];
const browser = await chromium.launch({
  headless: false,
  args: [`--window-position=${t.x},0`, `--window-size=${t.w},${t.h}`],
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
```

## 2. 사전 준비 (녹화 전)

1. 백엔드: `cd backend && npm install && cp .env.example .env && npm run prisma:generate && npm run db:push && npm run dev` (포트 3001).
   - Windows에서 Vite `localhost`→`::1` 불일치를 피하려면 `.env`에 `HOST=::` 권장.
2. 프론트: `cd frontend && npm install && npm run dev` (포트 5173). 접속은 `http://localhost:5173`.
3. **LLM 키 (서버 측)**: `.env`의 `API_KEY`에 실키를 넣으면 실제 에이전트가 동작한다.
   비워두면 **결정적 에코 스텁**이 타이핑 효과로 스트리밍되므로 키 없이도 녹화 리허설이 가능하다
   (`AGENT_TOKEN_DELAY_MS`로 속도 조절). **본 녹화는 실키 권장** — 툴콜/파일 생성이 진짜로 일어나야
   파일 트리·터미널 버블이 살아난다.
4. 재촬영 시 `backend/prisma/dev.db` 리셋 권장 (홈 피드를 깨끗하게).
5. **v2 동시 협업 확인**: 게시글 생성 시 `실시간 동시 협업 (실험적)` 체크박스를 켰을 때 병렬 스트리밍이
   실제로 렌더링되는지 리허설로 확인. (빌드에 따라 병렬 런타임이 게이트되어 있을 수 있음 — 그 경우에도
   `◉ N개 작업 진행 중` 배지와 `↳ @질문자` 귀속 칩 UI는 시연 가능.)

## 3. 시나리오 타임라인

표기: **[AI ON/OFF]** = Composer의 `AI 설정` 팝오버 내 스위치 상태 (기본 ON).
추론 강도는 기본 `중간`, 마지막 종합 리뷰만 `높음`.

### Phase 0 — 게스트 로그인 (3창 동시)

| 창 | 행동 |
|----|------|
| A/B/C | `http://localhost:5173` 접속 → 헤더 `[ 로그인 ]` 클릭 → 모달 하단 게스트 영역에 닉네임(`아라`/`바다`/`찬`) 입력 → `게스트로 시작` |

### Phase 1 — A: 게시글(=샌드박스 세션) 생성

A가 하단 탭 `작성`(`/create`)으로 이동해 입력:

- 제목: `파이썬 유틸 라이브러리 pytest로 같이 만들어요`
- 본문(작업 지시): `순수 파이썬 유틸을 pytest로 TDD하며 같이 만들자. 함수마다 파일을 나눠서(예: palindrome.py + test_palindrome.py) 만들고, 각 단계마다 pytest로 전부 통과하는지 확인하며 진행하자. 웹 서버 말고 로컬에서 바로 돌려볼 수 있는 순수 함수로.`
- `게시 후 AI 1차 답변 받기` 체크 **유지(ON)**, 답변 깊이 `중간`.
- **`실시간 동시 협업 (실험적)` 체크박스 ON** ← v2 병렬 협업의 전제. 생성 시 1회만 설정 가능.
- `[ 게시하기 ]` → `/posts/:id` 도착. 안내 문구("게시하면 이 게시글 전용 샌드박스가 자동 생성…")를
  카메라에 잠깐 보여줄 것.

> **워크로드를 순수 파이썬+pytest로 잡은 이유**: 웹 앱은 "서버가 떴다"까지라 3분할 화면 안에서 실행
> 결과가 안 보인다. 순수 함수 + pytest는 **매 AI 턴이 `pytest` 실행으로 끝나** 터미널 버블에
> `===== N passed =====` 초록 결과가 그대로 뜬다 — "진짜로 돌아가는" 실행 증거가 화면에 남는다.

**연출 포인트**: 샌드박스가 CREATING→READY로 붙고, 1차 AI 답변이 토큰 단위로 스트리밍되며
`▌$ [셸] pip install pytest` · `pytest -q` 툴콜 버블과 터미널 결과 버블(`✓ 실행 완료. [exit 0]` + `N passed`)이 이어진다.

### Phase 2 — B·C: 세션 참여 (실시간 공유 시연)

- B·C는 홈 피드(`인기`/`최신` 탭)에서 A의 게시글 카드를 클릭해 `/posts/:id` 진입.
  (자동화에서는 A의 `page.url()`에서 postId를 추출해 직접 이동해도 됨.)
- **연출 포인트**: A 창에서 스트리밍 중인 에이전트 답변이 B·C 창에도 **동시에** 흘러가는 장면.
  3분할 화면에서 세 창이 같은 토큰 스트림으로 움직이는 것이 이 제품의 첫 번째 "와" 순간이다.

### Phase 3 — 협업 코딩 & 리뷰 대화

각 발화는 Composer(`메시지를 입력하세요…`)에 입력 후 Enter. AI ON 발화는 사람 버블이 붙은 뒤
에이전트 턴(툴콜·터미널·파일 변경 포함)이 스트리밍된다. v2 동시 협업 구간(6~7)을 제외하면
**직전 발화·에이전트 턴이 자기 창에 보인 뒤** 다음 발화를 시작한다.

| # | 창 | AI | 발화 내용 / 행동 |
|---|----|----|------------------|
| 1 | B | **ON**·중간 | `회문(palindrome) 판별 함수 is_palindrome(s)를 palindrome.py에 만들고, test_palindrome.py에 pytest 테스트도 써줘. pytest 돌려서 전부 통과 확인해줘.` → 파일 생성 + `pytest -q` 실행 → `N passed` |
| 2 | C | OFF | `잠깐, 회문 판정에 대소문자랑 공백은 무시해야죠? "A man a plan a canal Panama" 같은 것도 회문으로.` (사람끼리 상의 — AI OFF 시연) |
| 3 | B | OFF | `맞아요, 영숫자만 남기고 소문자로 정규화해서 비교하는 걸로.` |
| 4 | B | **ON**·중간 | `위 논의대로 palindrome.py의 is_palindrome를 대소문자·공백·문장부호 무시하도록 고치고, test_palindrome.py 테스트도 보강해줘. pytest 다시 돌려서 전부 통과 확인.` → 코드 수정 + 테스트 통과 |
| 5 | A | — | 에이전트 턴이 스트리밍되는 동안 **`파일` 탭 클릭** → `palindrome.py`·`test_palindrome.py`가 파일 트리에 뜨고 변경 표시(호박색 점)가 실시간으로 갱신되는 것을 보여줌. 다시 `대화` 탭 복귀 |
| 6 | B | **ON**·중간 | (7과 **거의 동시에 전송** — v2 병렬 협업 시연) `모음 개수를 세는 count_vowels(s) 함수를 vowels.py에 새로 만들고 test_vowels.py도 추가해줘. 기존 palindrome 파일은 그대로 두고. pytest 통과 확인.` |
| 7 | C | **ON**·중간 | (6과 거의 동시에 전송) `지금까지 코드 전체를 리뷰만 해줘(파일 수정 말고) — 놓친 엣지케이스나 빠진 테스트(빈 문자열·대문자·문장부호 등) 지적해줘.` |
| — | 전원 | — | **연출 포인트**: `◉ 2개 작업 진행 중` 배지, `동시 스트리밍 중 (2턴)` 구분선, 각 답변의 `↳ @바다` / `↳ @찬` 귀속 칩. 서로 안 기다리고 답이 병렬로 오는 장면. (7은 리뷰라 파일 미수정 → 6과 부수효과 충돌 없음) |
| 8 | C | **ON**·중간 | `리뷰에서 지적한 빈 문자열·대소문자 엣지케이스부터 test에 추가하고, 통과하도록 고쳐줘. 테스트 문자열은 영문 기준으로만.` |
| 9 | A | — | **중단/방향조정 시연**: 8의 에이전트 턴이 도는 동안 A 창 Composer 위의 steer 입력란(`방향 조정 (선택)…`)에 `숫자나 특수문자 섞인 경우 케이스도 넣어줘` 입력 → `■ 중단` 클릭. 에이전트가 방향을 반영해 재개 |
| 10 | C | **ON**·**높음** | `마지막으로 pytest 전체 다 돌려서 결과 보여줘. 실패하는 테스트가 있으면 구현과 테스트를 일관되게 고쳐서 전부 통과시켜줘(기대값만 바꾸지 말고). 그리고 최종 함수 목록·테스트 구조를 정리해줘.` → 터미널 버블 `✓ 실행 완료. [exit 0]` + `===== N passed =====` (초록)로 마무리 |
| 11 | A | **ON**·중간 | **문서 페이오프**: `지금까지 만든 코드를 정리해서 README.md 파일로 작성해줘 — 함수 목록·사용 예시·pytest 실행법 포함.` → 에이전트가 `README.md`를 실제로 써서 파일 트리에 남김(논의→산출물 응결) |

**엔딩 샷**: 10번의 `===== N passed =====` 초록 터미널 버블 → 11번에서 생성된 `README.md`를 포함해
A 창에서 `파일` 탭으로 전환해 완성된 프로젝트 트리(`utils.py`·`test_utils.py`·`README.md`)를 천천히
보여주고, 스레드를 스크롤하며 마무리.

### 시연 포인트 요약

- **게시글 = 샌드박스 세션**(Phase 1): 게시하는 순간 전용 샌드박스 + 에이전트 1차 답변.
- **실시간 멀티유저 공유**(Phase 2, 5): 한 명의 지시로 생긴 토큰·툴콜·파일 변경이 전원에게 SSE로 전파.
- **AI ON/OFF 협업**(2~4): 사람끼리 설계를 상의(OFF)한 뒤 합의안을 에이전트에 지시(ON) — "협업 코딩".
- **v2 병렬 협업**(6~7): 동시에 물어도 안 기다림. 배지·구분선·질문자 귀속 칩.
- **리뷰 루프**(7~8): 에이전트에게 코드 리뷰를 시키고, 지적사항을 골라 수정 지시 — "리뷰".
- **중단/방향조정**(9): 도는 턴에 개입해 방향을 트는 협업 제어.
- **진짜 실행**(전 구간): `▌$ [셸]` 툴콜 + 터미널 exit 코드 + 라이브 파일 트리.

## 4. Playwright 구현 노트

### 셀렉터 치트시트 (id/data-testid 거의 없음 — role/text/placeholder 사용. 메시지 래퍼엔 `data-msg-id` 있음)

```ts
// 로그인 모달 (헤더 [ 로그인 ] 버튼으로 오픈)
page.getByRole('button', { name: '로그인' })          // 헤더
page.getByPlaceholder('닉네임')                        // 게스트 닉네임 (maxLength 16)
page.getByRole('button', { name: '게스트로 시작' })

// 게시글 작성 (/create — 하단 탭 aria-label '작성')
page.getByPlaceholder('FastAPI 헬스체크 만들어줘')      // 제목
page.getByPlaceholder('/health 라우트 + pytest 추가…') // 본문(작업 지시)
page.getByText('게시 후 AI 1차 답변 받기')              // 체크박스 라벨
page.getByRole('radio', { name: '중간' })              // 추론 강도 낮음/중간/높음
page.getByText('실시간 동시 협업 (실험적)')             // v2 체크박스 → ON
page.getByRole('button', { name: '게시하기' })

// 홈 피드
page.getByRole('tab', { name: '최신' })               // 인기/최신
// 게시글 카드: h2 제목 텍스트로 클릭

// 스레드 (/posts/:id)
page.getByRole('tab', { name: '대화' })               // 워크스페이스 탭
page.getByRole('tab', { name: '파일' })
page.getByText('★ 원본 게시글')
page.getByRole('status')                               // ◉ N개 작업 진행 중 (v2)

// Composer
page.getByPlaceholder('메시지를 입력하세요…')           // Enter=전송, Shift+Enter=줄바꿈
page.getByRole('button', { name: 'AI 설정' })          // [AI] 칩 → 팝오버
page.getByRole('switch')                               // AI 켜짐/꺼짐 (aria-label 동일)
page.getByRole('radio', { name: '높음' })              // 팝오버 내 추론 강도
page.getByRole('button', { name: '보내기' })
// 스트리밍 중 개입 (steer)
page.getByPlaceholder('방향 조정 (선택)…')
page.getByRole('button', { name: '■ 중단' })

// 파일 탭
page.getByText('작업공간')                              // 패널 헤더; 노드는 버튼(파일/폴더명)
```

### 동작 규칙 (스크립트 작성 시 주의)

- **aiMode는 기본 ON**이다. OFF 발화(2, 3)는 전송 전에 팝오버를 열어 스위치를 끄고,
  다음 ON 발화 전에 다시 켠다 (AI ON이면 Composer 테두리가 호박색 — 상태 확인용).
- **자기 턴이 도는 동안은 전송 불가** (`내 답변 진행 중 — 끝나면 보낼 수 있어요`).
  같은 사용자의 연속 발화는 이전 턴 종료를 기다릴 것. 단, v2 동시 협업에서는 **다른** 사용자의
  턴과는 병렬 가능 — 6·7단계는 B와 C가 서로 다른 사용자라 동시 전송이 성립한다.
- 에이전트 턴 종료 대기: AGENT_REPLY 버블의 깜빡이는 커서가 사라지고 텍스트가 안정화될 때까지
  폴링. 툴콜이 섞이면 turn이 길어지므로 타임아웃 넉넉히(120s+).
- 6·7단계 "거의 동시 전송": 오케스트레이터가 B·C 창의 `Promise.all([...])`로 send를 동시 실행.
- 9단계 steer UI는 **턴이 스트리밍 중일 때만** 나타난다. 8단계 전송 직후 A 창에서
  `방향 조정` 입력란 출현을 대기했다가 개입할 것.
- SSE로 실시간 반영되므로 원칙적으로 reload 불필요하나, 세션 끊김 경고(role="alert",
  `세션이 끊겼어요…`)가 뜨면 reload 폴백.

### 3창 동기화 (오케스트레이션)

- **postId 전달**: A 게시 후 `page.url()`에서 `/posts/:id` 추출 → B·C에 전달.
  (연출상 B·C는 홈 피드 카드 클릭으로 진입하는 그림이 더 자연스러움.)
- 턴 순서 보장: 각 발화 전 "직전 발화 텍스트가 내 창에 보이는가"를 대기 조건으로.
- subagent 3개보다 **단일 스크립트에서 3개 browser 인스턴스**를 제어하는 편이 순서·동시성
  제어(특히 6·7의 동시 전송, 9의 타이밍 개입)가 쉽다.
- 녹화 페이스: 발화 사이 2~3초 대기, 타이핑은 `pressSequentially(text, { delay: 25 })`.

### 전체 화면 녹화 자동화 (검증 완료)

오케스트레이션 스크립트가 데모 시작 전 ffmpeg를 스폰하고, 종료 시 stdin에 `q`를 보내
mp4를 정상 finalize한다. `-draw_mouse 0`으로 **마우스 커서는 캡처하지 않는다.**

**인코더 선택(중요)**: 기본은 **gdigrab(GDI 캡처) + libx264**다. GPU 캡처(ddagrab/DXGI)+NVENC가
3440×1440 @ 30fps로 더 매끄럽지만, **녹화를 반복 시작/강제종료하면 DXGI 캡처 세션·NVENC 세션이
꼬여 "인코더 열기 실패"·행이 발생**한다(본 작업 중 실측). gdigrab+libx264는 그 세션 상태에
의존하지 않아 재현성이 높다(대신 ~20fps). 클린한 GPU 상태에서 30fps가 필요하면 아래를 ddagrab+
h264_nvenc로 교체한다.

```ts
import { spawn } from 'node:child_process';

// ① 데모 시작 전 — 녹화 시작 (기본: gdigrab + libx264, 재현성 우선)
const rec = spawn('ffmpeg', [
  '-y',
  '-f', 'gdigrab', '-framerate', '20',
  '-video_size', '3440x1440', '-offset_x', '0', '-offset_y', '0',
  '-draw_mouse', '0', '-i', 'desktop',          // 마우스 숨김
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
  'demo-aidit-code.mp4',
], { stdio: ['pipe', 'ignore', 'ignore'] });
// (GPU 30fps 대안) '-init_hw_device','d3d11va','-filter_complex','ddagrab=framerate=30:draw_mouse=0','-c:v','h264_nvenc','-preset','p4','-cq','19'
await new Promise(r => setTimeout(r, 2000)); // 녹화 안정화 버퍼

// ... 데모 시나리오 실행 ...

// ② 엔딩 샷 후 2~3초 여유 → 녹화 종료
await new Promise(r => setTimeout(r, 3000));
rec.stdin.write('q');                        // kill 금지 — 파일 깨짐
await new Promise(r => rec.on('exit', r));
```

### 실행 순서 요약

1. 백엔드(.env에 실키)·프론트 기동 확인, dev.db 리셋.
2. **녹화 시작**: ffmpeg(gdigrab+libx264, 마우스 숨김) 스폰 + 2초 안정화 대기.
3. 창 3개 launch(위치/크기 지정) → 3창 동시 게스트 로그인 (Phase 0).
4. A: 게시글 생성(동시 협업 ON) → 1차 AI 답변·툴콜 스트리밍 (Phase 1).
5. B·C: 홈 피드에서 스레드 진입, 실시간 스트리밍 공유 확인 (Phase 2).
6. 타임라인 1~10 순차 실행 — 6·7은 동시 전송, 9는 스트리밍 중 개입 (Phase 3).
7. 테스트 전체 통과 터미널 버블 + 파일 트리 엔딩 샷.
8. **녹화 종료**: 3초 여유 후 ffmpeg stdin에 `q` → exit 대기 → mp4 확인.
