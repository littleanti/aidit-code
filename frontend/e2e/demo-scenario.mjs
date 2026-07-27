// docs/DEMO_SCENARIO.md 오케스트레이션 스크립트 (Aidit-Code).
// 실행: cd frontend && node e2e/demo-scenario.mjs
// 3440×1440 모니터에 A/B/C 창 3분할 → 게스트 로그인(모달) → 게시글=샌드박스 세션 생성(동시 협업 ON)
// → B·C 참여 → 협업 코딩/리뷰 14턴 → v2 동시 협업(6·7 무충돌, 8·9 같은 파일 동시 수정) → 중단/방향조정.
// ffmpeg(ddagrab+NVENC, draw_mouse=0)로 전체 화면 녹화. 종료는 stdin 'q'.
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';
const OUT_MP4 = 'D:/yoon/codes/Aidit/Aidit-Code/demo-aidit-code.mp4';
const RECORD = process.env.DEMO_NO_RECORD !== '1';

// 실측 작업영역(PowerShell WorkingArea): 3374x1440 at (66,0) — 작업표시줄 왼쪽 66px, 하단 없음, DPI 100%.
const WORK = { x: 66, w: 3374, h: 1440 };
const FUDGE = 8;
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
const TILES = tileWindows(WORK.x, WORK.w, WORK.h, 3, FUDGE);

const USERS = {
  A: { nick: '아라', tile: TILES[0] },
  B: { nick: '바다', tile: TILES[1] },
  C: { nick: '찬', tile: TILES[2] },
};

const POST = {
  title: '파이썬 유틸 라이브러리 pytest로 같이 만들어요',
  body: '순수 파이썬 유틸을 pytest로 TDD하며 같이 만들자. 함수마다 파일을 나눠서(예: palindrome.py + test_palindrome.py) 만들고, 각 단계마다 pytest로 전부 통과하는지 확인하며 진행하자. 웹 서버 말고 로컬에서 바로 돌려볼 수 있는 순수 함수로.',
};

