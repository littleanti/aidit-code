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
//       { type: 'done' }                → 턴 정상 완료.
//       { type: 'error', message }      → 턴 실패(키/원문 미노출, 일반 메시지만).
//   - SIGTERM/SIGINT 수신 시 깨끗하게 종료(exit 0).
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

/**
 * SEAM: 결정적 PoC 턴 시뮬레이션.
 * lang 힌트(ko/en)에 따라 KO/EN 프리픽스를 붙이고, 입력을 에코하는 짧은 답변을
 * 단어 단위 토큰 청크로 흘린다. NO real network.
 *
 * TODO(real runtime): 여기를 OpenAI-compatible 스트리밍 호출로 교체한다.
 *   - env 의 OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL 로 chat.completions(stream:true) 호출.
 *   - 각 SSE delta.content 를 emit({ type:'token', delta }) 로 흘린다.
 *   - 완료 시 emit({ type:'done' }), 에러 시 emit({ type:'error', message })(키/원문 미노출).
 *   - turn.interrupted 가 true 가 되면 스트림을 abort 하고 즉시 done 으로 마감한다.
 */
async function simulateTurn(text, lang, turn) {
  const isKo = String(lang || '').toLowerCase().startsWith('ko');
  const prefix = isKo ? '[KO] 에코: ' : '[EN] echo: ';
  const reply = prefix + String(text ?? '');

  // 단어 경계로 분할하되 공백을 보존(누적 본문이 원문과 동일해지도록).
  const chunks = reply.match(/\S+\s*/g) ?? [reply];

  for (const delta of chunks) {
    if (turn.interrupted) return; // 인터럽트: 남은 토큰 방출 중단(부분 본문 보존).
    emit({ type: 'token', delta });
    // 다음 청크까지 잠깐 대기(인터럽트 수신 창 확보).
    await new Promise((r) => setTimeout(r, TOKEN_DELAY_MS));
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
