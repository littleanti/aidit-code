// backend/src/agent/piWorker.mjs
// AR-PI PoC stub worker — 실제 pi 바이너리 대용. 에이전트 세션 프로세스를 표상한다.
//
// 동작:
//   - 부팅 시 stdout 에 'ready' 한 줄을 출력한다(STARTING -> IDLE 신호).
//   - 이후 stdin 으로 JSON-line 턴 프로토콜을 받는다(parent pi.ts 가 기록):
//       { type: 'input', text, lang }   → 턴 시작. 토큰을 청크로 스트리밍.
//       { type: 'interrupt' }           → 진행 중 턴의 남은 토큰 방출을 즉시 중단.
//     worker 가 stdout 으로 돌려주는 JSON-line:
//       { type: 'token', delta }        → 토큰 조각(타이핑 효과). 여러 줄.
//       { type: 'tool', kind, name, command?, relPath?, content? }
//                                       → 도구 실행 의도. 부모(toolBridge)가 toolExec 로
//                                          실제 fs/shell 효과를 내고(경로 가드), tool.* 이벤트를 낸다.
//                                          worker 는 fs/shell 을 직접 건드리지 않는다(권한 경계는 서버).
//       { type: 'done' }                → 턴 정상 완료.
//       { type: 'error', message }      → 턴 실패(키/원문 미노출, 일반 메시지만).
//   - SIGTERM/SIGINT 수신 시 깨끗하게 종료(exit 0).
//
//   입력 컨벤션(PoC 결정성 — 도구 트리거):
//     사용자 텍스트(input.text)의 각 줄을 다음 접두사로 해석해 도구 의도를 방출한다.
//       '!write <relpath> <content...>'  → FILE_WRITE(content = 나머지 전체)
//       '!read <relpath>'                → FILE_READ
//       '!del <relpath>'                 → FILE_DELETE
//       '!shell <cmd...>'                → SHELL
//       '!demo'                          → 안전한 캔드 시퀀스(write→shell ok→shell fail→escape)
//     접두사가 없는 평범한 텍스트는 도구 없이 그대로 에코 토큰만 흘린다(plain chat).
//
// 보안: 주입된 OPENAI_API_KEY/PI_API_KEY 등 키는 절대 출력/로그하지 않는다.
//   (여기서는 어떤 env 도 stdout 으로 echo 하지 않음으로써 구조적으로 차단.)
//
// ── 실행 모드(SEAM 실현) ────────────────────────────────────────────────
//   runTurn() 이 한 턴을 처리한다. 자연어(도구 컨벤션 '!' 없는) 입력은:
//     - 실 모드: OPENAI_*/PI_* 자격증명으로 OpenAI-compatible chat.completions(stream:true)
//       호출 → delta.content 를 토큰으로 흘린다.
//     - 스텁 모드: 결정적 에코 토큰(테스트/자격증명 없음/AGENT_STUB=1). 기존 PoC 동작 보존.
//   '!'-접두사 도구 컨벤션 라인은 두 모드 공통으로 도구 의도를 방출한다(부모 toolBridge 가 실행).

import { createInterface } from 'node:readline';

// ── LLM 런타임 설정(부모 pi.ts 가 주입한 env). 키는 절대 stdout/이벤트로 흘리지 않는다. ──
const LLM_API_KEY = process.env.OPENAI_API_KEY || process.env.PI_API_KEY || '';
const LLM_BASE_URL = process.env.OPENAI_BASE_URL || process.env.PI_BASE_URL || '';
const LLM_MODEL = process.env.OPENAI_MODEL || process.env.PI_MODEL || '';

/**
 * 스텁(에코) 모드 여부.
 *   - AGENT_STUB=1 강제, 또는
 *   - 테스트 실행(vitest: VITEST/NODE_ENV=test) — 결정적 스위트 보존, 또는
 *   - 자격증명(키/baseURL/model) 누락 — 실 호출 불가 시 안전 폴백.
 * 그 외(실 운영/개발 구동, 자격증명 존재)에는 실 LLM 스트리밍을 사용한다.
 */
const STUB_MODE =
  process.env.AGENT_STUB === '1' ||
  !!process.env.VITEST ||
  process.env.NODE_ENV === 'test' ||
  !LLM_API_KEY ||
  !LLM_BASE_URL ||
  !LLM_MODEL;

/**
 * LLM 호출 전체(초기 응답 + 스트림 수신)의 벽시계 상한(ms).
 * 도달 불가/지연 엔드포인트로 인해 턴이 무한 RUNNING 으로 멈추는 것을 막는다(클린 FAILED 로 마감).
 */
const LLM_TIMEOUT_MS = Number(process.env.AGENT_LLM_TIMEOUT_MS) || 60_000;