// 시나리오 타임라인 1~11 (docs/DEMO_SCENARIO.md §3 Phase 3)
// 순수 파이썬+pytest 워크로드 — 매 AI 턴이 pytest 실행으로 끝나 터미널 버블에 'N passed'가 보인다.
// 결정적(deterministic) 함수(is_palindrome:bool, count_vowels:int)만 사용하고 함수별로 파일을 분리해,
// AI가 기대값을 틀리거나 파일을 덮어써 함수가 사라지는 일을 없앤다(→ 안정적으로 green).
// concurrent: 6·7은 B·C가 거의 동시 전송(병렬 협업). 7은 리뷰(파일 안 건드림)라 6과 부수효과 충돌 없음.
const TURNS = [
  { n: 1, who: 'B', ai: true, effort: '중간', text: '회문(palindrome) 판별 함수 is_palindrome(s)를 palindrome.py에 만들고, test_palindrome.py에 pytest 테스트도 써줘. pytest 돌려서 전부 통과하는지 확인해줘.' },
  { n: 2, who: 'C', ai: false, text: '잠깐, 회문 판정에 대소문자랑 공백은 무시해야죠? "A man a plan a canal Panama" 같은 것도 회문으로.' },
  { n: 3, who: 'B', ai: false, text: '맞아요, 영숫자만 남기고 소문자로 정규화해서 비교하는 걸로.' },
  { n: 4, who: 'B', ai: true, effort: '중간', text: '위 논의대로 palindrome.py의 is_palindrome를 대소문자·공백·문장부호 무시하도록 고치고, test_palindrome.py 테스트도 보강해줘. pytest 다시 돌려서 전부 통과 확인.' },
  { n: 5, who: 'A', action: 'filesTab' },
  { n: 6, who: 'B', ai: true, effort: '중간', concurrentWith: 7, text: '문자열의 모음(a,e,i,o,u) 개수를 세는 count_vowels(s) 함수를 vowels.py에 새로 만들고, test_vowels.py 테스트도 추가해줘. 기존 palindrome 파일은 그대로 두고. pytest 돌려서 통과 확인.' },
  // 비영문(한글) 회문 테스트는 ASCII 기준 구현과 충돌해 red 루프를 유발하므로 문구에서 배제(결정성).
  { n: 7, who: 'C', ai: true, effort: '중간', concurrentWith: 6, text: '지금까지 작성된 코드 전체를 리뷰만 해줘(파일 수정 말고) — 놓친 엣지케이스나 빠진 테스트(빈 문자열·대문자·문장부호 등) 있는지 지적해줘.' },
  // ── 8·9: 같은 파일(vowels.py) 동시 수정 — XC-SERIAL(직렬 부수효과) 시연 ──────────────
  // 6·7이 '병렬 추론'만 보여줬다면(7은 리뷰라 파일 미수정), 8·9는 두 사용자가 같은 파일을 동시에
  // 고친다. 서버는 도구 실행을 withSandboxLock(sandboxId)으로 감싸므로(backend/src/agent/turn.ts:190)
  // 파일 쓰기는 한 번에 하나만 진입한다 — 툴콜 버블이 겹치지 않고 순차로 찍히는 것이 시각 증거.
  // 한계: write_file 은 파일 전체 덮어쓰기라 read→write 사이 논리적 lost update 는 lock 이 막지 못한다.
  //   그래서 두 발화 모두 'read_file 먼저 + 기존 함수 유지'를 명시하고, turn 10 정합성 턴을 안전망으로 둔다.
  // 공유 파일은 vowels.py 하나로 한정(테스트는 test_vowels.py / test_consonants.py 로 분리).
  { n: 8, who: 'B', ai: true, effort: '중간', concurrentWith: 9, sameFile: 'vowels.py', text: 'vowels.py의 count_vowels가 대문자 모음(A,E,I,O,U)도 세도록 고쳐줘. 먼저 read_file로 vowels.py 현재 내용을 읽고, 파일에 이미 있는 다른 함수는 절대 지우지 말고 그대로 유지한 채 고쳐줘. test_vowels.py에 대문자 케이스도 추가하고 pytest 돌려서 통과 확인.' },
  { n: 9, who: 'C', ai: true, effort: '중간', concurrentWith: 8, sameFile: 'vowels.py', text: '같은 vowels.py 파일에 자음 개수를 세는 count_consonants(s) 함수를 추가해줘. 먼저 read_file로 현재 내용을 읽고, 기존 count_vowels 함수는 그대로 둔 채 아래에 추가만 해줘. 테스트는 test_consonants.py에 따로 만들고 pytest 돌려서 통과 확인.' },
  // 정합성 안전망: 두 동시 수정이 한 파일에 온전히 남았는지 확인·복구(유실 시) — 데모의 수렴 장면.
  { n: 10, who: 'A', ai: true, effort: '중간', text: 'vowels.py 열어서 count_vowels랑 count_consonants 두 함수가 모두 남아있는지 확인해줘. 하나라도 없어졌으면 복구하고, pytest 전체 돌려서 전부 통과시켜줘.' },
  // noWait: 완료를 기다리지 않고 다음(turn 12 steer)이 이 턴 스트리밍 중에 개입하도록 둔다.
  { n: 11, who: 'C', ai: true, effort: '중간', noWait: true, text: '리뷰에서 지적한 빈 문자열·대소문자 엣지케이스부터 test에 추가하고, 통과하도록 고쳐줘. 테스트 문자열은 영문 기준으로만. pytest 전부 통과 확인.' },
  // steer 문구는 결정적으로: 문장부호 섞인 문장('A man, a plan…')은 자음 개수를 사람이 세기 애매해
  //   AI가 틀린 기대값을 넣어 red 루프를 유발한다(take1 실측). 숫자/특수문자만 있는 문자열은 답이 0으로 자명.
  { n: 12, who: 'A', action: 'steer', steerAfter: 11, steer: "'12345'나 '#$%'처럼 숫자·특수문자만 있는 문자열 케이스도 넣어줘" },
  { n: 13, who: 'C', ai: true, effort: '높음', text: '마지막으로 pytest 전체 다 돌려서 결과 보여줘. 실패하는 테스트가 있으면 구현과 테스트를 일관되게 고쳐서 전부 통과시켜줘(기대값만 바꾸지 말고). 그리고 최종 함수 목록·테스트 구조를 한 번 정리해줘.' },
  // 문서 페이오프: 논의·코드를 산출물(README.md 파일)로 응결 — 엔딩 파일탭에서 노출.
  { n: 14, who: 'A', ai: true, effort: '중간', text: '좋아요. 지금까지 만든 코드를 정리해서 README.md 파일로 작성해줘 — 함수 목록·사용 예시·pytest 실행법 포함.' },
];

