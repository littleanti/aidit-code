// backend/src/agent/sessionStart.ts
// 세션 시작/attach 임계구역 공용 헬퍼(동시성 가드).
//
// 배경(TRD §5·§6, PLAN BE-SESS): 글 진입 시 자동 세션 시작이 같은 sandbox 로 고빈도 동시
//   호출을 유발한다. lookup→attach→spawn→create AgentSession 임계구역을 직렬화하지 않으면
//   다음 경합이 난다:
//     - Race A/D(process): pi.ts spawn 이 핸들을 무조건 덮어써 직전 live 자식을 고아로 만든다.
//     - Race B(messages/aiMode): attach 실패 시 stale 행만 닫고 정규화/spawn 을 안 해 null 반환.
//   이 헬퍼가 임계구역 전체를 한 곳에 캡슐화하고, per-sandbox mutex 로 같은 sandbox 호출을
//   하나의 in-flight Promise 로 coalesce 한다(프로세스 내 Race A/D 봉쇄). pi.ts spawn 멱등과
//   합쳐 같은 sandbox 에 자식/활성 세션이 둘 생기지 않게 한다.
//
// 보안(CLAUDE.md/TRD §8): apiKey 는 어떤 응답/이벤트/AgentSession 행에도 들어가지 않는다.
//   AgentSession.model 은 모델명만 저장(키 절대 미저장). 이벤트 payload 에도 키 필드 없음.

import { prisma } from '../db.js';
import { setSandboxStatus } from '../sandbox/service.js';
import { getAgentRuntime } from './runtime.js';
import { getLlmRuntimeConfig } from './config.js';
import { publishToPost } from '../realtime/publish.js';
import {
  makeSessionStatusEvent,
  type AgentSessionStatusValue,
} from '../realtime/events.js';

/** attach 대상으로 간주하는 활성 세션 상태(이미 살아있는 세션). */
export const ACTIVE_STATUSES: AgentSessionStatusValue[] = ['STARTING', 'IDLE', 'RUNNING'];

