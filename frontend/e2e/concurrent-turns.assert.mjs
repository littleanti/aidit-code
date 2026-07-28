// frontend/e2e/concurrent-turns.assert.mjs
// FE-MULTI 단언형 E2E — v2 핵심 주장을 **실제 브라우저 DOM에서** 검증한다.
//
// 기존 `demo-scenario.mjs` 와의 차이: 그것은 **녹화 스크립트**로, 단언이 하나도 없어 화면이
//   조용히 망가져도 통과한다. 이 파일은 실패 시 **exit 1** 로 끝나는 검증 스크립트다.
//
// 단언(v2 계약이 화면에 실제로 나타나는가):
//   ① 멀티유저 fan-out — 두 브라우저 모두 양쪽 HUMAN 버블을 본다
//   ② 동시 활성 턴 — 서버 권위값(activeTurns)이 2 에 도달하고 배지가 그것을 표시한다
//   ③ 스트림 겹침 — 두 AGENT_REPLY 가 **동시에** 본문을 늘려간다(직렬이면 불가능)
//   ④ 1:1 귀속 — 각 답글에 `↳ @질문자` 라벨이 붙고 서로 다른 사람을 가리킨다(배칭 없음)
//   ⑤ 두 턴 모두 정상 종료
//
// 결정성(flaky 방지 설계):
//   - LLM 은 모의 서버(지연 주입)만 쓴다. 실 LLM 은 지터 때문에 겹침 판정이 불안정해진다.
//   - 인증/게시글 생성/메시지 전송은 **API** 로 한다. Composer 의 AI 토글은 이전 데모 촬영에서
//     aria-checked 재시도가 필요했던 flaky 지점이라, 검증 대상(SSE→스토어→렌더링·귀속)과
//     무관한 위험을 테스트에 들이지 않는다. 검증은 전부 **실제 DOM** 에서 한다.
//
// 실행: cd frontend && npm run e2e:concurrent

import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const backendRoot = path.resolve(frontendRoot, '..', 'backend');

const MOCK_PORT = 8098;
const API_PORT = 3098;
const WEB_PORT = 5199;
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let failures = 0;

function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function start(label, cmd, args, env, cwd) {
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  p.stdout.on('data', (d) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${label}] ${d}`);
  });
  p.stderr.on('data', (d) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(`[${label}] ${d}`);
  });
  procs.push(p);
  return p;
}

async function killAll() {
  for (const p of procs) {
    if (!p.pid) continue;
    if (process.platform === 'win32') {
      await new Promise((r) => {
        const tk = spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
        tk.on('close', r);
        tk.on('error', r);
      });
    } else {
      try {
        p.kill('SIGTERM');
      } catch {
        /* noop */
      }
    }
  }
}

async function waitUrl(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* 아직 */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await sleep(400);
  }
}

// ── API 헬퍼 ──
async function guest(nickname) {
  const r = await fetch(`${API}/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!r.ok) throw new Error(`guest failed ${r.status}`);
  return r.json();
}

async function createPost(token) {
  const r = await fetch(`${API}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: 'FE-MULTI 단언 E2E',
      body: '동시 병렬 협업 검증용 세션',
      autoReply: false,
      reasoningEffort: 'low',
      // v2 opt-in. E2E_CONCURRENT=0 이면 직렬(v0.1) 계약으로 만들어 **이 테스트가 실제로 차이를
      // 분별하는지** 검증하는 음성 대조군이 된다(위양성 방지 — 직렬에서는 단언이 실패해야 정상).
      concurrent: process.env.E2E_CONCURRENT !== '0',
    }),
  });
  if (!r.ok) throw new Error(`createPost failed ${r.status} ${await r.text()}`);
  return r.json();
}

async function waitReady(token, postId) {
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${API}/posts/${postId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const j = await r.json();
      if (j.sandbox?.status === 'READY') return;
      if (j.sandbox?.status === 'ERROR') throw new Error('sandbox ERROR');
    }
    await sleep(200);
  }
  throw new Error('sandbox not READY');
}

async function send(token, postId, body, clientId) {
  const r = await fetch(`${API}/posts/${postId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ body, aiMode: true, clientId, lang: 'ko', reasoningEffort: 'low' }),
  });
  if (!r.ok) throw new Error(`send failed ${r.status} ${await r.text()}`);
  return r.json();
}

