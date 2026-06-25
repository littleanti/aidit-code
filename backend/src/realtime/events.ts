// backend/src/realtime/events.ts
// 실시간 이벤트 스키마(TRD §7). post 채널로 fan-out 되는 모든 이벤트의 타입 단일 출처.
//
// 보안(TRD §8, CLAUDE.md): 이벤트 payload 는 LLM 키(apiKey/baseURL) 를 절대 담지 않는다.
//   - 클라이언트가 받는 것은 상태/토큰/툴/파일 변경뿐. 키 관련 필드를 추가하지 말 것.
//
// 확장 설계(M3~M6): RealtimeEvent 는 `type` 으로 판별하는 discriminated union 이다.
//   message.*, agent.token, tool.*, file.changed, session.status 는 후속 마일스톤에서
//   아래 union 에 멤버를 추가하기만 하면 된다(기존 멤버 변경 없이). M2 는 sandbox.status 만 필수.

/** TRD §3 SandboxStatus 와 1:1 (Prisma enum 과 동일 문자열). */
export type SandboxStatusValue =
  | 'CREATING'
  | 'READY'
  | 'RUNNING'
  | 'SUSPENDED'
  | 'ERROR';

/**
 * 샌드박스 상태 변화 이벤트(TRD §7).
 * payload: { sandboxId, status, lastActiveAt }. 키 필드 금지.
 */
export interface SandboxStatusEvent {
  type: 'sandbox.status';
  sandboxId: string;
  status: SandboxStatusValue;
  /** ISO8601 문자열(직렬화 안전). */
  lastActiveAt: string;
}

/**
 * 모든 실시간 이벤트의 discriminated union.
 * M2: sandbox.status 만. 후속 마일스톤에서 `| MessageCreatedEvent | AgentTokenEvent | ...` 로 확장.
 */
export type RealtimeEvent = SandboxStatusEvent;

/**
 * sandbox.status 이벤트 빌더.
 * lastActiveAt 은 Date | string 모두 받아 ISO 문자열로 정규화한다.
 * 키 같은 부가 필드는 받지 않음으로써 누출 가능성을 구조적으로 차단한다.
 */
export function makeSandboxStatusEvent(args: {
  sandboxId: string;
  status: SandboxStatusValue;
  lastActiveAt: Date | string;
}): SandboxStatusEvent {
  const { sandboxId, status, lastActiveAt } = args;
  return {
    type: 'sandbox.status',
    sandboxId,
    status,
    lastActiveAt:
      lastActiveAt instanceof Date ? lastActiveAt.toISOString() : lastActiveAt,
  };
}
