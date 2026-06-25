// backend/src/agent/runtime.ts
// AR-RT — AgentRuntime 인터페이스(교체 가능한 seam) + 런타임 레지스트리/팩토리.
//
// TRD §5.1: AgentRuntime 은 서버가 의존하는 추상 경계다. 실제 pi 바인딩 형태(프로세스 spawn /
//   in-proc SDK / 원격 RPC)는 이 인터페이스 뒤로 숨는다(PLAN §8 open question 1).
//   M3 PoC = process spawn(pi.ts). sendInput/interrupt 는 M4(AR-TURN)에서 풀 스트리밍으로 구현.
//
// context/history/summary 는 런타임 책임(TRD §5.3) — 서버는 관리하지 않는다.
// 보안: 어떤 메서드도 apiKey 를 반환/로그하지 않는다(주입은 ENV 로만, pi.ts 참조).

import type { Sandbox, AgentSession } from '@prisma/client';
import type { RealtimeEvent } from '../realtime/events.js';

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
 * spawn/attach/suspend 는 M3 에서 동작. sendInput/interrupt 는 M3 에서 stub, M4 에서 완성.
 */
export interface AgentRuntime {
  /** 샌드박스에 대해 에이전트 프로세스를 띄운다(STARTING -> IDLE). */
  spawn(sandbox: Pick<Sandbox, 'id' | 'path'>): Promise<SpawnResult>;

  /** 기존 활성 프로세스에 attach(멀티 클라이언트 fan-out — 새 프로세스 없음). */
  attach(session: Pick<AgentSession, 'id' | 'sandboxId'>): Promise<void>;

  /**
   * 사용자 입력을 현재 턴으로 전달한다(M4/AR-TURN 에서 풀 스트리밍).
   * lang 은 응답 언어 힌트. emit 으로 토큰/툴/상태 이벤트를 흘린다.
   */
  sendInput(
    session: Pick<AgentSession, 'id' | 'sandboxId'>,
    input: string,
    lang: string,
    emit: EmitFn,
  ): Promise<void>;

  /** 현재 턴 인터럽트(옵션 steer 텍스트로 방향 전환). M4 에서 완성. */
  interrupt(
    session: Pick<AgentSession, 'id' | 'sandboxId'>,
    steer?: string,
  ): Promise<void>;

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
