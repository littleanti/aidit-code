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

/**
 * LLM 백엔드(EXPERIMENTS §H0.2). 'mock'(기본)=결정적 지연 주입 로컬 서버,
 * 'real'=서버 `.env` 의 실 키. real 은 지연이 비결정적(관측 828~2005ms 지터)이라
 * 통계 정본으로는 mock 을 쓰고 real 은 분포 형상 대조용이다.
 */
const LLM_MODE = process.env.LLM === 'real' ? 'real' : 'mock';

/**
 * E2-B: B 도 도구를 실행해 **샌드박스 락을 다투게** 한다(기본 OFF).
 * OFF 면 기존 E2(B는 도구 없음 = 행복 경로), ON 이면 두 턴 모두 부수효과를 낸다.
 */
const BOTH_TOOLS = process.env.BOTH_TOOLS === '1';
/** BOTH_TOOLS 일 때 B 의 도구 작업 길이(ms). A 의 L 보다 짧게 둬 락 대기를 관측한다. */
const B_WORK_MS = Number(process.env.B_WORK_MS) || 2000;

/**
 * XC-SCOPE 측정 시나리오(`FWRITES=N`): A·B 가 **각자 다른 파일**에 N회씩 write_file 을 한다.
 * SHELL 은 어느 설정에서도 배타이므로 락 입도 효과가 보이지 않는다 — 파일 쓰기 경합만이
 * `LOCK_SCOPE=file` vs `sandbox` 를 가르는 시나리오다. SAME_FILE=1 이면 둘이 같은 파일을 써
 * "충돌하면 여전히 직렬"임을 대조 확인한다.
 */
const FWRITES = Number(process.env.FWRITES) || 0;
const SAME_FILE = process.env.SAME_FILE === '1';

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
 * SSE 구독 — **`replyToId` 기반 턴 귀속**(LLM 비의존).
 *
 * 이전 버전은 모의 LLM 이 첫 토큰에 심은 `[id]` 마커로 턴을 구분했다. 그건 mock 전용이라
 * 실 LLM 에서는 동작하지 않는다. `message.created` 는 AGENT_REPLY 의 `replyToId`(그 턴을 유발한
 * HUMAN 메시지 id)를 실어주므로, 그것으로 "이 답글이 누구 질문에 대한 것인지"를 1:1 확정한다.
 * 레거시 FIFO 경로도 `turn.ts` 가 동일하게 replyToId 를 세팅하므로 두 계약 모두 동작한다.
 *
 * 수집 항목(사용자별):
 *   firstTokenAt — 첫 `agent.token` 도착(=추론 시작). "추론이 병렬인가"의 지표.
 *   completeAt   — `message.updated` status=COMPLETE(=턴 확정). 도구가 락을 기다리면 늘어난다.
 *                  "부수효과가 직렬인가"의 지표.
 * 두 지표를 분리해야 v2 계약의 두 절반(병렬 추론 / 직렬 부수효과)을 각각 볼 수 있다.
 */
