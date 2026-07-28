// backend/bench/e2-hol.mjs
// EXPERIMENTS.md E2 — HOL 지연 분포. 동시성 계약 3종 비교.
//
// 시나리오 S-HOL (설계 §E2 그대로):
//   1. 사용자 A 가 길이 L 의 장시간 턴을 발사(모의 LLM 이 L ms 짜리 bash sleep 도구를 호출).
//   2. +1s 뒤 사용자 B 가 한 줄 질문(짧은 답, 도구 없음).
//   3. B 의 **TTFT**(첫 agent.token 도착)를 측정한다. 이것이 "남의 작업 뒤에 줄 서는가"의 지표다.
//
// 계약 3종:
//   C-FIFO   : concurrent=false           — v0.1 레거시 경로(단일 활성 턴 + FIFO 큐)
//   C-REJECT : BENCH_BUSY_GATE=1          — 바쁘면 409, 드라이버가 1s 간격 재시도.
//                                           유효 TTFT = **최초 시도 시각** 기준(재시도 대기 포함)
//   C-PAR    : concurrent=true            — 본 계약(병렬 추론 + 직렬 부수효과)
//
// 판정: B TTFT ~ L 회귀 기울기가 C-FIFO ≈ 1, C-PAR ≈ 0 이면 "HOL blocking 제거"가 실측된 것.
//
// 격리: 전용 DB(prisma/bench.db)·전용 샌드박스 루트·모의 LLM 로컬 서버를 드라이버가 직접 띄운다.
//       개발 DB(dev.db)와 .sandboxes 는 건드리지 않는다.
//
// 실행: cd backend && node bench/e2-hol.mjs            (결과: bench/out/e2-hol.jsonl)
//       REPS=5 LEVELS=2000,6000 node bench/e2-hol.mjs  (축소 실행)

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'out');
/**
 * 출력 태그. 기본(무태그) 실행은 커밋된 정식 측정 결과(`e2-hol.jsonl`, 180행)를 **덮어쓴다** —
 * 스모크/디버깅 실행은 반드시 태그를 붙여 증거 파일을 보호할 것.
 *   예) OUT_TAG=smoke REPS=1 LEVELS=2000 node bench/e2-hol.mjs  → e2-hol.smoke.jsonl
 * (실제로 REPS=1 스모크가 180행 원자료를 3행으로 덮어써 git 복원이 필요했던 사고가 있었다.)
 */
const OUT_TAG = process.env.OUT_TAG ? `.${process.env.OUT_TAG}` : '';
const OUT_JSONL = path.join(OUT_DIR, `e2-hol${OUT_TAG}.jsonl`);

const MOCK_PORT = Number(process.env.MOCK_LLM_PORT) || 8099;
const SRV_PORT = Number(process.env.BENCH_SRV_PORT) || 3099;
const BASE = `http://127.0.0.1:${SRV_PORT}`;

/** 선행 작업 길이 L(ms). 설계 원안 {5000,15000,45000} → 단일 PC 실행시간 때문에 축소(문서에 명시). */
const LEVELS = (process.env.LEVELS || '2000,6000,15000').split(',').map(Number);
/** 셀당 반복. 설계 원안 50 → 축소(문서에 명시). */
const REPS = Number(process.env.REPS) || 20;

/** B 발사 지연(설계: A 발사 후 +1s). */
const B_DELAY_MS = 1000;
/** C-REJECT 재시도 간격(설계: 1s). */
const RETRY_MS = 1000;

const ALL_CONDITIONS = [
  { key: 'C-FIFO', concurrent: false, busyGate: false },
  { key: 'C-REJECT', concurrent: false, busyGate: true },
  { key: 'C-PAR', concurrent: true, busyGate: false },
];
/** CONDS=C-PAR 처럼 조건을 좁혀 재현/디버깅할 수 있게 한다(미지정 시 전부). */
const CONDITIONS = process.env.CONDS
  ? ALL_CONDITIONS.filter((c) => process.env.CONDS.split(',').includes(c.key))
  : ALL_CONDITIONS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ─────────────────────────── 프로세스 관리 ───────────────────────────

