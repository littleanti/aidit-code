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
import { buildCompletionBody, buildUserContent, reasoningEffortApplies } from './piWorkerBody.mjs';

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

// ── 비전 입력(Feature A) ────────────────────────────────────────────────
// 부모(pi.ts)가 주입한 업로드 디렉토리. 워커가 이미지 파일을 읽기 전 경로 가드 기준.
//   실제 파일 읽기/data-url 변환/content 구성은 순수 헬퍼(piWorkerBody.mjs)로 분리(단위 테스트 가능).
const UPLOAD_DIR = process.env.UPLOAD_DIR || '';

/** LLM 응답 언어/역할 system 지시(LANG_HINT/lang 기준). 도구 사용을 명시 안내. */
function systemForLang(lang) {
  const isKo = String(lang || process.env.LANG_HINT || '').toLowerCase().startsWith('ko');
  return isKo
    ? [
        '너는 격리된 샌드박스 워크스페이스에서 동작하는 코딩 에이전트다.',
        '제공된 도구로 파일을 직접 생성·수정·삭제하고 셸 명령을 실행할 수 있다.',
        '코드를 "저장/작성"해 달라는 요청에는 반드시 write_file 도구를 호출해 실제 파일로 기록하라. 코드만 텍스트로 보여주고 끝내지 마라.',
        '경로는 워크스페이스 루트 기준 상대경로다. 한국어로 간결히 답하라.',
      ].join(' ')
    : [
        'You are a coding agent operating in an isolated sandbox workspace.',
        'You can create, edit, and delete files and run shell commands using the provided tools.',
        'When asked to save or write code, you MUST call write_file to persist it as a real file — do not just print the code.',
        'Paths are relative to the workspace root. Answer concisely in English.',
      ].join(' ');
}

/** LLM 에 노출하는 샌드박스 도구 스펙(OpenAI function-calling). 기존 M5 파이프라인에 매핑된다. */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the sandbox workspace. Use this to save/write code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'workspace-relative path, e.g. src/app.js' },
          content: { type: 'string', description: 'full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the sandbox workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'workspace-relative path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory from the sandbox workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'workspace-relative path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command in the sandbox workspace (cwd = workspace root).',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'shell command to run' } },
        required: ['command'],
      },
    },
  },
];

/** LLM tool_call(name+args) → 부모(toolBridge)가 실행할 {type:'tool'} 인텐트로 매핑. */
function toolCallToIntent(name, a, callId) {
  switch (name) {
    case 'write_file':
      return { type: 'tool', kind: 'FILE_WRITE', name: 'write_file', relPath: String(a.path ?? ''), content: String(a.content ?? ''), callId };
    case 'read_file':
      return { type: 'tool', kind: 'FILE_READ', name: 'read_file', relPath: String(a.path ?? ''), callId };
    case 'delete_file':
      return { type: 'tool', kind: 'FILE_DELETE', name: 'delete_file', relPath: String(a.path ?? ''), callId };
    case 'bash':
      return { type: 'tool', kind: 'SHELL', name: 'bash', command: String(a.command ?? ''), callId };
    default:
      return null;
  }
}

/** function-calling 루프의 최대 단계(런어웨이 방지). 각 단계 = 1 completion(+도구 실행). */
const MAX_AGENT_STEPS = Number(process.env.AGENT_MAX_STEPS) || 8;

/** 세션 수명 동안 유지되는 대화 history(멀티턴 기억). system + user/assistant/tool. */
let convo = null;

/** convo 초기화(system 메시지 1회). 이후 turn 마다 user/assistant/tool 이 누적된다. */
function ensureConvo(lang) {
  if (!convo) convo = [{ role: 'system', content: systemForLang(lang) }];
  return convo;
}

/** history 길이 캡(system 보존 + 최근 N). 컨텍스트 폭주 방지. */
function capConvo() {
  const N = 40;
  if (convo && convo.length > N + 1) {
    convo = [convo[0], ...convo.slice(convo.length - N)];
  }
}

/**
 * 한 번의 streaming completion(도구 포함). 텍스트 delta 는 토큰으로 emit 하고,
 * tool_calls delta(id/name/arguments)는 index 별로 누적해 반환한다.
 * @returns { text, toolCalls: [{id,name,arguments}], finishReason }
 * 보안: 키/응답 원문/상태코드/URL 을 에러 메시지·stdout 에 절대 싣지 않는다(일반 문구만 throw).
 *
 * reasoningEffort(Feature B): 'low'|'medium'|'high' 가 주어지면 body 에 `reasoning_effort` 를 포함한다.
 *   값이 없으면 필드를 생략한다 — reasoning 비지원 모델(예: 일부 chat 모델)이 거부하지 않도록.
 *   (NOTE) 이 필드는 reasoning 모델에서만 효과가 있다. 비-reasoning 모델은 무시/거부할 수 있으며,
 *   그것은 모델/설정 선택의 문제이지 버그가 아니다.
 */
