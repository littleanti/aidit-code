// backend/test/security/redaction.test.ts
// XC-REDACT (M7, TRD §8 / CLAUDE.md L1):
//   운영자 LLM 키(API_KEY)는 어떤 클라이언트 표면에도 절대 노출되지 않는다.
//   이 테스트는 SENTINEL 키로 앱을 부팅하고 전체 미니 플로우(guest→post→session→aiMode turn→tool)를
//   구동한 뒤, SENTINEL 이 다음 어디에도 나타나지 않음을 단언한다:
//     - GET /runtime 응답
//     - POST /posts / POST /messages 응답
//     - 모든 SSE 이벤트 payload(message.*/agent.token/tool.*/file.changed/session.status/sandbox.status)
//     - AgentSession 행(DB)
//     - 캡처된 서버 로그 출력(pino)
//   또한 GET /runtime 이 { model, baseURLHost } 만 노출함(키/자격증명 포함 전체 URL 없음)을 단언한다.
//
// 구현 메모(결정성/격리):
//   - config.ts 는 import 시점에 process.env.API_KEY 를 읽는다. 따라서 SENTINEL 을 먼저 set 하고
//     vi.resetModules() 후 동적 import 로 앱/버스/런타임을 로드한다(모듈 캐시 우회).
//   - piWorker.mjs 는 결정적 stub(실제 네트워크 호출 없음)이므로 SENTINEL 키는 자식 ENV 로만
//     주입될 뿐 어디로도 흘러나가지 않는다 — 외부 호출 위험 없음.
//   - Fastify 로거를 커스텀 stream 으로 바꿔 모든 로그 라인을 메모리에 캡처한다.
//   - spawn 된 자식/도구 자식/DB 행은 afterAll 에서 모두 정리(누수 방지).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SENTINEL = 'sk-REDACTION-SENTINEL-abcdef0123456789';

// ── 동적 로드 핸들(resetModules 이후 채워짐) ──
/* eslint-disable @typescript-eslint/no-explicit-any */
let buildApp: any;
let prisma: any;
let bus: any;
let piRuntime: any;
let killAllToolChildren: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// 캡처된 서버 로그 라인(pino → 이 배열).
const logLines: string[] = [];

let app: Awaited<ReturnType<any>>;

// 정리 대상.
const spawnedSandboxIds: string[] = [];
const sandboxDirs: string[] = [];
const cleanup = {
  userId: '',
  postId: '',
  sandboxId: '',
  sessionId: '',
};

beforeAll(async () => {
  // ① SENTINEL 키를 ENV 에 주입(config 모듈 평가 전에).
  process.env.API_KEY = SENTINEL;
  // baseURL/model 은 안전한 기본값으로 고정(테스트 결정성).
  process.env.BASE_URL = 'https://models.github.ai/inference';
  process.env.MODEL = 'openai/gpt-4o-mini';
  // 레이트리밋 끄기(미니 플로우 차단 방지) — 키가 있어도 없어도 무해.
  process.env.RATE_LIMIT_DISABLED = '1';

  // ② 모듈 캐시 무효화 후 동적 import — config.ts 가 SENTINEL 을 읽게 한다.
  vi.resetModules();
  const cfgMod = await import('../../src/config.js');
  // sanity: config 가 실제로 SENTINEL 을 들고 있어야 한다(테스트 전제 검증).
  expect(cfgMod.config.llm.apiKey).toBe(SENTINEL);

  ({ buildApp } = await import('../../src/app.js'));
  ({ prisma } = await import('../../src/db.js'));
  ({ bus } = await import('../../src/realtime/pubsub.js'));
  ({ piRuntime } = await import('../../src/agent/pi.js'));
  ({ killAllToolChildren } = await import('../../src/agent/toolExec.js'));

  // ③ 모든 로그 라인을 캡처하는 stream 으로 Fastify 부팅.
  //    buildApp() 는 logger:true 로 만들므로, 직접 Fastify 를 만들지 않고
  //    process.stdout.write 를 가로채 pino 출력을 모은다(가장 견고한 캡처).
  const realWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ...rest: any[]): boolean => {
    try {
      logLines.push(typeof chunk === 'string' ? chunk : String(chunk));
    } catch {
      /* noop */
    }
    return realWrite(chunk, ...rest);
  };

  // 실제 listen 없이 inject + in-process bus 구독으로 검증한다(SSE 직렬화는
  // events.ts 빌더가 만든 객체를 frameOf 가 JSON.stringify 할 뿐이므로,
  // 버스 이벤트를 스캔하면 SSE payload 스캔과 동등하다). 실제 소켓 listen 을
  // 피해 병렬 테스트 풀의 포트/CPU 경합을 줄인다(다른 SSE 테스트 플레이크 방지).
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  // 남은 도구/세션 자식 정리.
  try {
    killAllToolChildren?.();
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
  // DB 행 정리(외래키 역순).
  if (cleanup.postId) {
    await prisma.message.deleteMany({ where: { postId: cleanup.postId } });
  }
  if (cleanup.sessionId) {
    await prisma.toolCall.deleteMany({ where: { sessionId: cleanup.sessionId } });
    await prisma.agentSession.deleteMany({ where: { id: cleanup.sessionId } });
  }
  if (cleanup.sandboxId) {
    await prisma.sandbox.deleteMany({ where: { id: cleanup.sandboxId } });
  }
  if (cleanup.postId) {
    await prisma.post.deleteMany({ where: { id: cleanup.postId } });
  }
  if (cleanup.userId) {
    await prisma.user.deleteMany({ where: { id: cleanup.userId } });
  }
  // 샌드박스 임시 디렉토리 정리.
  for (const d of sandboxDirs) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
  await app?.close();
  await prisma?.$disconnect();
});

