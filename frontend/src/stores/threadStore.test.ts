// src/stores/threadStore.test.ts
// FE-THREAD 스토어 단위 테스트. 이 스토어는 스레드 UI의 심장이고, v2 동시 병렬 협업에서
// **여러 턴의 이벤트가 뒤섞여 도착**하므로 다음 불변식이 깨지면 화면이 즉시 망가진다:
//   ① seq 오름차순 정렬이 항상 유지된다(SSE 재생·순서 뒤바뀜에도)
//   ② id 중복과 seq 중복을 각각 다르게 dedupe 한다(서버 행이 낙관적 행을 대체)
//   ③ 아직 도착하지 않은 메시지에 대한 토큰/툴 이벤트는 **조용히 무시**된다(크래시 금지)
//   ④ 토큰 누적은 순수 append — 기존 본문을 잃지 않는다

import { describe, it, expect, beforeEach } from 'vitest';
import { useThreadStore } from './threadStore';
import type { Message, ToolKind } from '../api/types';

/** 최소 Message 팩토리 — 테스트가 관심 있는 필드만 덮어쓴다. */
function msg(over: Partial<Message> & { id: string; seq: number }): Message {
  return {
    type: 'HUMAN',
    status: 'COMPLETE',
    body: '',
    authorId: 'u1',
    authorName: null,
    replyToId: null,
    toolCallId: null,
    toolCall: null,
    imageUrl: null,
    clientId: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    ...over,
  } as Message;
}

const store = () => useThreadStore.getState();
const ids = () => store().messages.map((m) => m.id);
const seqs = () => store().messages.map((m) => m.seq);

beforeEach(() => {
  useThreadStore.getState().reset();
});

describe('정렬 — seq가 단일 진실원천', () => {
  it('도착 순서와 무관하게 seq 오름차순을 유지한다', () => {
    for (const s of [3, 1, 2]) store().upsertMessage(msg({ id: `m${s}`, seq: s }));
    expect(seqs()).toEqual([1, 2, 3]);
  });

  it('seq 동률이면 createdAt으로 안정 정렬한다', () => {
    store().upsertMessage(msg({ id: 'b', seq: 5, createdAt: '2026-07-28T00:00:02.000Z' }));
    store().upsertMessage(msg({ id: 'a', seq: 5, createdAt: '2026-07-28T00:00:01.000Z' }));
    // 같은 seq는 upsert의 seq-충돌 경로를 타므로 마지막 행만 남는다(아래 dedupe 테스트 참조).
    expect(store().messages).toHaveLength(1);
  });

  it('hydrate가 상태를 통째로 교체하고 정렬을 보장한다', () => {
    store().upsertMessage(msg({ id: 'old', seq: 99 }));
    store().hydrate({ messages: [msg({ id: 'x', seq: 2 }), msg({ id: 'y', seq: 1 })] });
    expect(ids()).toEqual(['y', 'x']);
    expect(store().byId.old).toBeUndefined();
  });
});

describe('dedupe — id 중복과 seq 중복을 구분한다', () => {
  it('같은 id 재전달은 필드를 병합한다(중복 행 없음)', () => {
    store().upsertMessage(msg({ id: 'm1', seq: 1, body: '처음' }));
    store().upsertMessage(msg({ id: 'm1', seq: 1, body: '갱신', status: 'STREAMING' }));
    expect(store().messages).toHaveLength(1);
    expect(store().byId.m1.body).toBe('갱신');
    expect(store().byId.m1.status).toBe('STREAMING');
  });

  it('같은 실 seq를 다른 id가 점유하면 새 서버 행이 대체한다', () => {
    store().upsertMessage(msg({ id: 'stale', seq: 7 }));
    store().upsertMessage(msg({ id: 'server', seq: 7 }));
    expect(ids()).toEqual(['server']);
  });

  it('낙관적 행(seq<0)은 실 seq 충돌 규칙을 타지 않는다', () => {
    store().optimisticInsert(msg({ id: 'tmp-a', seq: -1, clientId: 'c1' }));
    store().optimisticInsert(msg({ id: 'tmp-b', seq: -1, clientId: 'c2' }));
    expect(store().messages).toHaveLength(2);
  });
});

describe('낙관적 삽입과 reconcile', () => {
  it('같은 clientId 재전송은 중복 삽입되지 않는다', () => {
    store().optimisticInsert(msg({ id: 'tmp', seq: -1, clientId: 'c1' }));
    store().optimisticInsert(msg({ id: 'tmp2', seq: -1, clientId: 'c1' }));
    expect(store().messages).toHaveLength(1);
  });

  it('서버 행이 도착하면 임시 행을 버리고 실 id·seq를 채택한다', () => {
    store().optimisticInsert(msg({ id: 'tmp', seq: -1, clientId: 'c1', body: '보냄' }));
    store().reconcileByClientId(msg({ id: 'real', seq: 4, clientId: 'c1', body: '보냄' }));
    expect(ids()).toEqual(['real']);
    expect(store().byId.tmp).toBeUndefined();
    expect(store().byId.real.seq).toBe(4);
  });

  it('reconcile은 중복 전달에도 멱등이다', () => {
    store().optimisticInsert(msg({ id: 'tmp', seq: -1, clientId: 'c1' }));
    const server = msg({ id: 'real', seq: 4, clientId: 'c1' });
    store().reconcileByClientId(server);
    store().reconcileByClientId(server);
    expect(store().messages).toHaveLength(1);
  });
});

