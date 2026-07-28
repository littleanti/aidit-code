// backend/bench/mockLlm.mjs
// EXPERIMENTS.md §H0.2 (b) — 모의 LLM 서버. OpenAI 호환 `/chat/completions` SSE.
//
// 목적: 실 LLM 의 비결정적 지연을 제거하고 **지연을 우리가 주입**해, E2(HOL 지연 분포)를
//       반복 가능·통계 처리 가능한 실험으로 만든다. 네트워크·쿼터·모델 변동성과 무관하다.
//
// 프로토콜: piWorker.mjs 가 기대하는 스트리밍 형식 그대로
//   data: {"choices":[{"delta":{"content":"..."}}]}          토큰
//   data: {"choices":[{"delta":{"tool_calls":[…]},...}]}     도구 호출(bash)
//   data: [DONE]
//
// 지연 파라미터: 사용자 프롬프트에 실린 지시자를 파싱한다(요청 헤더가 아니라 프롬프트로 받는 이유 —
//   드라이버가 서버 라우트를 거쳐 워커까지 값을 흘려보낼 수 있는 유일한 결정적 통로).
//     [[bench ttft=200 tok=10 n=30 work=15000 id=b-3]]
//   ttft : 첫 토큰까지 지연(ms)
//   tok  : 토큰 간 간격(ms)
//   n    : 방출 토큰 수
//   work : >0 이면 먼저 bash 도구 호출로 이 시간만큼 샌드박스에서 sleep(선행 '작업' 시뮬레이션).
//          도구 실행은 sandboxLock 을 잡으므로 '부수효과 직렬화'까지 실제 경로로 재현된다.
//   id   : 로그 상관용 태그(동작에 영향 없음)
//
// 결정성: 난수·시계 의존 분기 없음. 같은 지시자 → 같은 토큰 수·같은 간격.
//
// 실행: node bench/mockLlm.mjs           (포트는 MOCK_LLM_PORT, 기본 8099)

import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT) || 8099;

/** 기본값 — 지시자가 없는 호출(자동 인트로 턴 등)도 빠르게 끝나도록 짧게 잡는다. */
const DEFAULTS = { ttft: 100, tok: 5, n: 12, work: 0, id: 'none' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 프롬프트 문자열들에서 [[bench …]] 지시자를 찾아 파싱. 없으면 DEFAULTS. */
function parseDirective(messages) {
  // 가장 마지막 user 메시지를 우선 사용(그 턴의 지시자).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ')
          : '';
    const hit = /\[\[bench([^\]]*)\]\]/.exec(text);
    if (!hit) continue;
    const out = { ...DEFAULTS };
    for (const [, k, v] of hit[1].matchAll(/(\w+)=([\w.-]+)/g)) {
      if (k === 'id') out.id = v;
      else if (k in out) out[k] = Number(v);
    }
    return out;
  }
  return { ...DEFAULTS };
}

/** 이 호출이 '도구 결과 되먹임 이후'인지 — 마지막 메시지가 role:tool 이면 마무리 단계. */
function isAfterTool(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i].role;
    if (r === 'tool') return true;
    if (r === 'user') return false;
  }
  return false;
}

/** 샌드박스에서 ms 만큼 대기시키는 명령(플랫폼 무관 — node 는 실행 전제). */
function sleepCommand(ms) {
  return `node -e "setTimeout(()=>process.stdout.write('work ${ms}ms done'),${ms})"`;
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(delta, finish = null) {
  return {
    id: 'mock',
    object: 'chat.completion.chunk',
    model: 'mock/bench',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const server = http.createServer(async (req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }

  let raw = '';
  for await (const c of req) raw += c;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400).end('bad json');
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const p = parseDirective(messages);
  const afterTool = isAfterTool(messages);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // 클라이언트(워커)가 abort 하면 즉시 중단 — interrupt 경로 재현.
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  // ── 1단계: work>0 이고 아직 도구를 안 돌렸으면 bash 도구 호출을 방출 ──
  if (p.work > 0 && !afterTool) {
    await sleep(p.ttft);
    if (aborted) return res.end();
    sseWrite(
      res,
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_${p.id}`,
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command: sleepCommand(p.work) }) },
          },
        ],
      }),
    );
    sseWrite(res, chunk({}, 'tool_calls'));
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // ── 2단계: 텍스트 토큰 스트리밍 ──
  await sleep(p.ttft);
  for (let i = 0; i < p.n; i++) {
    if (aborted) return res.end();
    sseWrite(res, chunk({ content: i === 0 ? `[${p.id}] ` : `tok${i} ` }));
    if (i < p.n - 1) await sleep(p.tok);
  }
  sseWrite(res, chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mockLlm] listening on http://127.0.0.1:${PORT}  (OpenAI-compatible /chat/completions)`);
});