/** baseURL 끝의 슬래시를 정리하고 chat.completions 경로를 붙인다. */
function chatCompletionsURL() {
  return `${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
}

/** LLM 응답 언어 system 지시(LANG_HINT/lang 기준). */
function systemForLang(lang) {
  const isKo = String(lang || process.env.LANG_HINT || '').toLowerCase().startsWith('ko');
  return isKo
    ? '너는 샌드박스에서 동작하는 코딩 에이전트다. 한국어로 간결히 답하라.'
    : 'You are a coding agent operating in a sandbox. Answer concisely in English.';
}

/**
 * 실 OpenAI-compatible 스트리밍 호출. delta.content 를 토큰으로 emit 한다.
 * 보안: 키/응답 원문/상태코드/URL 을 에러 메시지·stdout 에 절대 싣지 않는다(일반 문구만 throw).
 * 인터럽트: turn.controller.abort() 로 즉시 중단(상위 input/interrupt 핸들러가 호출).
 */
async function streamLlmReply(prompt, lang, turn) {
  const controller = new AbortController();
  turn.controller = controller;

  // 벽시계 타임아웃: 도달 불가/지연으로 무한 대기하지 않도록 abort. 인터럽트와 구분하기 위해
  //   turn.interrupted 는 건드리지 않는다 → catch 에서 일반 에러로 throw → 턴이 FAILED 로 마감.
  const timer = setTimeout(() => {
    try { controller.abort(); } catch { /* noop */ }
  }, LLM_TIMEOUT_MS);

  try {
    let res;
    try {
      res = await fetch(chatCompletionsURL(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          stream: true,
          messages: [
            { role: 'system', content: systemForLang(lang) },
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (turn.interrupted) return; // 인터럽트로 인한 abort 는 정상 종료.
      throw new Error('llm request failed'); // 원문/키 미노출(타임아웃 abort 포함).
    }

    if (!res.ok || !res.body) {
      // 상태코드/본문을 메시지에 넣지 않는다(키/원문 누출 표면 차단).
      throw new Error('llm request failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      if (turn.interrupted) {
        try { await reader.cancel(); } catch { /* noop */ }
        return;
      }
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        if (turn.interrupted) return;
        throw new Error('llm stream failed'); // 스트림 중 abort/끊김(타임아웃 포함).
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      // SSE 라인 단위 파싱: 'data: {json}' / 'data: [DONE]'.
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        let j;
        try {
          j = JSON.parse(payload);
        } catch {
          continue; // 부분/비-JSON 라인은 무시.
        }
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          if (turn.interrupted) return;
          emit({ type: 'token', delta });
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// IDLE 유지를 위한 keepalive 타이머(모든 종료 신호에서 정리됨).
const keepAlive = setInterval(() => {}, 1 << 30);

function shutdown() {
  clearInterval(keepAlive);
  if (currentTurn) currentTurn.interrupted = true;
  // 깨끗한 종료. 추가 출력 없음(키 누출 방지).
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/** stdout 에 JSON 한 줄을 기록. */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 토큰을 한 청크 흘리는 사이의 지연(ms). 짧게 두어 테스트/PoC 를 빠르게. */
const TOKEN_DELAY_MS = Number(process.env.AGENT_TOKEN_DELAY_MS) || 8;

/** 현재 진행 중인 턴 핸들(인터럽트 플래그를 공유). */
let currentTurn = null;

/** 부모가 도구 실행을 마쳤다는 ack 를 기다리는 resolver(직렬화). */
let toolAck = null;

/** 한 줄을 도구 의도로 해석한다. 도구 라인이 아니면 null. */
function parseToolLine(line) {
  const t = line.trim();
  if (!t.startsWith('!')) return null;
  const sp = t.indexOf(' ');
  const head = sp >= 0 ? t.slice(0, sp) : t;
  const rest = sp >= 0 ? t.slice(sp + 1) : '';
  switch (head) {
    case '!write': {
      const sp2 = rest.indexOf(' ');
      const relPath = sp2 >= 0 ? rest.slice(0, sp2) : rest;
      const content = sp2 >= 0 ? rest.slice(sp2 + 1) : '';
      return { type: 'tool', kind: 'FILE_WRITE', name: 'write_file', relPath, content };
    }
    case '!read':
      return { type: 'tool', kind: 'FILE_READ', name: 'read_file', relPath: rest.trim() };
    case '!del':
      return { type: 'tool', kind: 'FILE_DELETE', name: 'delete_file', relPath: rest.trim() };
    case '!shell':
      return { type: 'tool', kind: 'SHELL', name: 'bash', command: rest };
    default:
      return null;
  }
}

/** '!demo' 캔드 시퀀스: write → shell ok → shell fail → path-escape write(거부됨). */
function demoIntents() {
  const isWin = process.platform === 'win32';
  return [
    { type: 'tool', kind: 'FILE_WRITE', name: 'write_file', relPath: 'demo.txt', content: 'hello sandbox\n' },
    { type: 'tool', kind: 'SHELL', name: 'bash', command: isWin ? 'echo ok' : 'echo ok' },
    { type: 'tool', kind: 'SHELL', name: 'bash', command: isWin ? 'exit 3' : 'exit 3' },
    { type: 'tool', kind: 'FILE_WRITE', name: 'write_file', relPath: '../escape.txt', content: 'should be rejected' },
  ];
}

/** 도구 의도를 방출하고 부모의 ack 를 기다린다(직렬화). */
function emitToolAndWait(intent) {
  return new Promise((resolve) => {
    toolAck = resolve;
    emit(intent);
  });
}

/** 스텁(에코) 모드의 결정적 응답: KO/EN 프리픽스 + 입력 에코. NO real network. */
async function streamEchoReply(plain, lang, turn) {
  const isKo = String(lang || '').toLowerCase().startsWith('ko');
  const prefix = isKo ? '[KO] 에코: ' : '[EN] echo: ';
  const reply = prefix + plain;
  const chunks = reply.match(/\S+\s*/g) ?? [reply];
  for (const delta of chunks) {
    if (turn.interrupted) return;
    emit({ type: 'token', delta });
    await new Promise((r) => setTimeout(r, TOKEN_DELAY_MS));
  }
}

/**
 * 한 턴 처리.
 *   1) '!'-접두사 도구 컨벤션 라인 → 도구 의도 방출(부모 ack 대기, 두 모드 공통).
 *   2) 평범한 텍스트 → 실 모드면 LLM 스트리밍, 스텁 모드면 에코 토큰.
 * turn.interrupted 가 true 가 되면 즉시 중단한다(LLM 모드는 fetch abort 도 동반).
 */
async function runTurn(text, lang, turn) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');

  // 도구 라인 수집(평범한 텍스트와 분리).
  const intents = [];
  const plainLines = [];
  for (const line of lines) {
    if (line.trim() === '!demo') {
      intents.push(...demoIntents());
    } else {
      const tool = parseToolLine(line);
      if (tool) intents.push(tool);
      else if (line.length > 0) plainLines.push(line);
    }
  }

  // 1) 도구 의도를 순차 실행(부모 ack 대기 — 출력/이벤트 직렬화).
  for (const intent of intents) {
    if (turn.interrupted) return;
    await emitToolAndWait(intent);
  }

  // 2) 평범한 텍스트가 있으면 응답을 흘린다(도구만 있는 입력은 토큰 없이 종료 가능).
  const plain = plainLines.join('\n');
  if (plain.length > 0) {
    if (STUB_MODE) {
      await streamEchoReply(plain, lang, turn);
    } else {
      await streamLlmReply(plain, lang, turn);
    }
  }
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // 비-JSON 라인은 무시(견고성).
  }

  if (msg.type === 'interrupt') {
    if (currentTurn) {
      currentTurn.interrupted = true;
      // 진행 중 LLM 스트림 fetch 를 즉시 중단한다.
      try { currentTurn.controller?.abort(); } catch { /* noop */ }
    }
    // 도구 ack 대기 중이었다면 풀어 턴이 깨끗이 마감되도록 한다.
    if (toolAck) {
      const r = toolAck;
      toolAck = null;
      r();
    }
    return;
  }

  if (msg.type === 'tool-done') {
    // 부모가 직전 도구 실행을 마침 — 다음 의도로 진행.
    if (toolAck) {
      const r = toolAck;
      toolAck = null;
      r();
    }
    return;
  }

  if (msg.type === 'input') {
    // 이전 턴이 남아있다면 인터럽트 처리(직렬화).
    if (currentTurn) {
      currentTurn.interrupted = true;
      try { currentTurn.controller?.abort(); } catch { /* noop */ }
    }
    const turn = { interrupted: false, controller: null };
    currentTurn = turn;
    runTurn(msg.text, msg.lang, turn)
      .then(() => {
        if (currentTurn === turn) currentTurn = null;
        emit({ type: 'done' });
      })
      .catch(() => {
        if (currentTurn === turn) currentTurn = null;
        // 일반 메시지만 — 키/원문 미노출.
        emit({ type: 'error', message: 'agent turn failed' });
      });
  }
});

// STARTING -> IDLE: ready 신호를 한 줄 출력. 부모 adapter 가 이 줄을 보고 resolve 한다.
process.stdout.write('ready\n');
