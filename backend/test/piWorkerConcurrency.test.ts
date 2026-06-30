// backend/test/piWorkerConcurrency.test.ts
// M8 AR-PAR 워커 턴 멀티플렉싱 검증 — piWorker.mjs child 를 STUB(AGENT_STUB=1)로 직접 spawn 해
//   turnId 프로토콜(선택 필드)을 stdin/stdout JSON-line 으로 직접 구동한다.
//   (AR-MUX 전이라 부모 pi.ts 는 아직 turnId 를 안 쓰므로, 워커 단독 spawn 이 유일한 검증 경로.)
//
// 검증 범위: 동시 2턴 비선점 / 토큰 turnId 태깅 / 양쪽 done / 도구 ack turnId 라우팅(교차 무오류) /
//   같은 turnId 재입력 선점 / 레거시 무-turnId 경로 동작 불변(선점 보존 + turnId 키 부재).
// NOTE: STUB 는 convo/도구 루프(실 LLM)를 안 타므로 tool_calls↔role:tool 짝 정합은 여기서 검증하지 않는다.
//   짝 정합은 §4 로직 + 기존 toolCall.test.ts(실 도구 경로, 레거시 SINGLE) green 으로 보강한다.
//   여기서는 동시성 라우팅/비선점만 검증한다.
//
// 스폰된 자식은 afterEach 에서 SIGTERM 으로 정리(누수 방지). Windows 안전(process.execPath + windowsHide).

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER_PATH = fileURLToPath(new URL('../src/agent/piWorker.mjs', import.meta.url));

let child: ChildProcess | null = null;
afterEach(() => {
  if (child) {
    child.kill('SIGTERM');
    child = null;
  }
});

interface WorkerEvent {
  type: string;
  delta?: string;
  turnId?: string;
  callId?: string;
  [k: string]: unknown;
}

function startWorker() {
  child = spawn(process.execPath, [WORKER_PATH], {
    env: { ...process.env, AGENT_STUB: '1', AGENT_TOKEN_DELAY_MS: '8' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const events: WorkerEvent[] = [];
  let buf = '';
  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => { readyResolve = r; });
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === 'ready') { readyResolve(); continue; }
      try { events.push(JSON.parse(line) as WorkerEvent); } catch { /* noop */ }
    }
  });
  const write = (obj: unknown) => child!.stdin!.write(JSON.stringify(obj) + '\n');
  return { events, ready, write };
}