function openStream(token, postId) {
  const st = {
    /** humanMessageId → { replyId, firstTokenAt, completeAt } */
    byHuman: new Map(),
    /** agentReplyId → humanMessageId */
    replyToHuman: new Map(),
    lastTokenAt: 0,
    ctrl: new AbortController(),
  };

  const slot = (humanId) => {
    if (!st.byHuman.has(humanId)) {
      st.byHuman.set(humanId, { replyId: null, firstTokenAt: null, completeAt: null });
    }
    return st.byHuman.get(humanId);
  };

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
          if (!ev || !data) continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const t = now();

          // AGENT_REPLY 생성 → replyId ↔ humanId 매핑 등록.
          if (ev === 'message.created' && j.message?.type === 'AGENT_REPLY' && j.message.replyToId) {
            st.replyToHuman.set(j.message.id, j.message.replyToId);
            slot(j.message.replyToId).replyId = j.message.id;
            continue;
          }

          if (ev === 'agent.token' && j.messageId) {
            st.lastTokenAt = t;
            const humanId = st.replyToHuman.get(j.messageId);
            if (!humanId) continue; // 아직 매핑 전이거나 우리가 추적하지 않는 턴.
            const s = slot(humanId);
            if (s.firstTokenAt === null) s.firstTokenAt = t;
            continue;
          }

          if (ev === 'message.updated' && j.status === 'COMPLETE' && j.id) {
            const humanId = st.replyToHuman.get(j.id);
            if (!humanId) continue;
            const s = slot(humanId);
            if (s.completeAt === null) s.completeAt = t;
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  st.firstToken = (humanId) => st.byHuman.get(humanId)?.firstTokenAt ?? null;
  st.complete = (humanId) => st.byHuman.get(humanId)?.completeAt ?? null;
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

/** 샌드박스에서 ms 만큼 대기하는 명령(플랫폼 무관 — node 는 실행 전제). */
function sleepCmd(ms) {
  return `node -e "setTimeout(()=>process.stdout.write('work ${ms}ms done'),${ms})"`;
}

/**
 * 발화문 생성. mock 모드는 `[[bench …]]` 지시자로 지연을 주입하고,
 * real 모드는 **실행할 명령을 명시**한다(모델은 지연 길이를 통제할 수 없으므로 명령으로 지시).
 */
function prompt(role, { workMs, tag }) {
  // XC-SCOPE 시나리오가 켜져 있으면 sleep 대신 파일 쓰기 루프를 지시한다(mock 전용).
  if (FWRITES > 0 && LLM_MODE === 'mock') {
    const fpath = SAME_FILE ? 'shared.txt' : `${role}-file.txt`;
    return `[[bench ttft=100 tok=5 n=6 fwrite=${FWRITES} fpath=${fpath} id=${role}-${tag}]] 파일 작업`;
  }
  if (LLM_MODE === 'real') {
    if (workMs > 0) {
      return (
        `아래 bash 명령을 **그대로 한 번** 실행하고, 끝나면 결과를 한 줄로만 알려줘. ` +
        `설명이나 다른 명령은 추가하지 마.\n\n${sleepCmd(workMs)}`
      );
    }
    return '파이썬에서 리스트와 튜플의 차이를 두 문장으로만 설명해줘. 파일은 만들지 마.';
  }
  const id = `${role}-${tag}`;
  const n = role === 'a' ? 10 : 30;
  return `[[bench ttft=200 tok=8 n=${n} work=${workMs} id=${id}]] ${
    workMs > 0 ? '긴 작업을 해줘' : '한 줄 질문'
  }`;
}

async function runOnce(cond, L, rep) {
  const tag = `${cond.key.toLowerCase().replace('c-', '')}${L}r${rep}`;

  const a = await guest(`A${tag}`.slice(0, 20));
  const b = await guest(`B${tag}`.slice(0, 20));
  const { post } = await createPost(a.token, cond.concurrent, `E2 ${cond.key} L=${L} #${rep}`);
  await waitReady(a.token, post.id);

  const stream = openStream(a.token, post.id);
  await sleep(400); // SSE 연결 안정화

  // ── A: 길이 L 의 선행 작업 턴 ──
  const t0 = now();
  const aSend = await sendMsg(a.token, post.id, prompt('a', { workMs: L, tag }), `a-${tag}`);
  const aHumanId = aSend.json?.message?.id ?? null;

  // ── B: +1s 뒤. 기본은 도구 없는 짧은 질문, BOTH_TOOLS=1 이면 B도 도구를 써 락을 다툰다. ──
  await sleep(B_DELAY_MS);
  const bFirstAttempt = now();
  let retries = 0;
  let bHumanId = null;
  for (;;) {
    const r = await sendMsg(
      b.token,
      post.id,
      prompt('b', { workMs: BOTH_TOOLS ? B_WORK_MS : 0, tag }),
      `b-${tag}-${retries}`,
    );
    if (!r.rejected) {
      bHumanId = r.json?.message?.id ?? null;
      break;
    }
    retries += 1;
    if (retries > 120) throw new Error('C-REJECT: too many retries');
    await sleep(RETRY_MS);
  }

  // ── B 의 첫 토큰(추론 시작) 대기 ──
  const budget = L + (BOTH_TOOLS ? B_WORK_MS : 0) + 90_000;
  const gotB = await until(() => bHumanId && stream.firstToken(bHumanId) !== null, budget);
  // 두 턴 모두 COMPLETE 될 때까지(또는 정적 3s) 기다려 완료 시각·간섭을 본다.
  await until(
    () =>
      aHumanId &&
      bHumanId &&
      stream.complete(aHumanId) !== null &&
      stream.complete(bHumanId) !== null,
    budget,
  );
  await until(() => stream.lastTokenAt > 0 && now() - stream.lastTokenAt > 1500, 10_000);
  stream.stop();

  const bFirst = bHumanId ? stream.firstToken(bHumanId) : null;
  const bDone = bHumanId ? stream.complete(bHumanId) : null;
  const aFirst = aHumanId ? stream.firstToken(aHumanId) : null;
  const aDone = aHumanId ? stream.complete(aHumanId) : null;
  const wall = stream.lastTokenAt ? stream.lastTokenAt - t0 : null;
  const ms = (v, base) => (v === null || v === undefined ? null : Math.round(v - base));

  await deletePost(a.token, post.id);

  return {
    condition: cond.key,
    L,
    rep,
    llm: LLM_MODE,
    bothTools: BOTH_TOOLS,
    // ★ 추론이 병렬인가 — B 의 유효 TTFT(ms). C-REJECT 는 최초 시도 시각 기준(재시도 대기 포함).
    bTtftMs: ms(bFirst, bFirstAttempt),
    // ★ 부수효과가 직렬인가 — B 의 턴 확정까지(락 대기가 여기 들어온다).
    bCompleteMs: ms(bDone, bFirstAttempt),
    retries,
    // A 의 첫 토큰/완료 — 간섭 비용(B 때문에 A 가 느려졌는지).
    aFirstTokenMs: ms(aFirst, t0),
    aCompleteMs: ms(aDone, t0),
    // 두 턴이 모두 조용해질 때까지의 벽시계.
    wallMs: wall === null ? null : Math.round(wall),
    ok: gotB,
  };
}

// ─────────────────────────── 오케스트레이션 ───────────────────────────

function summarize(rows, field = 'bTtftMs') {
  const by = new Map();
  for (const r of rows) {
    if (!r.ok || r[field] == null) continue;
    const k = `${r.condition}|${r.L}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r[field]);
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

  console.log(
    `[e2] LLM=${LLM_MODE}${BOTH_TOOLS ? ` BOTH_TOOLS=1 (B work=${B_WORK_MS}ms)` : ''} ` +
      `· 조건 ${CONDITIONS.map((c) => c.key).join(',')} · L=${LEVELS.join(',')} · REPS=${REPS}`,
  );

  // real 모드면 모의 서버를 띄우지 않고 서버 `.env` 의 실 키를 그대로 쓴다.
  const mock =
    LLM_MODE === 'mock'
      ? startProc('mock', 'node', ['bench/mockLlm.mjs'], { MOCK_LLM_PORT: String(MOCK_PORT) })
      : null;
  if (mock) await sleep(600);

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
        // mock 모드만 LLM 설정을 덮어쓴다. real 모드는 덮어쓰지 않아 서버가 `.env` 의 실 키를 읽는다
        //   (여기서 키를 읽거나 로그로 내보내지 않는다 — TRD §8).
        ...(LLM_MODE === 'mock'
          ? {
              API_KEY: 'mock-key-not-a-secret',
              BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
              MODEL: 'mock/bench',
            }
          : {}),
        TOOL_TIMEOUT_MS: '120000', // L=15s sleep 도구가 기본 30s 타임아웃에 걸리지 않도록.
        MAX_CONCURRENT_TURNS: '4',
        // real 모드는 모델이 여러 스텝을 돌 수 있으므로 상한을 넉넉히(데모와 동일 값).
        // FWRITES 시나리오는 write_file 을 N회 돌므로 상한이 N 보다 커야 한다.
        AGENT_MAX_STEPS: process.env.AGENT_MAX_STEPS || String(Math.max(14, FWRITES + 4)),
        // XC-SCOPE 조작 변인 — 'file'(기본) vs 'sandbox'(v2 최초 동작).
        ...(process.env.LOCK_SCOPE ? { LOCK_SCOPE: process.env.LOCK_SCOPE } : {}),
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
                ` B_done=${row.bCompleteMs ?? '-'}ms` +
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
    if (mock) await killProc(mock);
  }

  const summary = summarize(rows, 'bTtftMs');
  const slope = slopes(summary);
  // E2-B 의 핵심: 완료 시각은 락 대기를 포함하므로 TTFT 와 **갈라져야** 한다.
  const summaryDone = summarize(rows, 'bCompleteMs');

  console.log('\n===== E2 SUMMARY — B TTFT(추론 시작, ms) =====');
  console.log('condition   L(ms)    n    p50     p95    mean');
  for (const s of summary) {
    console.log(
      `${s.condition.padEnd(10)} ${String(s.L).padStart(6)} ${String(s.n).padStart(4)} ` +
        `${String(s.p50).padStart(6)} ${String(s.p95).padStart(7)} ${String(s.mean).padStart(7)}`,
    );
  }
  console.log('\n----- B TTFT ~ L 회귀 기울기 (1≈완전종속 / 0≈독립) -----');
  for (const [k, v] of Object.entries(slope)) console.log(`  ${k.padEnd(10)} ${v}`);

  if (summaryDone.length) {
    console.log('\n===== B 턴 완료(부수효과 포함, ms) — 락 대기가 여기 들어온다 =====');
    console.log('condition   L(ms)    n    p50     p95    mean');
    for (const s of summaryDone) {
      console.log(
        `${s.condition.padEnd(10)} ${String(s.L).padStart(6)} ${String(s.n).padStart(4)} ` +
          `${String(s.p50).padStart(6)} ${String(s.p95).padStart(7)} ${String(s.mean).padStart(7)}`,
      );
    }
    console.log('\n----- B 완료 ~ L 회귀 기울기 -----');
    for (const [k, v] of Object.entries(slopes(summaryDone))) console.log(`  ${k.padEnd(10)} ${v}`);
  }

  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\nruns: ${rows.length}  failed: ${failed}`);
  await writeFile(
    path.join(OUT_DIR, `e2-summary${OUT_TAG}.json`),
    JSON.stringify(
      {
        llm: LLM_MODE,
        bothTools: BOTH_TOOLS,
        bWorkMs: BOTH_TOOLS ? B_WORK_MS : 0,
        levels: LEVELS,
        reps: REPS,
        summary,
        slope,
        summaryComplete: summaryDone,
        slopeComplete: slopes(summaryDone),
        failed,
        total: rows.length,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${OUT_JSONL}`);
}

await main();
