// EXPERIMENTS.md E1/E2 — v2 "병렬 추론 + 직렬 부수효과" 실증 벤치.
// 같은 하네스로 concurrent=true(병렬) 게시글과 concurrent=false(직렬) 게시글을 각각 돌려,
// 두 사용자의 AI 턴이 뿜는 SSE agent.token 도착 시각을 캡처해 스트림 겹침·벽시계 시간을 비교한다.
//
// 병렬 경로 게이트(조사로 확인): 게시글 meta.concurrentTurns=true + 사용자별 활성 턴 1개
//  → 반드시 서로 다른 2명이 같은 게시글에 동시 전송해야 실제 병렬이 성립.
//
// 실행: cd backend && node scripts/bench-concurrency.mjs   (백엔드가 :3001 에서 떠 있어야 함)
const BASE = process.env.BENCH_BASE || 'http://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

async function guest(nickname) {
  const r = await fetch(`${BASE}/auth/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!r.ok) throw new Error(`guest ${nickname} failed: ${r.status}`);
  return r.json(); // { id, token, username }
}

async function createPost(token, concurrent) {
  const r = await fetch(`${BASE}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: `bench ${concurrent ? 'parallel' : 'serial'} ${now()}`,
      body: '벤치용 세션',
      autoReply: false,          // 자동 1차 답변 끄기 — 정확히 2턴만 측정
      reasoningEffort: 'medium',
      concurrent,
    }),
  });
  if (!r.ok) throw new Error(`createPost failed: ${r.status} ${await r.text()}`);
  return r.json(); // { post, sandbox }
}

async function waitReady(token, postId, timeoutMs = 40000) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const r = await fetch(`${BASE}/posts/${postId}`, { headers: { authorization: `Bearer ${token}` } });
    if (r.ok) {
      const j = await r.json();
      const st = j.sandbox?.status;
      if (st === 'READY') return;
      if (st === 'FAILED') throw new Error('sandbox FAILED');
    }
    if (now() > deadline) throw new Error('sandbox not READY in time');
    await sleep(700);
  }
}

async function sendMsg(token, postId, body, clientId) {
  const r = await fetch(`${BASE}/posts/${postId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ body, aiMode: true, clientId, lang: 'ko', reasoningEffort: 'medium' }),
  });
  if (!r.ok) throw new Error(`sendMsg failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// SSE 리더: agent.token 도착 시각을 messageId별로 수집. stop()으로 종료.
function openTokenStream(token, postId) {
  const state = { byMsg: new Map(), lastAny: 0, stopped: false, ctrl: new AbortController() };
  (async () => {
    const res = await fetch(`${BASE}/posts/${postId}/stream`, {
      headers: { authorization: `Bearer ${token}` }, signal: state.ctrl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = null, data = null;
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (ev === 'agent.token' && data) {
            try {
              const j = JSON.parse(data);
              const t = now();
              const rec = state.byMsg.get(j.messageId) || { first: t, last: t, count: 0 };
              rec.last = t; rec.count += 1; if (rec.count === 1) rec.first = t;
              state.byMsg.set(j.messageId, rec);
              state.lastAny = t;
            } catch {}
          }
        }
      }
    } catch { /* aborted */ }
  })();
  state.stop = () => { state.stopped = true; state.ctrl.abort(); };
  return state;
}

async function runScenario(label, concurrent) {
  const tag = `${now()}`.slice(-5);
  const a = await guest(`벤A${tag}`);
  const b = await guest(`벤B${tag}`);
  const { post } = await createPost(a.token, concurrent);
  await waitReady(a.token, post.id);
  const stream = openTokenStream(a.token, post.id);
  await sleep(500); // SSE 연결 안정화

  const t0 = now();
  // 파일 도구 호출을 최소화하고 토큰 스트림을 길게 만들기 위해 "코드는 쓰지 말고 설명만" 요청.
  await Promise.all([
    sendMsg(a.token, post.id, '파이썬 퀵소트 알고리즘의 동작 원리와 평균/최악 시간복잡도를 단계별로 아주 자세히 설명해줘. 파일은 만들지 말고 설명만.', `ca-${tag}`),
    sendMsg(b.token, post.id, '파이썬 데코레이터가 무엇이고 어떻게 동작하는지, 클로저와의 관계까지 단계별로 아주 자세히 설명해줘. 파일은 만들지 말고 설명만.', `cb-${tag}`),
  ]);

  // 조용해질 때까지(마지막 토큰 후 5s) 또는 최대 120s 대기
  const deadline = now() + 120000;
  for (;;) {
    await sleep(500);
    const msgs = stream.byMsg.size;
    if (msgs >= 2 && stream.lastAny > 0 && now() - stream.lastAny > 5000) break;
    if (now() > deadline) break;
  }
  stream.stop();

  const turns = [...stream.byMsg.entries()].map(([id, r]) => ({
    id: id.slice(-6), first: r.first - t0, last: r.last - t0, span: r.last - r.first, count: r.count,
  })).sort((x, y) => x.first - y.first);

  // 상위 2턴으로 지표 계산
  const [x, y] = turns;
  let overlapMs = 0, overallSpan = 0, sumSpan = 0;
  if (x && y) {
    overlapMs = Math.max(0, Math.min(x.last, y.last) - Math.max(x.first, y.first));
    overallSpan = Math.max(x.last, y.last) - Math.min(x.first, y.first);
    sumSpan = x.span + y.span;
  }
  return { label, concurrent, turns, overlapMs, overallSpan, sumSpan };
}

function report(r) {
  console.log(`\n===== ${r.label} (concurrent=${r.concurrent}) =====`);
  for (const t of r.turns) {
    console.log(`  turn …${t.id}: first=+${t.first}ms last=+${t.last}ms span=${t.span}ms tokens=${t.count}`);
  }
  if (r.turns.length >= 2) {
    const pct = r.sumSpan ? Math.round((r.overlapMs / Math.min(r.turns[0].span, r.turns[1].span)) * 100) : 0;
    console.log(`  overlap=${r.overlapMs}ms (겹침 비율 ${pct}% of shorter turn)`);
    console.log(`  overall span=${r.overallSpan}ms  vs  sum of spans=${r.sumSpan}ms`);
    console.log(`  → ${r.overlapMs > 300 ? 'PARALLEL (스트림 겹침)' : 'SERIAL (겹침 없음)'}`);
  } else {
    console.log(`  (측정된 턴 ${r.turns.length}개 — 게이트/타이밍 확인 필요)`);
  }
}

console.log(`bench start @ ${BASE}`);
const parallel = await runScenario('PARALLEL post', true);
report(parallel);
await sleep(1500);
const serial = await runScenario('SERIAL post', false);
report(serial);

console.log('\n===== SUMMARY =====');
const p = parallel, s = serial;
if (p.turns.length >= 2 && s.turns.length >= 2) {
  console.log(`parallel: overall ${p.overallSpan}ms, overlap ${p.overlapMs}ms  |  sum-of-spans ${p.sumSpan}ms`);
  console.log(`serial  : overall ${s.overallSpan}ms, overlap ${s.overlapMs}ms  |  sum-of-spans ${s.sumSpan}ms`);
  const speedup = p.overallSpan ? (s.overallSpan / p.overallSpan).toFixed(2) : 'n/a';
  console.log(`wall-clock: 병렬이 직렬 대비 ${speedup}× 빠름 (동일 2턴 기준, 낮음 강도)`);
} else {
  console.log('one scenario produced <2 turns — inspect above.');
}
console.log('\nDONE');