/** 조건이 참이 될 때까지 events 를 폴링(타임아웃 안전). */
async function waitFor(pred: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const byTurn = (events: WorkerEvent[], id: string, type: string) =>
  events.filter((e) => e.turnId === id && e.type === type);
const tokenText = (events: WorkerEvent[], id: string) =>
  byTurn(events, id, 'token').map((e) => e.delta ?? '').join('');

describe('AR-PAR piWorker 턴 멀티플렉싱', () => {
  it('동시 2턴: 새 turnId 가 다른 턴을 선점하지 않고 둘 다 완주 + 토큰에 turnId echo', async () => {
    const { events, ready, write } = startWorker();
    await ready;

    write({ type: 'input', turnId: 'A', text: 'alpha alpha alpha alpha', lang: 'en' });
    write({ type: 'input', turnId: 'B', text: 'bravo', lang: 'en' });

    await waitFor(() => byTurn(events, 'A', 'done').length === 1 && byTurn(events, 'B', 'done').length === 1);

    // 양쪽 done 정확히 1회.
    expect(byTurn(events, 'A', 'done').length).toBe(1);
    expect(byTurn(events, 'B', 'done').length).toBe(1);

    // 비선점: A 가 잘리지 않고 'alpha' 를 모두 완주, B 는 'bravo' 완주.
    expect(tokenText(events, 'A')).toContain('alpha');
    expect(tokenText(events, 'B')).toContain('bravo');

    // 토큰/done turnId 정확히 echo.
    expect(byTurn(events, 'A', 'token').every((e) => e.turnId === 'A')).toBe(true);
    expect(byTurn(events, 'B', 'token').every((e) => e.turnId === 'B')).toBe(true);
  });

  it('도구 ack turnId 라우팅: 교차 ack 무오류(B ack 가 A 를 진행시키지 않음)', async () => {
    const { events, ready, write } = startWorker();
    await ready;

    // !write 는 두 모드 공통 도구 의도 방출 → STUB 에서도 네트워크 없이 검증 가능.
    write({ type: 'input', turnId: 'A', text: '!write a.txt hi', lang: 'en' });
    write({ type: 'input', turnId: 'B', text: '!write b.txt yo', lang: 'en' });

    // 각 턴의 tool intent 방출 대기.
    await waitFor(() => byTurn(events, 'A', 'tool').length === 1 && byTurn(events, 'B', 'tool').length === 1);
    expect(byTurn(events, 'A', 'done').length).toBe(0);
    expect(byTurn(events, 'B', 'done').length).toBe(0);

    // 부모 역할로 B 먼저 ack → B 만 done, A 는 아직 진행 안 됨.
    write({ type: 'tool-done', turnId: 'B', result: { ok: true, output: 'ok' } });
    await waitFor(() => byTurn(events, 'B', 'done').length === 1);
    expect(byTurn(events, 'A', 'done').length).toBe(0); // 교차 ack 아님 — A 미진행.

    // A ack 후에야 A done.
    write({ type: 'tool-done', turnId: 'A', result: { ok: true, output: 'ok' } });
    await waitFor(() => byTurn(events, 'A', 'done').length === 1);
    expect(byTurn(events, 'A', 'done').length).toBe(1);
    expect(byTurn(events, 'B', 'done').length).toBe(1);

    // tool intent 에도 turnId echo.
    expect(byTurn(events, 'A', 'tool').every((e) => e.turnId === 'A')).toBe(true);
    expect(byTurn(events, 'B', 'tool').every((e) => e.turnId === 'B')).toBe(true);
  });

  it('같은 turnId 재입력은 그 턴만 선점하고, 동시 진행 중인 다른 turnId 는 무영향', async () => {
    const { events, ready, write } = startWorker();
    await ready;

    write({ type: 'input', turnId: 'A', text: 'aaaa aaaa aaaa aaaa aaaa aaaa', lang: 'en' });
    write({ type: 'input', turnId: 'B', text: 'bravo', lang: 'en' });
    // 같은 turnId 'A' 재입력 → 첫 A 턴 선점(steer), B 무영향.
    write({ type: 'input', turnId: 'A', text: 'second', lang: 'en' });

    // B 는 정상 done, 재입력분 A 는 'second' 로 done.
    await waitFor(() => byTurn(events, 'B', 'done').length === 1 && byTurn(events, 'A', 'done').length >= 1);
    expect(byTurn(events, 'B', 'done').length).toBe(1);
    // A done 은 최종적으로 1회(첫 A 는 선점되어 done 억제, 재입력분만 done).
    expect(byTurn(events, 'A', 'done').length).toBe(1);
    expect(tokenText(events, 'A')).toContain('second');
  });

  it('레거시 무-turnId 입력: token/done 에 turnId 키 부재 + KO 에코', async () => {
    const { events, ready, write } = startWorker();
    await ready;

    write({ type: 'input', text: 'plain', lang: 'ko' });
    await waitFor(() => events.some((e) => e.type === 'done'));

    const tokens = events.filter((e) => e.type === 'token');
    const dones = events.filter((e) => e.type === 'done');
    // turnId 키가 객체에 아예 없어야 한다(오늘과 바이트 동일).
    expect(tokens.every((e) => !('turnId' in e))).toBe(true);
    expect(dones.every((e) => !('turnId' in e))).toBe(true);
    expect(dones.length).toBe(1);
    const text = tokens.map((e) => e.delta ?? '').join('');
    expect(text).toContain('[KO]');
    expect(text).toContain('plain');
  });

  it('레거시 연속 무-turnId 2입력: 첫 SINGLE 턴이 둘째에 선점(오늘 동작 보존) — done 1회, 둘째만 완주', async () => {
    const { events, ready, write } = startWorker();
    await ready;

    write({ type: 'input', text: 'first first first first first first', lang: 'en' });
    write({ type: 'input', text: 'lastonly', lang: 'en' });

    await waitFor(() => events.filter((e) => e.type === 'done').length === 1);
    // 잠깐 더 기다려 stale done 이 추가로 안 오는지 확인.
    await new Promise((r) => setTimeout(r, 200));

    const dones = events.filter((e) => e.type === 'done');
    expect(dones.length).toBe(1); // 첫 SINGLE 턴 선점 → done 억제.
    const text = events.filter((e) => e.type === 'token').map((e) => e.delta ?? '').join('');
    expect(text).toContain('lastonly'); // 둘째만 완주.
  });
});