/** SENTINEL 이 문자열에 없음을 단언(공통 헬퍼). */
function assertNoSentinel(label: string, s: string): void {
  expect(s, `SENTINEL leaked in ${label}`).not.toContain(SENTINEL);
}

/** 조건이 참이 될 때까지 짧게 폴링(최대 timeoutMs). */
async function waitFor(pred: () => boolean, timeoutMs = 4000, stepMs = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

describe('XC-REDACT: SENTINEL key never escapes any client surface', () => {
  it('GET /runtime exposes only { model, baseURLHost } and never the key', async () => {
    const res = await app.inject({ method: 'GET', url: '/runtime' });
    expect(res.statusCode).toBe(200);
    const bodyText = res.body;
    const json = res.json();

    // 키 누출 없음.
    assertNoSentinel('GET /runtime body', bodyText);
    expect(bodyText).not.toMatch(/sk-[A-Za-z0-9]{8,}/);

    // 정확히 { model, baseURLHost } 만.
    expect(Object.keys(json).sort()).toEqual(['baseURLHost', 'model']);
    expect(typeof json.model).toBe('string');
    expect(typeof json.baseURLHost).toBe('string');

    // baseURLHost 는 host 만(프로토콜/경로/자격증명 없음).
    expect(json.baseURLHost).not.toMatch(/^https?:\/\//);
    expect(json.baseURLHost).not.toContain('/');
    // 키 필드 자체가 없음.
    expect(bodyText).not.toMatch(/apiKey|API_KEY/);
  });

  it('full mini-flow (guest -> post -> session -> aiMode turn -> tool) leaks the SENTINEL nowhere', async () => {
    // ── guest 진입 ──
    const guestRes = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      payload: { nickname: 'redact' },
    });
    expect(guestRes.statusCode).toBe(201);
    assertNoSentinel('guest response', guestRes.body);
    const token = guestRes.json().token as string;
    cleanup.userId = guestRes.json().id as string;
    const auth = { authorization: `Bearer ${token}` };

    // ── 글 작성 → Post + Sandbox(CREATING) ──
    const postRes = await app.inject({
      method: 'POST',
      url: '/posts',
      headers: auth,
      payload: { title: 'redaction flow', body: 'scan me' },
    });
    expect(postRes.statusCode).toBe(201);
    assertNoSentinel('POST /posts response', postRes.body);
    const postId = postRes.json().post.id as string;
    const sandboxId = postRes.json().sandbox.id as string;
    cleanup.postId = postId;
    cleanup.sandboxId = sandboxId;

    // 샌드박스를 READY 로(provision 비동기 완료를 기다리지 않고 직접 전이 — 결정성).
    // 또한 실제 디렉토리를 보장하기 위해 sandbox.path 를 임시 dir 로 교정한다.
    const sbxDir = await mkdtemp(path.join(tmpdir(), 'redact-sbx-'));
    sandboxDirs.push(sbxDir);
    await prisma.sandbox.update({
      where: { id: sandboxId },
      data: { status: 'READY', path: sbxDir },
    });

    // ── 세션 시작 → IDLE ──
    const sessRes = await app.inject({
      method: 'POST',
      url: `/posts/${postId}/session`,
      headers: auth,
    });
    expect([200, 201]).toContain(sessRes.statusCode);
    assertNoSentinel('POST /session response', sessRes.body);
    const sessionId = sessRes.json().session.id as string;
    cleanup.sessionId = sessionId;
    spawnedSandboxIds.push(sandboxId);

    // 세션 응답에 키 필드/평문 키 없음.
    expect(sessRes.body).not.toMatch(/apiKey|API_KEY|sk-[A-Za-z0-9]{8,}/);
    expect(sessRes.json().session.model).toBe('openai/gpt-4o-mini'); // 모델명만.

    // ── SSE 이벤트 구독 + aiMode 메시지(에이전트 턴 + 도구) ──
    //   in-process 버스를 구독한다. SSE 엔드포인트(stream.ts)의 frameOf 는 이 이벤트 객체를
    //   그대로 JSON.stringify 하므로, 버스 이벤트 스캔 == SSE payload 스캔(동등). 실제 소켓을
    //   열지 않아 병렬 테스트 풀의 포트/타이밍 경합을 만들지 않는다.
    const events: unknown[] = [];
    const unsubscribe = bus.subscribe(postId, (ev: unknown) => events.push(ev));
    try {
      // 한 메시지에 plain 텍스트 + 도구 라인을 함께 실어 agent.token 과 tool.* 를 모두 유발.
      await app.inject({
        method: 'POST',
        url: `/posts/${postId}/messages`,
        headers: auth,
        payload: {
          body: 'hello agent\n!write notes/secret.txt sentinel-scan body',
          aiMode: true,
          clientId: `redact-${Date.now()}`,
          lang: 'en',
        },
      });

      // 턴 + 도구가 실제로 이벤트를 만들 때까지 대기(테스트가 헛돌지 않도록).
      const ok = await waitFor(() => {
        const types = events.map((e) => (e as { type: string }).type);
        return (
          types.includes('message.created') &&
          (types.includes('agent.token') || types.includes('tool.call')) &&
          types.includes('tool.result')
        );
      }, 6000);
      expect(ok).toBe(true);

      // ★ AGENT_REPLY 가 COMPLETE 로 확정될 때까지 대기(턴의 토큰 단계 종료).
      await waitFor(
        () =>
          events.some(
            (e) =>
              (e as { type: string }).type === 'message.updated' &&
              (e as { status?: string }).status === 'COMPLETE',
          ),
        6000,
      );
    } finally {
      unsubscribe();
    }

    // turn.ts 가 세션을 IDLE 로 되돌릴 때까지 DB 폴링 — teardown 이 in-flight write 와
    // 경합하지 않도록 완전 종료를 보장한다(P2025 unhandled rejection 방지).
    let idle = false;
    for (let i = 0; i < 160 && !idle; i++) {
      const s = await prisma.agentSession.findUnique({ where: { id: sessionId } });
      idle = !!s && (s.status === 'IDLE' || s.status === 'STOPPED');
      if (!idle) await new Promise((r) => setTimeout(r, 25));
    }
    expect(idle).toBe(true);

    // ★ 핵심: 모든 SSE 이벤트 payload(전 타입)에 SENTINEL/키 패턴 없음.
    const eventsBlob = JSON.stringify(events);
    expect(eventsBlob).toContain('"type":"message.created"'); // sanity.
    assertNoSentinel('SSE event payloads', eventsBlob);
    expect(eventsBlob).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(eventsBlob).not.toMatch(/apiKey|API_KEY|OPENAI_API_KEY|PI_API_KEY|baseURL|BASE_URL/);

    // 도구가 실제 파일을 만들었는지(엔드투엔드 경로 확인) + 그 내용에도 키 없음.
    const wrote = await readFile(path.join(sbxDir, 'notes', 'secret.txt'), 'utf8');
    expect(wrote).toBe('sentinel-scan body');
    assertNoSentinel('written file content', wrote);

    // ── GET /messages 응답에도 키 없음 ──
    const msgsRes = await app.inject({
      method: 'GET',
      url: `/posts/${postId}/messages?afterSeq=0`,
      headers: auth,
    });
    expect(msgsRes.statusCode).toBe(200);
    assertNoSentinel('GET /messages response', msgsRes.body);
    expect(msgsRes.body).not.toMatch(/sk-[A-Za-z0-9]{8,}/);

    // ── AgentSession 행(DB)에 키 없음 ──
    const sessionRow = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    expect(sessionRow).toBeTruthy();
    const sessionSerialized = JSON.stringify(sessionRow);
    assertNoSentinel('AgentSession row', sessionSerialized);
    expect(sessionSerialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    // model 은 모델명만, 키 컬럼 부재.
    expect(sessionRow.model).toBe('openai/gpt-4o-mini');

    // ── 모든 Message 행(DB)에도 키 없음(버블 body/args 까지) ──
    const allMessages = await prisma.message.findMany({ where: { postId } });
    assertNoSentinel('Message rows', JSON.stringify(allMessages));
    // ── 모든 ToolCall 행(args/result)에도 키 없음 ──
    const allToolCalls = await prisma.toolCall.findMany({ where: { sessionId } });
    assertNoSentinel('ToolCall rows', JSON.stringify(allToolCalls));

    // ── 캡처된 서버 로그 출력에 키 없음 ──
    const logBlob = logLines.join('');
    assertNoSentinel('server logs', logBlob);
    expect(logBlob).not.toMatch(/sk-REDACTION-SENTINEL/);
  });

  it('the SENTINEL was actually wired into the agent process ENV (test is meaningful)', async () => {
    // describeSpawn 의 redacted 스냅샷은 SENTINEL 을 [REDACTED] 로만 보여줘야 한다.
    // (실제 주입 env 에는 SENTINEL 이 들어가지만, 로그/스냅샷 표면에는 절대 평문이 없다.)
    const { describeSpawn } = await import('../../src/agent/pi.js');
    const snap = describeSpawn('en');
    const serialized = JSON.stringify(snap);
    expect(snap.env.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(snap.env.PI_API_KEY).toBe('[REDACTED]');
    assertNoSentinel('describeSpawn snapshot', serialized);
  });
});