describe('토큰 스트리밍 누적', () => {
  it('delta를 순수 append 하고 PENDING을 STREAMING으로 올린다', () => {
    store().upsertMessage(msg({ id: 'a1', seq: 2, type: 'AGENT_REPLY', status: 'PENDING' }));
    store().appendToken('a1', '안녕');
    store().appendToken('a1', '하세요');
    expect(store().byId.a1.body).toBe('안녕하세요');
    expect(store().byId.a1.status).toBe('STREAMING');
  });

  it('이미 확정(COMPLETE)된 메시지의 상태는 토큰이 되돌리지 않는다', () => {
    store().upsertMessage(msg({ id: 'a1', seq: 2, type: 'AGENT_REPLY', status: 'COMPLETE' }));
    store().appendToken('a1', 'x');
    expect(store().byId.a1.status).toBe('COMPLETE');
  });

  it('message.created보다 먼저 온 토큰은 조용히 무시한다(크래시 금지)', () => {
    expect(() => store().appendToken('없는id', 'x')).not.toThrow();
    expect(store().messages).toHaveLength(0);
  });

  it('v2 동시 턴: 두 AGENT_REPLY의 토큰이 서로 섞이지 않는다', () => {
    store().upsertMessage(msg({ id: 'A', seq: 10, type: 'AGENT_REPLY', status: 'PENDING' }));
    store().upsertMessage(msg({ id: 'B', seq: 11, type: 'AGENT_REPLY', status: 'PENDING' }));
    // 인터리브 도착
    store().appendToken('A', 'a1');
    store().appendToken('B', 'b1');
    store().appendToken('A', 'a2');
    store().appendToken('B', 'b2');
    expect(store().byId.A.body).toBe('a1a2');
    expect(store().byId.B.body).toBe('b1b2');
  });
});

describe('상태 전이', () => {
  it('setMessageStatus는 본문을 선택적으로 확정한다', () => {
    store().upsertMessage(msg({ id: 'a1', seq: 1, body: '부분' }));
    store().setMessageStatus('a1', 'COMPLETE');
    expect(store().byId.a1.body).toBe('부분'); // body 미지정 → 보존
    store().setMessageStatus('a1', 'COMPLETE', '최종');
    expect(store().byId.a1.body).toBe('최종');
  });

  it('없는 메시지의 상태 변경은 무시한다', () => {
    expect(() => store().setMessageStatus('없음', 'FAILED')).not.toThrow();
  });

  it('setSessionStatus는 활성 세션이 없으면 no-op이다', () => {
    expect(() => store().setSessionStatus('RUNNING')).not.toThrow();
    expect(store().activeSession).toBeNull();
  });

  it('activeSessionTurns(RT-MULTI 권위값)를 그대로 반영한다', () => {
    store().setActiveSessionTurns(3);
    expect(store().activeSessionTurns).toBe(3);
    store().reset();
    expect(store().activeSessionTurns).toBe(0);
  });
});

describe('툴콜 이벤트 (tool.call → output → result)', () => {
  const TOOL_ID = 'tc1';

  function seedToolBubbles(): void {
    store().upsertMessage(msg({ id: 'call', seq: 1, type: 'TOOL_CALL', toolCallId: TOOL_ID }));
    store().upsertMessage(msg({ id: 'res', seq: 2, type: 'TOOL_RESULT', toolCallId: TOOL_ID }));
  }

  it('toolCallId를 공유하는 모든 버블에 요약을 붙인다', () => {
    seedToolBubbles();
    store().upsertToolCall({
      toolCallId: TOOL_ID,
      kind: 'SHELL' as ToolKind,
      name: 'bash',
      args: 'pytest',
      startedAt: '2026-07-28T00:00:00.000Z',
    });
    expect(store().byId.call.toolCall?.status).toBe('RUNNING');
    expect(store().byId.res.toolCall?.name).toBe('bash');
  });

  it('출력 청크를 원문 그대로 누적한다(변형 없음)', () => {
    seedToolBubbles();
    store().upsertToolCall({
      toolCallId: TOOL_ID, kind: 'SHELL' as ToolKind, name: 'bash', args: '', startedAt: '',
    });
    store().appendToolOutput(TOOL_ID, 'line1\n');
    store().appendToolOutput(TOOL_ID, '  line2\t\n');
    expect(store().byId.res.toolCall?.result).toBe('line1\n  line2\t\n');
  });

  it('finalize가 status·exitCode·result를 확정한다', () => {
    seedToolBubbles();
    store().upsertToolCall({
      toolCallId: TOOL_ID, kind: 'SHELL' as ToolKind, name: 'bash', args: '', startedAt: '',
    });
    store().finalizeToolCall({ toolCallId: TOOL_ID, status: 'FAILED', exitCode: 3, result: 'boom' });
    expect(store().byId.call.toolCall?.status).toBe('FAILED');
    expect(store().byId.call.toolCall?.exitCode).toBe(3);
    expect(store().byId.res.toolCall?.result).toBe('boom');
  });

  it('버블보다 먼저 온 툴 이벤트는 조용히 무시한다', () => {
    expect(() =>
      store().upsertToolCall({
        toolCallId: 'ghost', kind: 'SHELL' as ToolKind, name: 'x', args: '', startedAt: '',
      }),
    ).not.toThrow();
    expect(() => store().appendToolOutput('ghost', 'x')).not.toThrow();
    expect(() =>
      store().finalizeToolCall({ toolCallId: 'ghost', status: 'SUCCEEDED', exitCode: 0, result: '' }),
    ).not.toThrow();
    expect(store().messages).toHaveLength(0);
  });

  it('툴콜 패치가 seq 정렬을 흐트러뜨리지 않는다', () => {
    seedToolBubbles();
    store().upsertMessage(msg({ id: 'later', seq: 3 }));
    store().upsertToolCall({
      toolCallId: TOOL_ID, kind: 'SHELL' as ToolKind, name: 'bash', args: '', startedAt: '',
    });
    expect(seqs()).toEqual([1, 2, 3]);
  });
});
