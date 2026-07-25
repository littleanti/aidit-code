// docs/DEMO_SCENARIO.md 오케스트레이션 스크립트 (Aidit-Code).
// 실행: cd frontend && node e2e/demo-scenario.mjs
// 3440×1440 모니터에 A/B/C 창 3분할 → 게스트 로그인(모달) → 게시글=샌드박스 세션 생성(동시 협업 ON)
// → B·C 참여 → 협업 코딩/리뷰 10턴 → v2 동시 협업 → 중단/방향조정.
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
  body: '순수 파이썬 유틸 라이브러리를 pytest로 TDD하며 같이 만들자. 우선 프로젝트 뼈대(utils.py, test_utils.py)와 pytest 설치·최초 통과 테스트부터. 웹 서버 말고 로컬에서 바로 돌려볼 수 있는 순수 함수로.',
};

// 시나리오 타임라인 1~11 (docs/DEMO_SCENARIO.md §3 Phase 3)
// 순수 파이썬+pytest 워크로드 — 매 AI 턴이 pytest 실행으로 끝나 터미널 버블에 'N passed'가 보인다.
// concurrent: 6·7은 B·C가 거의 동시 전송(병렬 협업).
const TURNS = [
  { n: 1, who: 'B', ai: true, effort: '중간', text: '회문(palindrome) 판별 함수 is_palindrome(s)를 utils.py에 추가하고, test_utils.py에 pytest 테스트도 써줘. pytest 돌려서 통과 확인해줘.' },
  { n: 2, who: 'C', ai: false, text: '잠깐, 회문 판정에 대소문자랑 공백은 무시해야죠? "A man a plan a canal Panama" 같은 것도 회문으로.' },
  { n: 3, who: 'B', ai: false, text: '맞아요, 영숫자만 남기고 소문자로 정규화해서 비교하는 걸로.' },
  { n: 4, who: 'B', ai: true, effort: '중간', text: '위 논의대로 is_palindrome를 대소문자·공백·문장부호 무시하도록 고치고, 그 케이스 테스트도 보강해줘. pytest 다시 돌려줘.' },
  { n: 5, who: 'A', action: 'filesTab' },
  { n: 6, who: 'B', ai: true, effort: '중간', concurrentWith: 7, text: '정수 리스트에서 두 수의 합이 target인 인덱스 쌍을 찾는 two_sum(nums, target) 함수랑 테스트도 추가해줘.' },
  { n: 7, who: 'C', ai: true, effort: '중간', concurrentWith: 6, text: '지금까지 작성된 코드 리뷰해줘 — 놓친 엣지케이스나 빠진 테스트(빈 입력·중복·해 없음 등) 있는지 지적해줘.' },
  // noWait: 완료를 기다리지 않고 다음(turn 9 steer)이 이 턴 스트리밍 중에 개입하도록 둔다.
  { n: 8, who: 'C', ai: true, effort: '중간', noWait: true, text: '리뷰에서 지적한 것 중 "해가 없을 때"랑 "빈 리스트" 엣지케이스부터 테스트 추가하고 고쳐줘.' },
  { n: 9, who: 'A', action: 'steer', steer: '음수랑 중복 값 케이스도 테스트에 넣어줘' },
  { n: 10, who: 'C', ai: true, effort: '높음', text: '마지막으로 pytest 전체 다 돌려서 결과 보여주고, 최종 함수 목록·테스트 구조를 한 번 정리해줘.' },
  // 문서 페이오프: 논의·코드를 산출물(README.md 파일)로 응결 — 엔딩 파일탭에서 노출.
  { n: 11, who: 'A', ai: true, effort: '중간', text: '좋아요. 지금까지 만든 코드를 정리해서 README.md 파일로 작성해줘 — 함수 목록·사용 예시·pytest 실행법 포함.' },
];

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[demo ${ts()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 녹화 ----------
function startRecording() {
  const rec = spawn('ffmpeg', [
    '-y', '-init_hw_device', 'd3d11va',
    '-filter_complex', 'ddagrab=framerate=30:draw_mouse=0',
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '19',
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

async function guestLogin(page, nick) {
  await page.goto(BASE);
  await page.getByRole('button', { name: '로그인' }).first().click();
  const dialog = page.getByRole('dialog', { name: '로그인' });
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  const nickInput = dialog.getByPlaceholder('닉네임');
  await nickInput.click();
  await nickInput.pressSequentially(nick, { delay: 60 });
  await dialog.getByRole('button', { name: '게스트로 시작' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15000 });
}

// 텍스트가 이 창에 보일 때까지 대기 (실시간 SSE 미반영 시 reload 폴백)
async function waitForText(page, text, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  const loc = page.getByText(text).last();
  for (;;) {
    if (await loc.isVisible().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`waitForText timeout: ${text}`);
    await sleep(2500);
    if (await loc.isVisible().catch(() => false)) return;
    await page.reload().catch(() => {});
    await sleep(1500);
  }
}

const agentBubbleCount = (page) => page.getByText('Aidit Agent').count();

// 창을 문서 맨 아래로 스크롤 — 앱은 "하단 근처(pinned)일 때만" 새 답을 따라가므로,
// 데모에선 세 창 모두 능동적으로 하단을 따라가게 해 스트리밍 답이 화면에 보이게 한다.
const followBottom = (page) =>
  page.evaluate(() =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
  ).catch(() => {});
// 세 창 전부 하단 따라가기 — 메인에서 P가 준비된 뒤 주입.
let followAll = async () => {};

// main 텍스트 안정화 대기 (스트리밍/툴콜 종료). 툴콜 사이 공백을 견디도록 4회(≈10s) 연속 안정 요구.
// onPoll: 매 폴링마다 실행(스트리밍 따라 하단 스크롤 등).
async function waitForStable(page, timeoutMs = 300000, onPoll = null) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stable = 0;
  while (stable < 4) {
    if (Date.now() > deadline) { log('  (stabilize timeout — proceeding)'); return; }
    await sleep(2500);
    if (onPoll) await onPoll();
    const txt = await page.locator('main').innerText().catch(() => '');
    if (txt && txt === last) stable += 1;
    else { stable = 0; last = txt; }
  }
}

// 에이전트 턴 완료 대기: 새 AGENT_REPLY 버블 출현 → main 안정화. onPoll 로 하단 스크롤을 따라간다.
async function waitForAgentReply(page, prevCount, timeoutMs = 300000, onPoll = null) {
  const deadline = Date.now() + timeoutMs;
  while ((await agentBubbleCount(page)) <= prevCount) {
    if (Date.now() > deadline) throw new Error('agent bubble did not appear');
    if (onPoll) await onPoll();
    await sleep(1500);
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
  let dialog = await ensureMenuOpen(page);
  const sw = dialog.getByRole('switch');
  const isOn = (await sw.getAttribute('aria-checked')) === 'true';
  if (isOn !== ai) { await sw.click(); await sleep(500); }
  if (ai && effort) {
    dialog = await ensureMenuOpen(page);
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
async function sendMessage(page, text) {
  await typeMessage(page, text);
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
  await sleep(1500);

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
  await sleep(2500);

  // Phase 3 — 타임라인 1~10
  let prevProbe = POST.title.slice(0, 10);
  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    const page = P[turn.who];

    if (turn.action === 'filesTab') {
      log(`turn ${turn.n} (A: files tab showcase)`);
      await P.A.getByRole('tab', { name: '파일' }).click();
      await sleep(4000);
      await P.A.getByRole('tab', { name: '대화' }).click();
      await sleep(1500);
      continue;
    }

    if (turn.action === 'steer') {
      log(`turn ${turn.n} (A: interrupt/steer)`);
      // 직전(turn 8, noWait)의 에이전트 턴이 도는 동안 steer 입력란(agentStreaming)이 A에도 보인다.
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
      // 다음 turn의 waitForText 기준은 확실히 보이는 turn 8 사람 메시지로 둔다(steer는 버블로 안 보일 수 있음).
      const t8 = TURNS.find((x) => x.n === 8);
      if (t8) prevProbe = t8.text.slice(0, 12);
      await sleep(1500);
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
      log(`turns ${turn.n}+${partner.n} (${turn.who}+${partner.who}, concurrent AI)`);
      await waitForText(page, prevProbe);
      const pageB = P[partner.who];
      await setAiState(page, { ai: turn.ai, effort: turn.effort });
      await setAiState(pageB, { ai: partner.ai, effort: partner.effort });
      await typeMessage(page, turn.text);
      await typeMessage(pageB, partner.text);
      const beforeA = await agentBubbleCount(page);
      const beforeB = await agentBubbleCount(pageB);
      await Promise.all([
        page.getByRole('button', { name: '보내기' }).click(),
        pageB.getByRole('button', { name: '보내기' }).click(),
      ]);
      log(`  concurrent turns sent — waiting both replies`);
      await followAll();
      await Promise.all([
        waitForAgentReply(page, beforeA, 300000, followAll).catch((e) => log(`  ${turn.who}: ${e.message}`)),
        waitForAgentReply(pageB, beforeB, 300000, followAll).catch((e) => log(`  ${partner.who}: ${e.message}`)),
      ]);
      prevProbe = turn.text.slice(0, 12);
      await sleep(1500);
      continue;
    }

    log(`turn ${turn.n} (${turn.who}, AI ${turn.ai ? 'ON' : 'OFF'}${turn.effort ? `·${turn.effort}` : ''})`);
    await waitForText(page, prevProbe);
    await sleep(1200);
    const before = turn.ai ? await agentBubbleCount(page) : 0;
    await setAiState(page, { ai: turn.ai, effort: turn.effort });
    await sendMessage(page, turn.text);
    await waitForText(page, turn.text.slice(0, 12), 30000);
    await followAll();
    if (turn.ai && turn.noWait) {
      // 완료를 기다리지 않는다 — 다음 turn(steer)이 이 스트리밍 중 개입한다.
      log(`turn ${turn.n}: sent (noWait — leaving turn streaming for steer)`);
    } else if (turn.ai) {
      log(`turn ${turn.n}: waiting for agent reply...`);
      await waitForAgentReply(page, before, turn.n === 10 ? 360000 : 300000, followAll)
        .catch((e) => log(`  agent wait: ${e.message}`));
      log(`turn ${turn.n}: agent reply done`);
    }
    prevProbe = turn.text.slice(0, 12);
    await sleep(1000);
  }

  // 엔딩 — A 창에서 파일 탭으로 완성 트리 → 대화 스크롤
  log('ending: A files tree + scroll');
  await P.A.getByRole('tab', { name: '파일' }).click();
  await sleep(4000);
  await P.A.getByRole('tab', { name: '대화' }).click();
  await sleep(1500);
  for (let i = 0; i < 12; i++) { await P.A.mouse.wheel(0, -600); await sleep(500); }
  await sleep(3000);

  log('demo complete');
} catch (e) {
  console.error(`[demo ${ts()}] FAILED:`, e);
  process.exitCode = 1;
} finally {
  if (rec) await stopRecording(rec);
  for (const b of browsers) await b.close().catch(() => {});
}