/** 브라우저 컨텍스트에 게스트 토큰을 주입하고 스레드로 진입한다(zustand persist 형식). */
async function openThread(browser, auth, postId) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(
    ([token, userId, username]) => {
      localStorage.setItem(
        'aidit-auth',
        JSON.stringify({ state: { userId, username, token }, version: 0 }),
      );
      localStorage.setItem('aidit-lang', JSON.stringify({ state: { lang: 'ko' }, version: 0 }));
    },
    [auth.token, auth.id, auth.username],
  );
  const page = await ctx.newPage();
  await page.goto(`${WEB}/posts/${postId}`, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

/**
 * 화면 상태를 한 번에 읽는다.
 *   activeTurns  — 배지 숫자. **주의: 이것은 병렬의 증거가 아니다.** `turn.ts` 는 턴 시작 시
 *                  `activeTurnCount+1` 로 RUNNING 을 publish 하므로, 직렬(FIFO) 계약에서도 두 턴이
 *                  디스패치되는 순간 2 가 된다(뒤 턴은 곧 큐에서 대기). UI 표시 검증용으로만 쓴다.
 *   replyLen     — 각 답글 버블의 본문 길이(모의 LLM 이 첫 토큰에 심은 `[qa]`/`[qb]` 마커로 식별).
 *                  **이것의 시간 변화가 병렬/직렬을 가르는 진짜 분별자다.**
 *   attributions — `↳ @질문자` 라벨(귀속). 이것도 턴 시작 시 생성되므로 병렬의 증거는 아니다.
 */
async function sample(page, markers) {
  return page.evaluate((marks) => {
    const badge = Array.from(document.querySelectorAll('[role="status"]')).find((el) =>
      /◉/.test(el.textContent || ''),
    );
    const m = badge ? /(\d+)/.exec(badge.textContent || '') : null;
    const leaves = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length === 0,
    );
    const labels = leaves
      .filter((el) => /^↳\s*@/.test(el.textContent || ''))
      .map((el) => (el.textContent || '').replace(/^↳\s*@/, '').trim());
    const replyLen = {};
    for (const mk of marks) {
      const el = leaves.find((e) => (e.textContent || '').includes(`[${mk}]`));
      replyLen[mk] = el ? (el.textContent || '').length : 0;
    }
    return {
      activeTurns: m ? Number(m[1]) : 0,
      attributions: labels,
      replyLen,
      text: document.body.innerText,
    };
  }, markers);
}