function waitForPort(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      try {
        const r = await fetch(url, { method: 'GET' });
        if (r.status < 500) return;
      } catch {
        /* 아직 안 뜸 */
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
      await sleep(300);
    }
  })();
}

function startProc(label, cmd, args, env) {
  const p = spawn(cmd, args, {
    cwd: backendRoot,
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  p.stdout.on('data', (d) => {
    if (process.env.BENCH_VERBOSE) process.stdout.write(`[${label}] ${d}`);
  });
  p.stderr.on('data', (d) => {
    const s = String(d);
    // tsx/prisma 의 정상 경고는 조용히, 진짜 에러만 보여준다.
    if (process.env.BENCH_VERBOSE || /error|Error|ECONN|EADDR/.test(s)) {
      process.stderr.write(`[${label}] ${s}`);
    }
  });
  return p;
}

async function killProc(p) {
  if (!p || p.killed) return;
  if (process.platform === 'win32' && p.pid) {
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
  await sleep(300);
}

// ─────────────────────────── API 클라이언트 ───────────────────────────

async function guest(nickname) {
  const r = await fetch(`${BASE}/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!r.ok) throw new Error(`guest failed: ${r.status}`);
  return r.json();
}

async function createPost(token, concurrent, title) {
  const r = await fetch(`${BASE}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title,
      body: 'E2 HOL bench session',
      autoReply: false, // 자동 인트로 턴 금지 — 정확히 A·B 두 턴만 측정.
      reasoningEffort: 'low',
      concurrent,
    }),
  });
  if (!r.ok) throw new Error(`createPost failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function waitReady(token, postId, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await fetch(`${BASE}/posts/${postId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      const j = await r.json();
      if (j.sandbox?.status === 'READY') return;
      if (j.sandbox?.status === 'ERROR') throw new Error('sandbox ERROR');
    }
    if (Date.now() > deadline) throw new Error('sandbox not READY in time');
    await sleep(200);
  }
}

