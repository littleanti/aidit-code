// backend/test/e2e.test.ts
// XC-T — 마일스톤 캡핑 통합/E2E 여정(PLAN §M7, TRD §4·§5·§6·§7).
// 단일 엔드투엔드 시나리오를 app.inject(HTTP) + in-process 실시간 버스 구독으로 구동한다:
//   J1  글 작성 → Sandbox CREATING → READY (sandbox.status 이벤트로 관측)
//   J2  세션 시작 → IDLE (session.status STARTING→IDLE)
//   J3  aiMode HUMAN 전송 → AGENT_REPLY 스트리밍(agent.token) → COMPLETE(message.updated)
//   J4  도구 턴(!write + !shell) → tool.call/tool.output/tool.result + 샌드박스 실제 파일 + file.changed
// 단언:
//   - 이벤트 seq 단조 증가(SSE id 앵커: message.created/agent.token).
//   - 두 동시 구독자가 동일한 라이브 이벤트 시퀀스를 본다(fan-out 동등성).
//   - SSE 와이어 직렬화 동등: 각 이벤트는 stream.ts 의 frameOf 와 동일한 JSON.stringify 로
//     실리며 키 누출이 없다(여기서 동일 직렬화를 재현해 검증).
//   - 키 누출 없음(전 표면: 응답/이벤트/DB).
// 결정성/격리: stub piWorker(실제 네트워크 없음). 실제 소켓 listen 을 쓰지 않아
//   병렬 테스트 풀의 포트/타이밍 경합을 만들지 않는다(다른 SSE 테스트 플레이크 방지).
//   spawn 자식/도구 자식/DB 행은 afterAll 에서 정리.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { stat, readFile, rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { bus } from '../src/realtime/pubsub.js';
import type { RealtimeEvent } from '../src/realtime/events.js';
import { piRuntime } from '../src/agent/pi.js';
import { killAllToolChildren } from '../src/agent/toolExec.js';

let app: FastifyInstance;
let token = '';

const created = {
  userId: '',
  postId: '',
  sandboxId: '',
  sandboxPath: '',
  sessionId: '',
};
const spawnedSandboxIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const guest = await app.inject({
    method: 'POST',
    url: '/auth/guest',
    payload: { nickname: 'e2e' },
  });
  token = guest.json().token as string;
  created.userId = guest.json().id as string;
});