// 8·9(같은 파일 동시 수정)에서 뒤 발화를 이만큼 늦게 전송한다. 0 = 완전 동시(기본).
// 리허설에서 lost update(한쪽 함수 유실)가 반복되면 1500~3000 정도로 올린다 — 화면상으론 여전히 동시로 보인다.
const SAME_FILE_STAGGER_MS = Number(process.env.SAME_FILE_STAGGER_MS ?? 0);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[demo ${ts()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 페이스 ----------
// 데모가 느려지는 원인은 두 가지였다: ① 턴 종료를 '텍스트가 오래 안 변함'으로 판정(꼬리 10초+),
// ② 카메라용 고정 대기. ①은 아래 배지 신호로 대체하고, ②만 PACE 배율로 조절한다.
const PACE = Number(process.env.DEMO_PACE ?? 0.7); // 카메라 정지 컷 배율(1=원래, 0.5=절반)
const POLL_MS = 500;                                // 상태 폴링 간격
const QUIET_MS = Number(process.env.DEMO_QUIET_MS ?? 1500); // 배지 소멸 후 요구하는 정적 시간
const pause = (ms) => sleep(Math.max(0, Math.round(ms * PACE)));

// ---------- 녹화 ----------
// gdigrab(GDI 캡처) + libx264 를 기본으로 쓴다. GPU 캡처(ddagrab/DXGI)·NVENC 는 캡처를
// 반복 시작/강제종료하면 세션이 꼬여 인코더 열기 실패/행이 생기므로, 캡처 세션 상태에
//의존하지 않는 CPU 경로가 재현성이 높다. `-draw_mouse 0` 로 커서 숨김. framerate 는
// 3440×1440 실시간 인코딩 여유를 위해 20fps(느린 페이스 데모엔 충분). NVENC 를 쓰려면
// 아래 인자를 ddagrab+h264_nvenc 로 교체(단, 클린한 GPU 캡처 상태 필요).
function startRecording() {
  const rec = spawn('ffmpeg', [
    '-y',
    '-f', 'gdigrab', '-framerate', '20',
    '-video_size', '3440x1440', '-offset_x', '0', '-offset_y', '0',
    '-draw_mouse', '0', '-i', 'desktop',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    OUT_MP4,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  rec.stderr.on('data', (d) => { err += d; });
  rec.getErr = () => err;
  return rec;
}
async function stopRecording(rec) {
  await sleep(3000);
  rec.stdin.write('q');
  const code = await new Promise((r) => rec.on('exit', r));
  log(`recording stopped (ffmpeg exit ${code})`);
  if (code !== 0) console.log(rec.getErr().split('\n').slice(-10).join('\n'));
}

// ---------- 공통 헬퍼 ----------
async function launchWindow(tile) {
  const browser = await chromium.launch({
    headless: false,
    args: [`--window-position=${tile.x},0`, `--window-size=${tile.w},${tile.h}`],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  return { browser, page };
}

// 로그인 장면은 데모 도입부라 시청자가 따라올 수 있게 일부러 느리게 간다:
// 홈 첫 화면 → 모달 오픈 → 닉네임 타이핑 → 시작, 단계마다 카메라용 대기를 넣는다.
async function guestLogin(page, nick) {
  await page.goto(BASE);
  await sleep(2000); // 홈 첫 화면을 잠깐 보여준다
  await page.getByRole('button', { name: '로그인' }).first().click();
  const dialog = page.getByRole('dialog', { name: '로그인' });
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await sleep(2000); // 로그인 모달을 카메라에 보여준다
  const nickInput = dialog.getByPlaceholder('닉네임');
  await nickInput.click();
  await nickInput.pressSequentially(nick, { delay: 250 });
  await sleep(1500); // 입력된 닉네임 확인 컷
  await dialog.getByRole('button', { name: '게스트로 시작' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 });
  await sleep(1500); // 로그인 완료 상태(헤더 닉네임)를 보여준다
}

// 텍스트가 이 창에 보일 때까지 대기 (실시간 SSE 미반영 시 reload 폴백)
async function waitForText(page, text, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  const loc = page.getByText(text).last();
  let waited = 0;
  for (;;) {
    if (await loc.isVisible().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`waitForText timeout: ${text}`);
    await sleep(800);
    waited += 800;
    // SSE 로 곧 도착하는 게 보통이므로 성급히 reload 하지 않는다(8초 넘게 안 오면 폴백).
    if (waited >= 8000) {
      waited = 0;
      await page.reload().catch(() => {});
      await sleep(1200);
    }
  }
}

const agentBubbleCount = (page) => page.getByText('Aidit Agent').count();
// LLM 일시 오류로 턴이 실패하면 서버가 이 시스템 버블을 남긴다(빈 AGENT_REPLY + 안내).
//   take1의 turn 1이 여기 걸렸다 — 발화 후 이 버블이 새로 늘었으면 같은 발화를 1회 재전송한다.
const failBubbleCount = (page) => page.getByText('에이전트 응답 실패').count();

// 창을 문서 맨 아래로 스크롤 — 앱은 "하단 근처(pinned)일 때만" 새 답을 따라가므로,
// 데모에선 세 창 모두 능동적으로 하단을 따라가게 해 스트리밍 답이 화면에 보이게 한다.
const followBottom = (page) =>
  page.evaluate(() =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
  ).catch(() => {});
// 세 창 전부 하단 따라가기 — 메인에서 P가 준비된 뒤 주입.
let followAll = async () => {};

// 이 스레드에 도는 턴이 있는지 — Thread.tsx 의 `◉ N개 작업 진행 중` 배지(role=status, activeTurns≥1).
//   SSE 로 모든 창에 실시간 반영되므로, 어느 창에서 봐도 '지금 에이전트가 일하는 중'을 정확히 알려준다.
const anyTurnActive = (page) =>
  page.getByText('작업 진행 중').first().isVisible().catch(() => false);

// 턴 종료 대기. 예전에는 main 텍스트가 10초간 안 변하는 것으로 판정했는데(툴콜 사이 공백을 견디려는 값),
//   그 탓에 매 턴 12초 넘는 죽은 꼬리가 붙었다. 이제는 배지가 사라진 뒤 짧은 정적(QUIET_MS)만 확인한다 —
//   툴콜 중에는 배지가 켜져 있으므로 조기 종료 위험 없이 대기를 1/6 수준으로 줄일 수 있다.
// onPoll: 매 폴링마다 실행(스트리밍 따라 하단 스크롤 등).
async function waitForStable(page, timeoutMs = 300000, onPoll = null) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let quietSince = null;
  for (;;) {
    if (Date.now() > deadline) { log('  (stabilize timeout — proceeding)'); return; }
    await sleep(POLL_MS);
    if (onPoll) await onPoll();
    if (await anyTurnActive(page)) { quietSince = null; continue; } // 아직 도는 턴이 있다
    const txt = await page.locator('main').innerText().catch(() => '');
    if (txt && txt === last) {
      if (quietSince == null) quietSince = Date.now();
      if (Date.now() - quietSince >= QUIET_MS) return;
    } else {
      last = txt;
      quietSince = null;
    }
  }
}

// 에이전트 턴 완료 대기: 새 AGENT_REPLY 버블 출현 → main 안정화. onPoll 로 하단 스크롤을 따라간다.
async function waitForAgentReply(page, prevCount, timeoutMs = 300000, onPoll = null) {
  const deadline = Date.now() + timeoutMs;
  while ((await agentBubbleCount(page)) <= prevCount) {
    if (Date.now() > deadline) throw new Error('agent bubble did not appear');
    if (onPoll) await onPoll();
    await sleep(POLL_MS);
  }
  await waitForStable(page, deadline - Date.now(), onPoll);
}

// Composer AI 팝오버 상태 세팅 (스위치/추론강도). 팝오버는 선택 직후 닫힐 수 있어 매번 재오픈.
async function ensureMenuOpen(page) {
  const dialog = page.getByRole('dialog', { name: 'AI 설정' });
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'AI 설정' }).click();
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await sleep(500);
  }
  return dialog;
}
async function setAiState(page, { ai, effort }) {
  // 스위치를 목표 상태로 맞추되, 토글 후 실제 aria-checked 를 재확인해 어긋나면 재시도한다.
  //   (AI-OFF 발화가 실수로 ON 으로 남으면 그 사용자의 다음 발화 전송이 잠겨 데모가 멈춘다 —
  //    turn 3(B,OFF)→turn 4(B) 전송 disabled 타임아웃의 근본 원인.)
  for (let attempt = 0; attempt < 3; attempt++) {
    const dialog = await ensureMenuOpen(page);
    const sw = dialog.getByRole('switch');
    const isOn = (await sw.getAttribute('aria-checked').catch(() => null)) === 'true';
    if (isOn === ai) break;
    await sw.click();
    await sleep(500);
    const nowOn = (await sw.getAttribute('aria-checked').catch(() => null)) === 'true';
    if (nowOn === ai) break;
  }
  if (ai && effort) {
    const dialog = await ensureMenuOpen(page);
    await dialog.getByRole('radio', { name: effort }).click();
    await sleep(500);
  }
  if (await page.getByRole('dialog', { name: 'AI 설정' }).isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await sleep(300);
  }
}

async function typeMessage(page, text) {
  const box = page.getByPlaceholder('메시지를 입력하세요…');
  await box.click();
  await box.pressSequentially(text, { delay: 16 });
  await sleep(300);
}
// 보내기 버튼이 활성화될 때까지 대기 — 직전(같은 사용자) 턴 스트리밍이 마무리돼 전송 잠금이
// 풀리기를 기다린다. disabled 상태 클릭 재시도 타임아웃(30s)으로 실패하는 대신 명시적으로 대기.
async function waitSendEnabled(page, timeoutMs = 120000) {
  const btn = page.getByRole('button', { name: '보내기' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await btn.isEnabled().catch(() => false)) return true;
    await sleep(500);
  }
  return false;
}
// 그 창 사용자의 활성 턴이 끝날 때까지 대기.
//   Composer 는 '내 턴' 게이팅(self-concurrency=1) 동안 role=status 안내를 띄운다(thread.myTurnBusy).
//   이 문구가 사라지면 그 사용자의 턴이 실제로 종료된 것 — 화면 텍스트 안정화보다 정확하고,
//   빈 입력창에서는 항상 disabled 인 '보내기' 버튼 상태보다 신뢰할 수 있다(take2 4분 헛대기 원인).
async function waitMyTurnIdle(page, timeoutMs = 240000) {
  const busy = page.getByText('내 답변 진행 중');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await busy.isVisible().catch(() => false))) return true;
    await sleep(1000);
  }
  return false;
}
async function sendMessage(page, text) {
  await typeMessage(page, text);
  await waitSendEnabled(page);
  await page.getByRole('button', { name: '보내기' }).click();
}