/** 메시지 전송. 409(busy) 는 던지지 않고 { rejected:true } 로 알린다(C-REJECT 재시도용). */
async function sendMsg(token, postId, body, clientId) {
  const r = await fetch(`${BASE}/posts/${postId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ body, aiMode: true, clientId, lang: 'ko', reasoningEffort: 'low' }),
  });
  if (r.status === 409) return { rejected: true };
  if (!r.ok) throw new Error(`sendMsg failed: ${r.status} ${await r.text()}`);
  return { rejected: false, json: await r.json() };
}

async function deletePost(token, postId) {
  try {
    await fetch(`${BASE}/posts/${postId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    /* 정리 실패는 측정에 영향 없음 */
  }
}

/**
 * SSE 구독. 모의 LLM 이 각 턴의 **첫 토큰**에 `[<id>] ` 마커를 실어 보내므로,
 * 그 마커로 어느 사용자의 턴인지 식별한다(레거시 경로에서 replyToId 가 null 일 수 있어
 * messageId 매칭보다 견고하다).
 */
function openStream(token, postId, marks) {
  const st = { hit: new Map(), lastTokenAt: 0, ctrl: new AbortController() };
  (async () => {
    const res = await fetch(`${BASE}/posts/${postId}/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: st.ctrl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev = null;
          let data = null;
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (ev !== 'agent.token' || !data) continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const t = now();
          st.lastTokenAt = t;
          for (const m of marks) {
            if (!st.hit.has(m) && typeof j.delta === 'string' && j.delta.includes(`[${m}]`)) {
              st.hit.set(m, t);
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  st.stop = () => st.ctrl.abort();
  return st;
}

/** 조건이 참이 될 때까지 대기(최대 timeoutMs). */
async function until(pred, timeoutMs, step = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

// ─────────────────────────── 1회 측정 ───────────────────────────

async function runOnce(cond, L, rep) {
  const tag = `${cond.key.toLowerCase().replace('c-', '')}${L}r${rep}`;
  const aMark = `a-${tag}`;
  const bMark = `b-${tag}`;

  const a = await guest(`A${tag}`.slice(0, 20));
  const b = await guest(`B${tag}`.slice(0, 20));
  const { post } = await createPost(a.token, cond.concurrent, `E2 ${cond.key} L=${L} #${rep}`);
  await waitReady(a.token, post.id);

  const stream = openStream(a.token, post.id, [aMark, bMark]);
  await sleep(400); // SSE 연결 안정화

  // ── A: 길이 L 의 선행 작업 턴 ──
  const t0 = now();
  await sendMsg(
    a.token,
    post.id,
    `[[bench ttft=200 tok=8 n=10 work=${L} id=${aMark}]] 긴 작업을 해줘`,
    `a-${tag}`,
  );

  // ── B: +1s 뒤 짧은 질문 ──
  await sleep(B_DELAY_MS);
  const bFirstAttempt = now();
  let retries = 0;
  for (;;) {
    const r = await sendMsg(
      b.token,
      post.id,
      `[[bench ttft=200 tok=8 n=30 work=0 id=${bMark}]] 한 줄 질문`,
      `b-${tag}-${retries}`,
    );
    if (!r.rejected) break;
    retries += 1;
    if (retries > 120) throw new Error('C-REJECT: too many retries');
    await sleep(RETRY_MS);
  }

  // ── B 의 첫 토큰 대기 → TTFT ──
  const budget = L + 60_000;
  const gotB = await until(() => stream.hit.has(bMark), budget);
  // A 의 스트림도 끝까지 받아 간섭 비용을 본다(마지막 토큰 후 1.5s 정적이면 종료).
  await until(() => stream.lastTokenAt > 0 && now() - stream.lastTokenAt > 1500, 20_000);
  stream.stop();

  const bTtft = gotB ? stream.hit.get(bMark) - bFirstAttempt : null;
  const aFirst = stream.hit.has(aMark) ? stream.hit.get(aMark) - t0 : null;
  const wall = stream.lastTokenAt ? stream.lastTokenAt - t0 : null;

  await deletePost(a.token, post.id);

  return {
    condition: cond.key,
    L,
    rep,
    // B 의 유효 TTFT(ms) — C-REJECT 는 최초 시도 시각 기준이라 재시도 대기가 포함된다.
    bTtftMs: bTtft === null ? null : Math.round(bTtft),
    retries,
    // A 의 첫 토큰(도구 sleep 이후) — 병렬화가 A 를 지연시켰는지 확인용.
    aFirstTokenMs: aFirst === null ? null : Math.round(aFirst),
    // 두 턴이 모두 조용해질 때까지의 벽시계.
    wallMs: wall === null ? null : Math.round(wall),
    ok: gotB,
  };
}

// ─────────────────────────── 오케스트레이션 ───────────────────────────

function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.ok || r.bTtftMs == null) continue;
    const k = `${r.condition}|${r.L}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r.bTtftMs);
  }
  const out = [];
  for (const [k, arr] of by) {
    arr.sort((x, y) => x - y);
    const [condition, L] = k.split('|');
    const q = (p) => arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))];
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    out.push({ condition, L: Number(L), n: arr.length, p50: q(0.5), p95: q(0.95), mean: Math.round(mean) });
  }
  return out.sort((a, b) => a.condition.localeCompare(b.condition) || a.L - b.L);
}

/** 조건별 B TTFT ~ L 최소자승 회귀 기울기(초당 초 — 1 ≈ 완전 종속, 0 ≈ 독립). */
function slopes(summary) {
  const out = {};
  const byCond = new Map();
  for (const s of summary) {
    if (!byCond.has(s.condition)) byCond.set(s.condition, []);
    byCond.get(s.condition).push(s);
  }
  for (const [cond, arr] of byCond) {
    const n = arr.length;
    const mx = arr.reduce((s, a) => s + a.L, 0) / n;
    const my = arr.reduce((s, a) => s + a.p50, 0) / n;
    const num = arr.reduce((s, a) => s + (a.L - mx) * (a.p50 - my), 0);
    const den = arr.reduce((s, a) => s + (a.L - mx) ** 2, 0);
    out[cond] = den === 0 ? 0 : Number((num / den).toFixed(3));
  }
  return out;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const sandboxRoot = path.join(backendRoot, '.bench-sandboxes');
  await rm(sandboxRoot, { recursive: true, force: true });
  await mkdir(sandboxRoot, { recursive: true });

  const rows = [];
  const total = CONDITIONS.length * LEVELS.length * REPS;
  let done = 0;
  const startedAt = Date.now();

  // 모의 LLM 은 조건 전체에서 하나만 띄운다(상태 없음).
  const mock = startProc('mock', 'node', ['bench/mockLlm.mjs'], { MOCK_LLM_PORT: String(MOCK_PORT) });
  await sleep(600);

  try {
    for (const cond of CONDITIONS) {
      // busyGate 는 서버 부팅 시점 env 라 조건마다 서버를 다시 띄운다.
      const srv = startProc('srv', 'npx', ['tsx', 'src/app.ts'], {
        PORT: String(SRV_PORT),
        HOST: '127.0.0.1',
        DATABASE_URL: 'file:./bench.db',
        SANDBOX_ROOT: sandboxRoot,
        RATE_LIMIT_DISABLED: '1',
        BENCH_BUSY_GATE: cond.busyGate ? '1' : '0',
        API_KEY: 'mock-key-not-a-secret',
        BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        MODEL: 'mock/bench',
        TOOL_TIMEOUT_MS: '120000', // L=15s sleep 도구가 기본 30s 타임아웃에 걸리지 않도록.
        MAX_CONCURRENT_TURNS: '4',
      });
      await waitForPort(`${BASE}/runtime`);

      try {
        for (const L of LEVELS) {
          for (let rep = 1; rep <= REPS; rep++) {
            let row;
            try {
              row = await runOnce(cond, L, rep);
            } catch (err) {
              row = { condition: cond.key, L, rep, bTtftMs: null, ok: false, error: String(err.message || err) };
            }
            rows.push(row);
            done += 1;
            const pct = ((done / total) * 100).toFixed(0);
            const eta = Math.round(((Date.now() - startedAt) / done) * (total - done) / 1000);
            console.log(
              `[${pct}%] ${cond.key} L=${L} #${rep}  B_TTFT=${row.bTtftMs ?? 'FAIL'}ms` +
                `${row.retries ? ` (retries=${row.retries})` : ''}  ETA ${eta}s`,
            );
            await writeFile(OUT_JSONL, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
          }
        }
      } finally {
        await killProc(srv);
      }
    }
  } finally {
    await killProc(mock);
  }

  const summary = summarize(rows);
  const slope = slopes(summary);

  console.log('\n===== E2 SUMMARY (B TTFT, ms) =====');
  console.log('condition   L(ms)    n    p50     p95    mean');
  for (const s of summary) {
    console.log(
      `${s.condition.padEnd(10)} ${String(s.L).padStart(6)} ${String(s.n).padStart(4)} ` +
        `${String(s.p50).padStart(6)} ${String(s.p95).padStart(7)} ${String(s.mean).padStart(7)}`,
    );
  }
  console.log('\n----- B TTFT ~ L 회귀 기울기 (1≈완전종속 / 0≈독립) -----');
  for (const [k, v] of Object.entries(slope)) console.log(`  ${k.padEnd(10)} ${v}`);

  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\nruns: ${rows.length}  failed: ${failed}`);
  await writeFile(
    path.join(OUT_DIR, `e2-summary${OUT_TAG}.json`),
    JSON.stringify({ levels: LEVELS, reps: REPS, summary, slope, failed, total: rows.length }, null, 2),
  );
  console.log(`\nwrote ${OUT_JSONL}`);
}

await main();
