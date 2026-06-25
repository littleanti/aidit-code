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
// ── 시뮬레이션 경계(SEAM) ───────────────────────────────────────────────
//   simulateTurn() 이 결정적(deterministic) PoC 응답을 토큰 청크로 흘린다.
//   실제 OpenAI-compatible 스트리밍 호출은 이 함수를 통째로 교체하면 된다(아래 TODO 참조).

import { createInterface } from 'node:readline';

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

/**
 * SEAM: 결정적 PoC 턴 시뮬레이션.
 * 입력 텍스트를 줄 단위로 보고, 도구 컨벤션 라인('!...')은 도구 의도로 방출(부모가 실행),
 * 그 외 텍스트는 KO/EN 에코 토큰으로 흘린다. NO real network.
 *
 * TODO(real runtime): 여기를 OpenAI-compatible 스트리밍 호출로 교체한다.
 *   - env 의 OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL 로 chat.completions(stream:true) 호출.
 *   - 각 SSE delta.content 를 emit({ type:'token', delta }) 로 흘리고, tool_call delta 는
 *     emit({ type:'tool', ... }) 로 방출(부모 toolBridge 가 실제 실행/이벤트화).
 *   - 완료 시 emit({ type:'done' }), 에러 시 emit({ type:'error', message })(키/원문 미노출).
 *   - turn.interrupted 가 true 가 되면 스트림을 abort 하고 즉시 done 으로 마감한다.
 */
async function simulateTurn(text, lang, turn) {
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

  // 2) 평범한 텍스트가 있으면 에코 토큰을 흘린다(도구만 있는 입력은 토큰 없이 종료 가능).
  const plain = plainLines.join('\n');
  if (plain.length > 0) {
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
    if (currentTurn) currentTurn.interrupted = true;
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
    if (currentTurn) currentTurn.interrupted = true;
    const turn = { interrupted: false };
    currentTurn = turn;
    simulateTurn(msg.text, msg.lang, turn)
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