/** AgentSession 행(헬퍼가 반환하는 직렬화 이전 형태 — 키 필드는 애초에 없음). */
export interface SessionRow {
  id: string;
  sandboxId: string;
  status: string;
  model: string;
  runtimePid: number | null;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * startOrAttach 성공 결과.
 *   - attached=true: 기존 live 세션에 attach(새 spawn 없음, 200 응답 대상).
 *   - attached=false: 새 세션 fresh-start(201 응답 대상).
 */
export interface StartOrAttachOk {
  ok: true;
  session: SessionRow;
  attached: boolean;
}

/** startOrAttach 실패 결과(시작 불가 상태). reason 으로 호출부가 409 등으로 매핑. */
export interface StartOrAttachFail {
  ok: false;
  /** 'NOT_READY': 활성 세션이 없고 샌드박스가 READY/SUSPENDED 가 아님(CREATING/ERROR 등). */
  reason: 'NOT_READY';
  /** 진단용: 현재 샌드박스 상태(라우트 메시지 구성용). */
  sandboxStatus: string;
}

export type StartOrAttachResult = StartOrAttachOk | StartOrAttachFail;

/** startOrAttach 입력. sandbox 의 status 는 호출 시점 스냅샷(헬퍼가 내부에서 정규화). */
export interface StartOrAttachInput {
  postId: string;
  sandbox: { id: string; path: string; status: string };
}

/**
 * per-sandbox mutex(최우선 가드).
 * 같은 sandboxId 의 동시 호출을 하나의 in-flight Promise 로 coalesce 한다 —
 * 두 번째 호출은 첫 호출 결과를 그대로 await 하고, 자체 lookup/spawn 을 하지 않는다.
 * finally 에서 맵 엔트리를 제거한다(정확히 이 Promise 가 들어있을 때만).
 */
const inFlight = new Map<string, Promise<StartOrAttachResult>>();

/** session.status 이벤트를 post 채널로 fan-out. 키 필드 없음. */
function publishSessionStatus(
  postId: string,
  sessionId: string,
  status: AgentSessionStatusValue,
): void {
  publishToPost(postId, makeSessionStatusEvent({ sessionId, status }));
}

/**
 * 세션 시작/attach 임계구역 전체를 캡슐화한다(동작은 기존 라우트와 동일).
 *
 * 흐름:
 *   1) 활성(STARTING/IDLE/RUNNING) 세션 lookup.
 *   2) 있으면 runtime.attach():
 *        - 성공 → { attached:true }(새 프로세스 없음, 멀티 클라이언트 fan-out).
 *        - 실패(프로세스 소멸) → stale 행 STOPPED + stale RUNNING 샌드박스 → SUSPENDED 정규화
 *          후 fresh-start 경로로 진행(서버 재시작 후 resume; Race B 복구).
 *   3) fresh-start: 샌드박스가 READY/SUSPENDED 여야 함(아니면 { ok:false, reason:'NOT_READY' }).
 *        spawn(STARTING) → AgentSession 생성 → sandbox RUNNING → IDLE 전이.
 *
 * 동시성: 같은 sandboxId 의 호출은 mutex 로 coalesce 된다(한 번만 실행, 결과 공유).
 */
export async function startOrAttach(input: StartOrAttachInput): Promise<StartOrAttachResult> {
  const sandboxId = input.sandbox.id;

  // ── per-sandbox mutex: 진행 중 호출이 있으면 그 결과를 그대로 공유한다. ──
  const pending = inFlight.get(sandboxId);
  if (pending) {
    return await pending;
  }

  const run = (async (): Promise<StartOrAttachResult> => {
    return await runCriticalSection(input);
  })();

  inFlight.set(sandboxId, run);
  try {
    return await run;
  } finally {
    // 정확히 이 Promise 가 남아있을 때만 제거(다른 후속 호출의 엔트리를 지우지 않도록).
    if (inFlight.get(sandboxId) === run) {
      inFlight.delete(sandboxId);
    }
  }
}

/** 임계구역 본체(mutex 보호 아래에서만 호출됨). */
async function runCriticalSection(input: StartOrAttachInput): Promise<StartOrAttachResult> {
  const { postId } = input;
  // 로컬 가변 사본 — 정규화(RUNNING→SUSPENDED) 시 status 를 갱신해 fresh-start 가 최신 상태를 본다.
  const sandbox = { ...input.sandbox };

  const runtime = getAgentRuntime();

  // 1) 활성 세션 lookup.
  const existing = await prisma.agentSession.findFirst({
    where: { sandboxId: sandbox.id, status: { in: ACTIVE_STATUSES } },
    orderBy: { startedAt: 'desc' },
  });

  if (existing) {
    try {
      // 2) attach: live 면 no-op(멀티 클라이언트 fan-out).
      await runtime.attach({ id: existing.id, sandboxId: sandbox.id });
      return { ok: true, session: existing, attached: true };
    } catch {
      // attach 실패 = 활성 행은 있으나 프로세스가 사라진 비정상 상태(서버 재시작 후 전형).
      // stale 행을 닫고 fresh-start 경로로 진행한다.
      await prisma.agentSession.update({
        where: { id: existing.id },
        data: { status: 'STOPPED', endedAt: new Date() },
      });
      // stale RUNNING 정규화: 프로세스는 죽었지만 디렉토리는 보존됨 → 의미상 resume.
      // sandbox.status 가 RUNNING 이면 fresh-start 의 READY/SUSPENDED 가드에 걸려 409 가 나므로
      // RUNNING 만 SUSPENDED 로 전이해 resume 경로가 이를 받아들이게 한다(sandbox.status 이벤트도 publish).
      // CREATING/ERROR 는 진짜 시작 불가 상태이므로 그대로 두어 정상적으로 NOT_READY 가 나야 한다.
      if (sandbox.status === 'RUNNING') {
        const updated = await setSandboxStatus(sandbox.id, 'SUSPENDED');
        sandbox.status = updated.status;
      }
      // fresh-start 로 폴스루.
    }
  }

  // 3) fresh-start: 활성 세션이 없으니 새로 띄우려면 샌드박스가 READY 또는 SUSPENDED(resume) 여야 한다.
  if (sandbox.status !== 'READY' && sandbox.status !== 'SUSPENDED') {
    return { ok: false, reason: 'NOT_READY', sandboxStatus: sandbox.status };
  }

  const rt = getLlmRuntimeConfig(); // 내부 전용 — 응답/로그/이벤트에 절대 미포함.

  // spawn(STARTING). 디렉토리는 이미 존재(resume 도 동일 경로). pi.ts spawn 은 멱등(live 면 재사용).
  const { pid } = await runtime.spawn({ id: sandbox.id, path: sandbox.path });

  // AgentSession 행 생성: model 은 모델명만, runtimePid = pid, status STARTING.
  const created = await prisma.agentSession.create({
    data: {
      sandboxId: sandbox.id,
      status: 'STARTING',
      model: rt.model, // 모델명만. 키 절대 미저장.
      runtimePid: pid,
    },
  });
  publishSessionStatus(postId, created.id, 'STARTING');

  // 샌드박스 RUNNING(publishes sandbox.status).
  await setSandboxStatus(sandbox.id, 'RUNNING');

  // ready 신호를 받았으므로 IDLE 로 전이.
  const idle = await prisma.agentSession.update({
    where: { id: created.id },
    data: { status: 'IDLE' },
  });
  publishSessionStatus(postId, idle.id, 'IDLE');

  return { ok: true, session: idle, attached: false };
}
