// src/lib/threadSelectors.ts
// FE-MULTI (M8): 동시 다중 턴 UI를 위한 순수 셀렉터(store/React/DOM 비의존).
// 스트림 누적은 threadStore가 담당한다 — 여기서는 messages(+RT-MULTI의 권위
// activeTurns)로부터 표시/게이팅 사실만 DERIVE 한다. node 환경 단위 테스트 대상.
import type { Message } from '../api/types';

export interface AttributionEntry {
  /** 이 AGENT_REPLY가 답하는 질문자 표시 이름. 절대 빈 문자열이 아니다. */
  questionerName: string;
  /** 답한 HUMAN의 authorId === 내 userId 이면 true. */
  isMine: boolean;
  /** 이 답글이 답하는 HUMAN 메시지 id(앵커 점프 대상), 없으면 null. */
  anchorHumanId: string | null;
}

export interface AttributionContext {
  postAuthorId: string | null;
  postAuthorName: string | null;
  myUserId: string | null;
  myUserName: string | null;
  /** i18n 폴백은 호출자가 미리 해석해 주입한다(순수성/React 비의존 유지). */
  youLabel: string; // t('thread.you')
  someoneLabel: string; // t('thread.someoneElse')
}

/** STREAMING|PENDING 상태의 AGENT_REPLY(=활성 에이전트 턴)인지. */
const isActiveAgentReply = (m: Message): boolean =>
  m.type === 'AGENT_REPLY' && (m.status === 'STREAMING' || m.status === 'PENDING');

/** messages를 id로 인덱싱(로컬 — 테스트는 이 경로를 사용). */
function indexById(messages: Message[]): Record<string, Message> {
  const byId: Record<string, Message> = {};
  for (const m of messages) byId[m.id] = m;
  return byId;
}

/** 동시 스트리밍 중인 에이전트 턴 수(STREAMING|PENDING AGENT_REPLY)를 센다. */
export function countActiveStreamingTurns(messages: Message[]): number {
  let n = 0;
  for (const m of messages) if (isActiveAgentReply(m)) n++;
  return n;
}

/**
 * 배지 카운트: 서버 권위값(activeTurns)이 제공되면(>0) 신뢰하고, 아니면 메시지
 * 파생 카운트로 폴백(SSE 지연에 강건). 배지도 서버값 0/미수신 시 파생 폴백.
 */
export function resolveActiveTurnsCount(
  activeSessionTurns: number | null | undefined,
  messages: Message[]
): number {
  if (typeof activeSessionTurns === 'number' && activeSessionTurns > 0) {
    return activeSessionTurns;
  }
  return countActiveStreamingTurns(messages);
}

/**
 * '내 활성 턴' 게이팅(self-concurrency=1). 어떤 활성 AGENT_REPLY가 authorId===
 * myUserId 인 HUMAN에 답하면 true. 남의 턴은 절대 나를 잠그지 않는다(HOL blocking
 * 제거). replyToId→HUMAN 체인을 따른다. 대상 HUMAN이 아직 스토어에 없으면
 * not-mine(과소잠금) — 그 짧은 갭은 Composer 로컬 `sending`이 커버한다.
 */
export function hasMyActiveTurn(messages: Message[], myUserId: string | null): boolean {
  if (!myUserId) return false;
  const byId = indexById(messages);
  for (const m of messages) {
    if (!isActiveAgentReply(m)) continue;
    const human = m.replyToId ? byId[m.replyToId] : undefined;
    if (human && human.authorId === myUserId) return true;
  }
  return false;
}

/**
 * 모든 AGENT_REPLY의 귀속을 만든다. 이름 해석은 M4 데이터 한계를 따른다: self와
 * 게시글 작성자만 username을 알 수 있고, 그 외 peer는 someoneLabel로 폴백한다
 * (절대 빈 라벨 금지 — ↳@ 라벨이 빈칸으로 렌더되면 안 됨).
 */
export function buildAttribution(
  messages: Message[],
  ctx: AttributionContext
): Map<string, AttributionEntry> {
  const byId = indexById(messages);
  const out = new Map<string, AttributionEntry>();
  for (const m of messages) {
    if (m.type !== 'AGENT_REPLY') continue;
    const human = m.replyToId ? byId[m.replyToId] : undefined;
    const qId = human?.authorId ?? null;
    const isMine = qId != null && qId === ctx.myUserId;
    let name: string;
    if (qId == null) name = ctx.someoneLabel;
    else if (qId === ctx.myUserId) name = ctx.myUserName || ctx.youLabel;
    else if (qId === ctx.postAuthorId) name = ctx.postAuthorName || ctx.someoneLabel;
    else name = ctx.someoneLabel;
    out.set(m.id, { questionerName: name, isMine, anchorHumanId: human?.id ?? null });
  }
  return out;
}

/**
 * 최선노력(best-effort) tool→turn 귀속. TOOL_CALL/TOOL_RESULT는 replyToId가 없으므로
 * seq 순서상 가장 가까운 '직전 AGENT_REPLY'에서 상속한다. 단일 턴에서는 정확(모호성
 * 없음), 동시 모드에서는 근사(문서화된 한계). `attrMap`은 buildAttribution 결과.
 * 소유자를 못 찾으면 null.
 */
export function attributeToolBubble(
  orderedMessages: Message[], // seq-ascending (store.messages는 이미 정렬됨)
  toolMessageId: string,
  attrMap: Map<string, AttributionEntry>
): AttributionEntry | null {
  const idx = orderedMessages.findIndex((m) => m.id === toolMessageId);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (orderedMessages[i].type === 'AGENT_REPLY') {
      return attrMap.get(orderedMessages[i].id) ?? null;
    }
  }
  return null;
}