async function streamOneCompletion(turn, reasoningEffort) {
  const controller = new AbortController();
  turn.controller = controller;
  const timer = setTimeout(() => {
    try { controller.abort(); } catch { /* noop */ }
  }, LLM_TIMEOUT_MS);

  let text = '';
  const tcByIndex = new Map(); // index -> { id, name, arguments }
  let finishReason = null;

  try {
    let res;
    try {
      res = await fetch(chatCompletionsURL(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify(buildCompletionBody(convo, LLM_MODEL, TOOLS, reasoningEffort)),
        signal: controller.signal,
      });
    } catch {
      if (turn.interrupted) return { text, toolCalls: [], finishReason };
      throw new Error('llm request failed'); // 원문/키 미노출(타임아웃 abort 포함).
    }

    if (!res.ok || !res.body) {
      throw new Error('llm request failed'); // 상태코드/본문 미노출.
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    while (!done) {
      if (turn.interrupted) {
        try { await reader.cancel(); } catch { /* noop */ }
        break;
      }
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        if (turn.interrupted) break;
        throw new Error('llm stream failed'); // abort/끊김(타임아웃 포함).
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { done = true; break; }
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        const choice = j?.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          if (!turn.interrupted) emit({ type: 'token', delta: delta.content });
          text += delta.content;
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const d of delta.tool_calls) {
            const idx = typeof d.index === 'number' ? d.index : 0;
            let acc = tcByIndex.get(idx);
            if (!acc) { acc = { id: '', name: '', arguments: '' }; tcByIndex.set(idx, acc); }
            if (d.id) acc.id = d.id;
            if (d.function?.name) acc.name = d.function.name;
            if (typeof d.function?.arguments === 'string') acc.arguments += d.function.arguments;
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const toolCalls = [...tcByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.name); // name 없는 잔여는 버림
  return { text, toolCalls, finishReason };
}

/**
 * 실 모드 에이전트 루프: completion → (도구 호출 있으면) 실행/되먹임 → 반복.
 * 텍스트만 나오면 종료. interrupted 시 즉시 중단. 단계 상한(MAX_AGENT_STEPS)으로 런어웨이 방지.
 *
 * opts(Feature A/B): { image?: {absPath, mime}, reasoningEffort?: 'low'|'medium'|'high' }.
 *   - image: 이 턴의 user 메시지 content 를 multimodal 배열로(에이전트가 이미지를 본다).
 *   - reasoningEffort: 매 completion body 에 reasoning_effort 로 전달(값 있을 때만).
 */
async function runLlmAgent(prompt, lang, turn, opts = {}) {
  ensureConvo(lang);
  const content = await buildUserContent(prompt, opts.image, UPLOAD_DIR);
  convo.push({ role: 'user', content });
  capConvo();
  // 안전 게이트: 비-reasoning 모델(예: gpt-4o-mini)엔 reasoning_effort 를 싣지 않는다(400 회귀 방지).
  const reasoningEffort = reasoningEffortApplies(
    LLM_MODEL,
    opts.reasoningEffort,
    process.env.REASONING_EFFORT,
  )
    ? opts.reasoningEffort
    : undefined;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (turn.interrupted) return;
    const { text, toolCalls } = await streamOneCompletion(turn, reasoningEffort);
    if (turn.interrupted) return;

    const assistant = { role: 'assistant', content: text || '' };
    if (toolCalls.length) {
      assistant.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments || '{}' },
      }));
    }
    convo.push(assistant);

    if (!toolCalls.length) { capConvo(); return; } // 텍스트 응답 — 턴 종료.

    // 도구 호출들을 순차 실행하고 결과를 tool 메시지로 history 에 넣는다(부모 ack 되먹임).
    for (const tc of toolCalls) {
      if (turn.interrupted) return;
      let argsObj = {};
      try { argsObj = JSON.parse(tc.arguments || '{}'); } catch { argsObj = {}; }
      const intent = toolCallToIntent(tc.name, argsObj, tc.id);
      let content;
      if (!intent) {
        content = `error: unknown tool ${tc.name}`;
      } else {
        const ack = await emitToolAndWait(intent);
        if (turn.interrupted) return;
        content =
          ack && typeof ack.output === 'string' && ack.output.length
            ? ack.output
            : ack && ack.ok ? 'ok' : 'failed';
      }
      convo.push({ role: 'tool', tool_call_id: tc.id, content: String(content) });
    }
    capConvo();
  }
  // 단계 상한 도달: 사용자가 빈 응답으로 남지 않도록 짧은 안내.
  emit({ type: 'token', delta: '\n[reached tool step limit]' });
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
async function runTurn(text, lang, turn, opts = {}) {
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

  // 2) 평범한 텍스트가 있으면(또는 이미지가 첨부됐으면) 응답을 흘린다.
  //    - 이미지-only(텍스트 빈) 메시지도 에이전트가 이미지를 보도록 LLM 을 호출한다.
  //    - 도구만 있고 텍스트/이미지가 없으면 토큰 없이 종료 가능(기존 동작 보존).
  const plain = plainLines.join('\n');
  const hasImage = !!(opts && opts.image);
  if (plain.length > 0 || hasImage) {
    if (STUB_MODE) {
      // 스텁 모드: 실 네트워크 없이 결정적 에코(이미지가 있으면 표식만 덧붙여 비전 경로를 표면화).
      await streamEchoReply(plain + (hasImage ? '\n[image attached]' : ''), lang, turn);
    } else {
      // 실 모드: function-calling 에이전트 루프(도구로 파일 저장/실행 가능 + 비전/reasoning_effort).
      await runLlmAgent(plain, lang, turn, { image: opts.image, reasoningEffort: opts.reasoningEffort });
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
    // 부모가 직전 도구 실행을 마침 — 결과(ok/output)를 resolver 로 넘겨 LLM 루프가 되먹이게 한다.
    if (toolAck) {
      const r = toolAck;
      toolAck = null;
      r(msg.result); // {ok, output, callId} | undefined(수동 !경로/하위호환)
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
    // Feature A/B: image {absPath, mime}, reasoningEffort 를 이 턴 옵션으로 전달.
    const opts = {
      image:
        msg.image && typeof msg.image === 'object' && typeof msg.image.absPath === 'string'
          ? { absPath: msg.image.absPath, mime: String(msg.image.mime || '') }
          : undefined,
      reasoningEffort: typeof msg.reasoningEffort === 'string' ? msg.reasoningEffort : undefined,
    };
    runTurn(msg.text, msg.lang, turn, opts)
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