async function main() {
  console.log('[e2e] 서버 기동…');
  start('mock', 'node', ['bench/mockLlm.mjs'], { MOCK_LLM_PORT: String(MOCK_PORT) }, backendRoot);
  await sleep(600);
  start(
    'api',
    'npx',
    ['tsx', 'src/app.ts'],
    {
      PORT: String(API_PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: 'file:./bench.db',
      SANDBOX_ROOT: path.join(backendRoot, '.e2e-sandboxes'),
      RATE_LIMIT_DISABLED: '1',
      API_KEY: 'mock-key-not-a-secret',
      BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      MODEL: 'mock/bench',
      MAX_CONCURRENT_TURNS: '4',
    },
    backendRoot,
  );
  await waitUrl(`${API}/runtime`);
  start(
    'web',
    'npx',
    ['vite', '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'],
    { VITE_PROXY_TARGET: API },
    frontendRoot,
  );
  await waitUrl(WEB);
  console.log('[e2e] 준비 완료\n');

  const tag = String(Date.now()).slice(-5);
  const a = await guest(`아라${tag}`);
  const b = await guest(`바다${tag}`);
  const { post } = await createPost(a.token);
  await waitReady(a.token, post.id);

  const browser = await chromium.launch();
  const A = await openThread(browser, a, post.id);
  const B = await openThread(browser, b, post.id);
  // SSE 연결 안정화.
  await sleep(1200);

  // 두 사용자가 **동시에** 전송. 모의 LLM 이 느리게 스트리밍하도록 지연을 주입한다.
  const dir = (id) => `[[bench ttft=300 tok=70 n=18 work=0 id=${id}]]`;
  console.log('[e2e] 동시 전송…');
  await Promise.all([
    send(a.token, post.id, `${dir('qa')} 아라의 질문`, `a-${tag}`),
    send(b.token, post.id, `${dir('qb')} 바다의 질문`, `b-${tag}`),
  ]);

  // ── 스트리밍을 시간축으로 샘플링한다 ──
  //   진짜 분별자는 "두 답글이 **동시에 자라는가**"다. 직렬 계약에서는 A 의 본문이 다 자란 뒤에야
  //   B 가 첫 토큰을 받으므로 겹침 구간이 존재하지 않는다.
  const MARKS = ['qa', 'qb'];
  let maxActive = 0;
  let attrSeen = [];
  /** 마커별 { firstAt, lastGrowAt } — 첫 토큰 시각과 마지막으로 길이가 늘어난 시각. */
  const growth = { qa: { firstAt: null, lastGrowAt: null, len: 0 }, qb: { firstAt: null, lastGrowAt: null, len: 0 } };
  /** 한 샘플에서 두 답글이 **모두** 직전 샘플보다 자란 횟수(동시 성장 관측). */
  let bothGrewSamples = 0;

  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    const s = await sample(A.page, MARKS);
    const now = Date.now() - t0;
    maxActive = Math.max(maxActive, s.activeTurns);
    if (s.attributions.length >= 2) attrSeen = s.attributions;

    let grewThisSample = 0;
    for (const mk of MARKS) {
      const len = s.replyLen[mk] ?? 0;
      const g = growth[mk];
      if (len > 0 && g.firstAt === null) g.firstAt = now;
      if (len > g.len) {
        g.len = len;
        g.lastGrowAt = now;
        grewThisSample += 1;
      }
    }
    if (grewThisSample === 2) bothGrewSamples += 1;

    // 두 턴이 끝났고(배지 0) 더 자라지 않으면 종료.
    if (s.activeTurns === 0 && growth.qa.len > 0 && growth.qb.len > 0 && now > 1500) break;
    await sleep(60);
  }

  const finalA = await sample(A.page, MARKS);
  const finalB = await sample(B.page, MARKS);

  // 겹침 판정: B 의 첫 토큰이 A 의 마지막 성장보다 **먼저** 도착했는가(양방향 중 하나라도).
  //   직렬이면 뒤 턴의 firstAt > 앞 턴의 lastGrowAt 이 되어 겹침이 0 이다.
  const overlapMs =
    growth.qa.firstAt !== null && growth.qb.firstAt !== null
      ? Math.min(growth.qa.lastGrowAt, growth.qb.lastGrowAt) -
        Math.max(growth.qa.firstAt, growth.qb.firstAt)
      : null;
  const overlapSeen = overlapMs !== null && overlapMs > 0;

  console.log('\n[e2e] 단언:');
  // ① fan-out — 두 브라우저 모두 양쪽 질문을 본다.
  check(
    finalA.text.includes('아라의 질문') && finalA.text.includes('바다의 질문'),
    '① A 화면에 두 사용자의 HUMAN 버블이 모두 보인다(fan-out)',
  );
  check(
    finalB.text.includes('아라의 질문') && finalB.text.includes('바다의 질문'),
    '① B 화면에 두 사용자의 HUMAN 버블이 모두 보인다(fan-out)',
  );
  // ② UI 표시(병렬의 증거는 아님 — 직렬에서도 디스패치 순간 2 가 된다. 표시 자체만 검증).
  check(maxActive >= 2, '② 활성 턴 배지가 2 를 표시한다(UI 표면화)', `관측 최대=${maxActive}`);

  // ③ ★ 진짜 분별자 — 두 답글이 시간상 겹쳐 자란다.
  check(
    overlapSeen,
    '③ 두 AGENT_REPLY 의 스트리밍이 시간상 겹친다(직렬이면 불가능)',
    `겹침=${overlapMs}ms · qa[first=${growth.qa.firstAt},lastGrow=${growth.qa.lastGrowAt}] ` +
      `qb[first=${growth.qb.firstAt},lastGrow=${growth.qb.lastGrowAt}]`,
  );
  check(
    bothGrewSamples > 0,
    '③-b 한 샘플에서 두 답글이 동시에 자란 순간이 있다',
    `동시 성장 샘플=${bothGrewSamples}`,
  );

  // ④ 1:1 귀속 — 서로 다른 질문자를 가리킨다.
  const uniq = [...new Set(attrSeen)];
  check(
    uniq.length >= 2,
    '④ 각 답글이 서로 다른 질문자에 1:1 귀속된다(↳@ 라벨, 배칭 없음)',
    `관측 라벨=${JSON.stringify(attrSeen)}`,
  );
  // ⑤ 두 턴 정상 종료.
  check(finalA.activeTurns === 0, '⑤ 두 턴이 모두 종료되어 활성 턴이 0 이다');
  check(
    /\[qa\]/.test(finalA.text) && /\[qb\]/.test(finalA.text),
    '⑤ 두 답글 본문이 모두 화면에 렌더됐다',
  );
  check(
    /\[qa\]/.test(finalB.text) && /\[qb\]/.test(finalB.text),
    '⑤ B 화면에도 두 답글이 모두 렌더됐다(fan-out)',
  );

  await browser.close();
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.error(`\n[e2e] 예외: ${err.message}`);
} finally {
  await killAll();
}

console.log(`\n[e2e] ${failures === 0 ? 'PASS — 모든 단언 통과' : `FAIL — 단언 ${failures}건 실패`}`);
process.exit(failures === 0 ? 0 : 1);