// ---------- 메인 ----------
const rec = RECORD ? startRecording() : null;
if (rec) { log('recording started'); await sleep(2000); }

let browsers = [];
try {
  // Phase 0 — 창 3개 + 게스트 로그인
  log('Phase 0: launching windows');
  const [wA, wB, wC] = await Promise.all([
    launchWindow(USERS.A.tile), launchWindow(USERS.B.tile), launchWindow(USERS.C.tile),
  ]);
  browsers = [wA.browser, wB.browser, wC.browser];
  const P = { A: wA.page, B: wB.page, C: wC.page };
  // 세 창 모두 하단 따라가기 (스트리밍 답이 모든 창에서 보이도록).
  followAll = async () => { await Promise.all([followBottom(P.A), followBottom(P.B), followBottom(P.C)]); };

  log('Phase 0: guest logins');
  await Promise.all([
    guestLogin(P.A, USERS.A.nick),
    guestLogin(P.B, USERS.B.nick),
    guestLogin(P.C, USERS.C.nick),
  ]);
  await pause(1500);

  // Phase 1 — A: 게시글(=샌드박스 세션) 생성, 동시 협업 ON
  log('Phase 1: A creates post (concurrent ON)');
  await P.A.goto(`${BASE}/create`);
  const title = P.A.getByPlaceholder('FastAPI 헬스체크 만들어줘');
  await title.click();
  await title.pressSequentially(POST.title, { delay: 35 });
  const body = P.A.getByPlaceholder('/health 라우트 + pytest 추가…');
  await body.click();
  await body.pressSequentially(POST.body, { delay: 18 });
  // 첫 AI 1차 답변 체크박스는 기본 ON 유지, 추론강도 중간(기본). 동시 협업만 ON.
  const concurrent = P.A.getByRole('checkbox', { name: '실시간 동시 협업 (실험적)' });
  if (!(await concurrent.isChecked())) await concurrent.check();
  await sleep(800);
  await P.A.getByRole('button', { name: '게시하기' }).click();
  await P.A.waitForURL(/\/posts\//, { timeout: 30000 });
  const postUrl = P.A.url();
  log(`post created: ${postUrl}`);

  // 1차 AI 답변 스트리밍을 A 창에서 잠깐 감상 (하단 따라가기)
  await waitForAgentReply(P.A, 0, 300000, () => followBottom(P.A)).catch((e) => log(`  first-reply wait: ${e.message}`));

  // Phase 2 — B·C 세션 참여
  log('Phase 2: B, C join session');
  await Promise.all([P.B.goto(postUrl), P.C.goto(postUrl)]);
  // 1차 답변 직후 곧바로 다음 LLM 호출이 붙으면 일시 오류가 나기 쉽다(take1 turn 1 FAILED) — 여유를 둔다.
  await pause(6000);

  // Phase 3 — 타임라인 1~10
  let prevProbe = POST.title.slice(0, 10);
  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    const page = P[turn.who];

    if (turn.action === 'filesTab') {
      log(`turn ${turn.n} (A: files tab showcase)`);
      await P.A.getByRole('tab', { name: '파일' }).click();
      await pause(4000);
      await P.A.getByRole('tab', { name: '대화' }).click();
      await pause(1500);
      continue;
    }

    if (turn.action === 'steer') {
      log(`turn ${turn.n} (A: interrupt/steer)`);
      // 직전(steerAfter, noWait)의 에이전트 턴이 도는 동안 steer 입력란(agentStreaming)이 A에도 보인다.
      const steerBox = P.A.getByPlaceholder('방향 조정 (선택)…');
      try {
        await steerBox.waitFor({ state: 'visible', timeout: 30000 });
        await steerBox.click();
        await steerBox.pressSequentially(turn.steer, { delay: 25 });
        await sleep(600);
        await P.A.getByRole('button', { name: '중단' }).click();
        log('  steer sent — waiting steered turn to finish');
      } catch (e) {
        log(`  steer skipped (no running turn visible): ${e.message}`);
      }
      // 개입된 턴이 마무리될 때까지 대기 후 다음으로 (하단 따라가기).
      await waitForStable(P.A, 180000, followAll);
      // take1 결함: A 창 텍스트 안정화만 보고 통과해 버렸는데, steer 된 사용자의 턴은 그 뒤로도
      //   툴콜을 계속 돌고 있었다(약 1분 더). 그 상태로 같은 사용자의 다음 발화를 보내면 턴이
      //   붙지 않고(SYSTEM '세션을 시작하세요') 최종 green 정리 턴이 통째로 사라진다.
      //   → steer 대상 사용자 창의 '보내기'가 다시 활성화될 때까지(=그 사용자의 활성 턴 종료) 기다린다.
      const steered = TURNS.find((x) => x.n === turn.steerAfter);
      if (steered) {
        const ok = await waitMyTurnIdle(P[steered.who], 240000);
        log(`  steered turn (${steered.who}) finished: idle=${ok}`);
        await followAll();
      }
      // 다음 turn의 waitForText 기준은 확실히 보이는 직전(steerAfter) 사람 메시지로 둔다(steer는 버블로 안 보일 수 있음).
      const prior = TURNS.find((x) => x.n === turn.steerAfter);
      if (prior) prevProbe = prior.text.slice(0, 12);
      await pause(1500);
      continue;
    }

    // 일반 발화
    if (turn.concurrentWith && turn.n > turn.concurrentWith) {
      // 짝(6,7) 중 뒤 항목은 앞에서 함께 처리했으므로 건너뜀
      continue;
    }

    if (turn.concurrentWith) {
      // v2 동시 협업: 짝을 이루는 두 발화를 거의 동시에 전송
      const partner = TURNS.find((x) => x.n === turn.concurrentWith);
      log(`turns ${turn.n}+${partner.n} (${turn.who}+${partner.who}, concurrent AI${turn.sameFile ? ` — same file ${turn.sameFile}` : ''})`);
      await waitForText(page, prevProbe);
      const pageB = P[partner.who];
      await setAiState(page, { ai: turn.ai, effort: turn.effort });
      await setAiState(pageB, { ai: partner.ai, effort: partner.effort });
      await typeMessage(page, turn.text);
      await typeMessage(pageB, partner.text);
      // 직전 턴의 툴콜이 아직 돌고 있으면 전송이 잠겨 있다 — 두 창 모두 활성화될 때까지 기다린다.
      await Promise.all([waitSendEnabled(page, 180000), waitSendEnabled(pageB, 180000)]);
      const beforeA = await agentBubbleCount(page);
      const beforeB = await agentBubbleCount(pageB);
      // 같은 파일을 건드리는 짝(sameFile)이면 뒤 발화를 조금 늦춰 lost update 확률을 낮춘다(기본 0 = 완전 동시).
      const stagger = turn.sameFile ? SAME_FILE_STAGGER_MS : 0;
      await Promise.all([
        page.getByRole('button', { name: '보내기' }).click(),
        (async () => {
          if (stagger > 0) await sleep(stagger);
          await pageB.getByRole('button', { name: '보내기' }).click();
        })(),
      ]);
      log(`  concurrent turns sent — waiting both replies`);
      await followAll();
      // 같은 파일 동시 수정 구간에서는 A 창을 '파일' 탭으로 두어 vowels.py 변경 표시가
      // 두 턴에 걸쳐 연달아 갱신되는 것을 카메라에 남긴다(직렬 부수효과의 시각 증거).
      if (turn.sameFile) {
        await P.A.getByRole('tab', { name: '파일' }).click().catch(() => {});
        await pause(1200);
      }
      await Promise.all([
        waitForAgentReply(page, beforeA, 300000, followAll).catch((e) => log(`  ${turn.who}: ${e.message}`)),
        waitForAgentReply(pageB, beforeB, 300000, followAll).catch((e) => log(`  ${partner.who}: ${e.message}`)),
      ]);
      if (turn.sameFile) {
        await pause(2000);
        await P.A.getByRole('tab', { name: '대화' }).click().catch(() => {});
        await pause(1500);
      }
      prevProbe = turn.text.slice(0, 12);
      await pause(1500);
      continue;
    }

    log(`turn ${turn.n} (${turn.who}, AI ${turn.ai ? 'ON' : 'OFF'}${turn.effort ? `·${turn.effort}` : ''})`);
    await waitForText(page, prevProbe);
    await pause(1200);
    const before = turn.ai ? await agentBubbleCount(page) : 0;
    const failBefore = turn.ai ? await failBubbleCount(page) : 0;
    await setAiState(page, { ai: turn.ai, effort: turn.effort });
    await sendMessage(page, turn.text);
    await waitForText(page, turn.text.slice(0, 12), 30000);
    await followAll();
    if (turn.ai && turn.noWait) {
      // 완료를 기다리지 않는다 — 다음 turn(steer)이 이 스트리밍 중 개입한다.
      log(`turn ${turn.n}: sent (noWait — leaving turn streaming for steer)`);
    } else if (turn.ai) {
      log(`turn ${turn.n}: waiting for agent reply...`);
      await waitForAgentReply(page, before, turn.n === 13 ? 360000 : 300000, followAll)
        .catch((e) => log(`  agent wait: ${e.message}`));
      // LLM 일시 오류(FAILED·빈 답변)면 같은 발화를 1회만 재전송한다 — take1의 turn 1 결함 대응.
      if ((await failBubbleCount(page)) > failBefore) {
        log(`turn ${turn.n}: agent FAILED — retrying once`);
        const retryBefore = await agentBubbleCount(page);
        await setAiState(page, { ai: true, effort: turn.effort });
        await sendMessage(page, turn.text);
        await followAll();
        await waitForAgentReply(page, retryBefore, 300000, followAll)
          .catch((e) => log(`  retry wait: ${e.message}`));
      }
      log(`turn ${turn.n}: agent reply done`);
    }
    prevProbe = turn.text.slice(0, 12);
    await pause(1000);
  }

  // 엔딩 — A 창에서 파일 탭으로 완성 트리 → 대화 스크롤
  log('ending: A files tree + scroll');
  await P.A.getByRole('tab', { name: '파일' }).click();
  await pause(4000);
  await P.A.getByRole('tab', { name: '대화' }).click();
  await pause(1500);
  for (let i = 0; i < 12; i++) { await P.A.mouse.wheel(0, -600); await sleep(500); }
  await pause(3000);

  log('demo complete');
} catch (e) {
  console.error(`[demo ${ts()}] FAILED:`, e);
  process.exitCode = 1;
} finally {
  if (rec) await stopRecording(rec);
  for (const b of browsers) await b.close().catch(() => {});
}