afterAll(async () => {
  try {
    killAllToolChildren();
  } catch {
    /* noop */
  }
  for (const sid of spawnedSandboxIds) {
    try {
      await piRuntime.suspend({ id: 's', sandboxId: sid });
    } catch {
      /* noop */
    }
  }
  if (created.postId) await prisma.message.deleteMany({ where: { postId: created.postId } });
  if (created.sessionId) {
    await prisma.toolCall.deleteMany({ where: { sessionId: created.sessionId } });
    await prisma.agentSession.deleteMany({ where: { id: created.sessionId } });
  }
  if (created.sandboxId) await prisma.sandbox.deleteMany({ where: { id: created.sandboxId } });
  if (created.postId) await prisma.post.deleteMany({ where: { id: created.postId } });
  if (created.userId) await prisma.user.deleteMany({ where: { id: created.userId } });
  if (created.sandboxPath) {
    try {
      await rm(created.sandboxPath, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  await app.close();
  await prisma.$disconnect();
});

const auth = () => ({ authorization: `Bearer ${token}` });

/** stream.ts 의 frameOf 와 동일한 SSE 와이어 직렬화(검증 동등성용). */
function eventSeqId(ev: RealtimeEvent): number | null {
  if (ev.type === 'message.created') return ev.message.seq;
  if (ev.type === 'agent.token') return ev.seq;
  return null;
}
function frameOf(ev: RealtimeEvent): string {
  const id = eventSeqId(ev);
  const idLine = id != null ? `id: ${id}\n` : '';
  return `${idLine}event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** 조건이 참이 될 때까지 짧게 폴링(최대 timeoutMs). */
async function waitFor(pred: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

/** 세션이 종료 상태(IDLE/STOPPED)로 돌아갈 때까지 DB 폴링(턴 완전 종료 보장). */
async function waitSessionSettled(sessionId: string): Promise<boolean> {
  for (let i = 0; i < 240; i++) {
    const s = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (s && (s.status === 'IDLE' || s.status === 'STOPPED')) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const NO_KEY = /apiKey|API_KEY|baseURL|BASE_URL|OPENAI_API_KEY|PI_API_KEY|sk-[A-Za-z0-9]{8,}/;

describe('XC-T: end-to-end milestone journey with fan-out', () => {
  it('J1..J4 drive the full flow; two concurrent subscribers see identical ordered events', async () => {
    // ── J1: 글 작성 → Sandbox CREATING ──
    const postRes = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: auth(),
      payload: { title: 'e2e journey', body: 'capstone' },
    });
    expect(postRes.statusCode).toBe(201);
    const postId = postRes.json().post.id as string;
    const sandbox = postRes.json().sandbox as { id: string; status: string; path: string };
    created.postId = postId;
    created.sandboxId = sandbox.id;
    created.sandboxPath = sandbox.path;
    expect(sandbox.status).toBe('CREATING');
    expect(postRes.body).not.toMatch(NO_KEY);

    // ── 두 동시 구독자(in-process fan-out) 연결 — fan-out 동등성 검증용. ──
    //    같은 버스 채널(postId)을 두 번 구독한다. SSE 엔드포인트(stream.ts)도 동일 버스를
    //    소비하므로, 두 구독자의 동일 수신은 SSE fan-out 동등성을 증명한다.
    const framesA: RealtimeEvent[] = [];
    const framesB: RealtimeEvent[] = [];
    const unsubA = bus.subscribe(postId, (ev: RealtimeEvent) => framesA.push(ev));
    const unsubB = bus.subscribe(postId, (ev: RealtimeEvent) => framesB.push(ev));

    try {
      // J1: provision 비동기(fire-and-forget)가 CREATING → READY 로 전이하며 sandbox.status publish.
      const sawReady = await waitFor(() =>
        framesA.some((f) => f.type === 'sandbox.status' && f.status === 'READY'),
      );
      expect(sawReady).toBe(true);
      const sbxRow = await prisma.sandbox.findUnique({ where: { id: sandbox.id } });
      expect(sbxRow!.status).toBe('READY');

      // ── J2: 세션 시작 → IDLE ──
      const sessRes = await app.inject({
        method: 'POST',
        url: `/posts/${postId}/session`,
        headers: auth(),
      });
      expect([200, 201]).toContain(sessRes.statusCode);
      const sessionId = sessRes.json().session.id as string;
      created.sessionId = sessionId;
      spawnedSandboxIds.push(sandbox.id);
      expect(sessRes.json().session.status).toBe('IDLE');
      expect(sessRes.body).not.toMatch(NO_KEY);

      const sawIdle = await waitFor(() =>
        framesA.some((f) => f.type === 'session.status' && f.status === 'IDLE'),
      );
      expect(sawIdle).toBe(true);

      // ── J3: aiMode HUMAN(plain) → AGENT_REPLY 스트리밍 → COMPLETE ──
      const j3Res = await app.inject({
        method: 'POST',
        url: `/posts/${postId}/messages`,
        headers: auth(),
        payload: {
          body: 'hello agent please reply',
          aiMode: true,
          clientId: `e2e-j3-${Date.now()}`,
          lang: 'en',
        },
      });
      expect(j3Res.statusCode).toBe(201);
      expect(j3Res.body).not.toMatch(NO_KEY);

      const sawAgentComplete = await waitFor(
        () =>
          framesA.some((f) => f.type === 'agent.token') &&
          framesA.some((f) => f.type === 'message.updated' && f.status === 'COMPLETE'),
        6000,
      );
      expect(sawAgentComplete).toBe(true);

      // 누적 토큰 본문 에코 검증.
      const tokenDeltas = framesA
        .filter((f): f is Extract<RealtimeEvent, { type: 'agent.token' }> => f.type === 'agent.token')
        .map((f) => f.delta)
        .join('');
      expect(tokenDeltas).toContain('echo');
      expect(tokenDeltas).toContain('hello agent please reply');

      // J3 턴 완전 종료 대기(다음 턴/teardown 경합 방지).
      expect(await waitSessionSettled(sessionId)).toBe(true);

      // ── J4: 도구 턴(!write + !shell) → tool.* + 실제 파일 + file.changed ──
      const beforeTool = framesA.length;
      const j4Res = await app.inject({
        method: 'POST',
        url: `/posts/${postId}/messages`,
        headers: auth(),
        payload: {
          body: '!write out/e2e.txt hello e2e file\n!shell echo done',
          aiMode: true,
          clientId: `e2e-j4-${Date.now()}`,
          lang: 'en',
        },
      });
      expect(j4Res.statusCode).toBe(201);

      const sawTool = await waitFor(() => {
        const fr = framesA.slice(beforeTool);
        return (
          fr.some((f) => f.type === 'tool.call') &&
          fr.some((f) => f.type === 'tool.output') &&
          fr.some((f) => f.type === 'tool.result') &&
          fr.some((f) => f.type === 'file.changed')
        );
      }, 6000);
      expect(sawTool).toBe(true);

      // tool.* 순서: 첫 tool.call < 첫 tool.output < 첫 tool.result.
      const callIdx = framesA.findIndex((f, i) => i >= beforeTool && f.type === 'tool.call');
      const outIdx = framesA.findIndex((f, i) => i >= beforeTool && f.type === 'tool.output');
      const resIdx = framesA.findIndex((f, i) => i >= beforeTool && f.type === 'tool.result');
      expect(callIdx).toBeGreaterThanOrEqual(0);
      expect(callIdx).toBeLessThan(outIdx);
      expect(outIdx).toBeLessThan(resIdx);

      // tool.result SUCCEEDED 가 적어도 하나(write).
      const toolResults = framesA
        .slice(beforeTool)
        .filter((f): f is Extract<RealtimeEvent, { type: 'tool.result' }> => f.type === 'tool.result');
      expect(toolResults.some((r) => r.status === 'SUCCEEDED')).toBe(true);

      // 샌드박스 안에 실제 파일 생성됨(file.changed 를 봤으므로 존재 보장 — 안전망 폴링).
      const target = `${created.sandboxPath}/out/e2e.txt`;
      let fileExists = false;
      for (let i = 0; i < 120 && !fileExists; i++) {
        try {
          await stat(target);
          fileExists = true;
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      expect(fileExists).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('hello e2e file');

      // file.changed payload 가 경로만(키 없음) 담고 out/e2e.txt 를 가리킴.
      const fileEv = framesA
        .slice(beforeTool)
        .find((f): f is Extract<RealtimeEvent, { type: 'file.changed' }> => f.type === 'file.changed');
      expect(fileEv).toBeTruthy();
      expect(fileEv!.path).toBe('out/e2e.txt');

      // J4 턴 완전 종료 대기(teardown 이 in-flight write 와 경합하지 않도록).
      expect(await waitSessionSettled(sessionId)).toBe(true);
      // 두 구독자의 마지막 프레임이 도착하도록 짧게 더 수신.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      unsubA();
      unsubB();
    }

    // ── seq 단조 증가(SSE id 앵커: message.created / agent.token 만 id 보유). ──
    const ids = framesA.map(eventSeqId).filter((x): x is number => x != null);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThanOrEqual(ids[i - 1]); // 비감소(같은 메시지 토큰은 동률).
    }
    const msgSeqs = framesA
      .filter((f): f is Extract<RealtimeEvent, { type: 'message.created' }> => f.type === 'message.created')
      .map((f) => f.message.seq);
    for (let i = 1; i < msgSeqs.length; i++) {
      expect(msgSeqs[i]).toBeGreaterThan(msgSeqs[i - 1]); // message.created 는 엄격 증가.
    }

    // ── fan-out 동등성: 두 구독자가 동일 이벤트를 동일 순서로 본다(SSE 와이어 직렬화 동등 포함). ──
    expect(framesB.length).toBe(framesA.length);
    const wireA = framesA.map(frameOf);
    const wireB = framesB.map(frameOf);
    expect(wireB).toEqual(wireA);
    expect(wireA.length).toBeGreaterThan(0);

    // SSE 와이어 프레임 형식 sanity: id/event/data 라인 + 키 누출 없음.
    const wireBlob = wireA.join('');
    expect(wireBlob).toContain('event: message.created');
    expect(wireBlob).toMatch(/event: (agent\.token|tool\.call)/);
    expect(wireBlob).toContain('event: tool.result');
    expect(wireBlob).toContain('event: file.changed');
    expect(wireBlob).not.toMatch(NO_KEY);

    // ── 전 표면 키 누출 없음(DB 행). ──
    const sessionRow = await prisma.agentSession.findUnique({ where: { id: created.sessionId } });
    expect(JSON.stringify(sessionRow)).not.toMatch(NO_KEY);
    expect(sessionRow!.model).toBe('openai/gpt-4o-mini'); // 모델명만.
    const allMsgs = await prisma.message.findMany({ where: { postId } });
    expect(JSON.stringify(allMsgs)).not.toMatch(NO_KEY);
    const allTools = await prisma.toolCall.findMany({ where: { sessionId: created.sessionId } });
    expect(JSON.stringify(allTools)).not.toMatch(NO_KEY);

    // GET /messages 응답에도 키 없음(스냅샷 재생 경로 표면).
    const msgsRes = await app.inject({
      method: 'GET',
      url: `/posts/${postId}/messages?afterSeq=0`,
      headers: auth(),
    });
    expect(msgsRes.statusCode).toBe(200);
    expect(msgsRes.body).not.toMatch(NO_KEY);
  });
});
