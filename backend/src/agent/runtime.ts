// backend/src/agent/runtime.ts
// AR-RT — AgentRuntime 인터페이스(교체 가능한 seam) + 런타임 레지스트리/팩토리.
//
// TRD §5.1: AgentRuntime 은 서버가 의존하는 추상 경계다. 실제 pi 바인딩 형태(프로세스 spawn /
//   in-proc SDK / 원격 RPC)는 이 인터페이스 뒤로 숨는다(PLAN §8 open question 1).
//   M3 PoC = process spawn(pi.ts). send/interrupt 는 M4(AR-TURN)에서 풀 스트리밍으로 구현.
//
// context/history/summary 는 런타임 책임(TRD §5.3) — 서버는 관리하지 않는다.
// 보안: 어떤 메서드도 apiKey 를 반환/로그하지 않는다(주입은 ENV 로만, pi.ts 참조).

import type { Sandbox, AgentSession } from '@prisma/client';
import type { RealtimeEvent } from '../realtime/events.js';
import type { ToolIntent, ToolAckResult, TurnOptions } from './pi.js';

/** 런타임이 서버로 흘려보내는 실시간 이벤트 emitter(토큰/툴/상태). M4 turn 스트리밍에서 사용. */
export type EmitFn = (event: RealtimeEvent) => void;

/** spawn 결과: 호스트 PID + 런타임 내부 세션 참조. */
export interface SpawnResult {
  pid: number;
  /** 런타임 고유 세션 식별자(프로세스 핸들 키 등). */
  sessionRef: string;
}

/**
 * 교체 가능한 에이전트 런타임 seam(TRD §5.1).
 * spawn/attach/suspend 는 M3 에서 동작. send/interrupt 는 M3 에서 stub, M4 에서 완성.
 */
export interface AgentRuntime {
  /** 샌드박스에 대해 에이전트 프로세스를 띄운다(STARTING -> IDLE). */
  spawn(sandbox: Pick<Sandbox, 'id' | 'path'>): Promise<SpawnResult>;

  /** 기존 활성 프로세스에 attach(멀티 클라이언트 fan-out — 새 프로세스 없음). */
  attach(session: Pick<AgentSession, 'id' | 'sandboxId'>): Promise<void>;

  /**
   * 사용자 입력을 현재 턴으로 전달한다(M4/AR-TURN 풀 스트리밍, TRD §5.1).
   * lang 은 응답 언어 힌트('ko'|'en' 등).
   * onToken 은 토큰 delta(에이전트 텍스트 조각)만 받는 콜백이다 — messageId/seq 는
   * 런타임이 알 수 없으므로(AR-TURN 이 부여) 토큰 텍스트만 흘리고, 이벤트 빌드/publish 는
   * 호출부(turn.ts)가 자신의 messageId/seq 로 수행한다.
   * Promise 는 턴이 완료(done)되면 resolve, 실패(error)/프로세스 종료 시 reject 된다.
   */
  send(
    session: Pick<AgentSession, 'id' | 'sandboxId'>,
    input: string,
    lang: string,
    onToken: (delta: string) => void,
    /**
     * 런타임이 방출하는 도구 실행 의도(M5/AR-TOOL). 호출부(turn.ts/toolBridge)가
     * 실제 fs/shell 효과를 경로 가드와 함께 내고 tool.* 이벤트로 표면화한 뒤,
     * ackTool 로 런타임을 다음 의도로 진행시킨다. 미지정 시 도구 의도는 무시된다.
     */
    onTool?: (intent: ToolIntent) => void,
    /**
     * 이 턴의 옵션(Feature A/B): image{absPath,mime}(비전 입력), reasoningEffort(low/medium/high).
     * 미지정이면 텍스트-only/필드 생략(기존 동작 보존).
     */
    options?: TurnOptions,
    /**
     * AR-MUX(M8): 디스패치 모드. true 면 turnId 멀티플렉싱 병렬 경로(같은 샌드박스 N개 동시 inflight),
     * false/미지정이면 FIFO 직렬(오늘과 100% 동일). '턴 옵션'이 아니라 '디스패치 정책'이므로
     * options(index 5)와 분리한 7번째 인자다(reasoningEffort.test 의 callArgs[5] 보호 + 워커 payload 누출 차단).
     * concurrent 여부는 호출부(turn.ts)가 sandbox.meta 의 concurrentTurns(getSandboxConcurrent)로 판정한다.
     */
    concurrent?: boolean,
    /**
     * XC-CAP(M8): per-user 1활성턴 게이트 식별자. null/미지정=게이트 면제(각 턴 독립).
     * concurrent 경로에서만 사용(레거시 FIFO 무영향). 워커 payload/이벤트/stdout 으로 미전달 —
     * 부모 메모리 게이트 판정 전용. 옵셔널 끝-인자이므로 기존 호출부(mock 포함) 무변경 컴파일.
     */
    userId?: string | null,
  ): Promise<void>;

  /**
   * 직전 도구 의도 실행 완료를 런타임에 알려 다음 의도로 진행시킨다(M5). 선택 구현.
   * result 는 LLM function-calling 루프 되먹임용(ok/output) — 미지정도 허용(하위호환).
   */
  ackTool?(session: Pick<AgentSession, 'sandboxId'>, result?: ToolAckResult, turnId?: string): void;

  /**
   * 현재 턴 인터럽트(옵션 steer 텍스트로 방향 전환). M4 에서 완성.
   * AR-MUX(M8): turnId 가 주어지면 그 concurrent 턴만 취소(다른 동시 턴 불간섭). 미지정이면 레거시 단일 턴.
   */
  interrupt(
    session: Pick<AgentSession, 'id' | 'sandboxId'>,
    steer?: string,
    turnId?: string,
  ): Promise<void>;

  /**
   * (선택) 해당 샌드박스에 진행 중(활성) 또는 대기열에 쌓인 턴이 있는지. 선택 구현.
   * 동시 질문을 FIFO 큐로 직렬화할 때, 호출부(turn.ts)가 "마지막 턴이 끝났는지"를 판별해
   * 세션 IDLE 전이를 한 번만(중간 깜빡임 없이) 수행하기 위한 질의다. 미구현이면 false 로 본다.
   */
  isBusy?(session: Pick<AgentSession, 'sandboxId'>): boolean;

  /** 프로세스를 내린다(디렉토리 보존). IDLE/RUNNING -> STOPPED. */
  suspend(session: Pick<AgentSession, 'id' | 'sandboxId'>): Promise<void>;

  /** (선택) 런타임 이벤트 스트림 구독. M4 에서 사용 가능. */
  streamEvents?(
    session: Pick<AgentSession, 'id' | 'sandboxId'>,
    emit: EmitFn,
  ): Promise<void>;
}

// ── 레지스트리/팩토리 ──────────────────────────────────────
// AGENT_RUNTIME env 로 구현을 선택(기본 'pi'). 실제 pi 가 붙을 seam.

import { piRuntime } from './pi.js';

const registry: Record<string, AgentRuntime> = {
  pi: piRuntime,
};

/**
 * 설정(AGENT_RUNTIME, 기본 'pi')에 따라 AgentRuntime 구현을 선택해 반환한다.
 * 미등록 키면 'pi' 로 폴백한다(PoC 안전).
 */
export function getAgentRuntime(): AgentRuntime {
  const key = process.env.AGENT_RUNTIME || 'pi';
  return registry[key] ?? registry.pi;
}
