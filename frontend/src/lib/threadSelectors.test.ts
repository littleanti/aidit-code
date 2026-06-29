// src/lib/threadSelectors.test.ts
// FE-MULTI(M8): 순수 셀렉터 단위 테스트(컴포넌트 렌더 아님, node 환경).
// vitest 전역 미사용 — 명시적 import(빌드 tsconfig 가 globals 타입에 의존 안 함).
import { describe, it, expect } from 'vitest';
import {
  countActiveStreamingTurns,
  resolveActiveTurnsCount,
  hasMyActiveTurn,
  buildAttribution,
  attributeToolBubble,
  type AttributionContext,
} from './threadSelectors';
import type { Message, MessageType, MessageStatus } from '../api/types';

// 테스트용 Message 팩토리(필요 필드만 채우고 나머지는 기본값).
let seqCounter = 0;
function msg(p: {
  id: string;
  type: MessageType;
  status?: MessageStatus;
  authorId?: string | null;
  replyToId?: string | null;
  body?: string;
  seq?: number;
}): Message {
  return {
    id: p.id,
    postId: 'post1',
    sessionId: null,
    authorId: p.authorId ?? null,
    type: p.type,
    status: p.status ?? 'COMPLETE',
    body: p.body ?? '',
    replyToId: p.replyToId ?? null,
    toolCallId: null,
    seq: p.seq ?? seqCounter++,
    clientId: null,
    createdAt: new Date().toISOString(),
  };
}

const baseCtx: AttributionContext = {
  postAuthorId: 'author1',
  postAuthorName: 'Author',
  myUserId: 'me',
  myUserName: 'MyName',
  youLabel: 'you',
  someoneLabel: 'someone',
};

describe('countActiveStreamingTurns', () => {
  it('STREAMING/PENDING AGENT_REPLY 만 카운트하고 나머지는 제외', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', status: 'STREAMING' }), // HUMAN 제외
      msg({ id: 'a1', type: 'AGENT_REPLY', status: 'STREAMING' }),
      msg({ id: 'a2', type: 'AGENT_REPLY', status: 'PENDING' }),
      msg({ id: 'a3', type: 'AGENT_REPLY', status: 'COMPLETE' }), // 완료 제외
      msg({ id: 's1', type: 'SYSTEM', status: 'STREAMING' }), // SYSTEM 제외
    ];
    expect(countActiveStreamingTurns(messages)).toBe(2);
  });

  it('빈 배열 → 0', () => {
    expect(countActiveStreamingTurns([])).toBe(0);
  });
});

describe('resolveActiveTurnsCount', () => {
  const oneActive = [msg({ id: 'a1', type: 'AGENT_REPLY', status: 'STREAMING' })];

  it('서버값 > 0 → 서버값 우선', () => {
    expect(resolveActiveTurnsCount(3, oneActive)).toBe(3);
  });

  it('서버값 0/null/undefined → 메시지 파생 폴백', () => {
    expect(resolveActiveTurnsCount(0, oneActive)).toBe(1);
    expect(resolveActiveTurnsCount(null, oneActive)).toBe(1);
    expect(resolveActiveTurnsCount(undefined, oneActive)).toBe(1);
  });
});

describe('hasMyActiveTurn', () => {
  it('내 질문의 활성 답 → true', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'me' }),
      msg({ id: 'a1', type: 'AGENT_REPLY', status: 'STREAMING', replyToId: 'h1' }),
    ];
    expect(hasMyActiveTurn(messages, 'me')).toBe(true);
  });

  it('남의 질문의 활성 답 → false(남의 턴은 비차단)', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'peer' }),
      msg({ id: 'a1', type: 'AGENT_REPLY', status: 'STREAMING', replyToId: 'h1' }),
    ];
    expect(hasMyActiveTurn(messages, 'me')).toBe(false);
  });

  it('replyToId 대상 HUMAN 미수신 → false(과소잠금)', () => {
    const messages = [
      msg({ id: 'a1', type: 'AGENT_REPLY', status: 'STREAMING', replyToId: 'missing' }),
    ];
    expect(hasMyActiveTurn(messages, 'me')).toBe(false);
  });

  it('myUserId null → false', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'me' }),
      msg({ id: 'a1', type: 'AGENT_REPLY', status: 'STREAMING', replyToId: 'h1' }),
    ];
    expect(hasMyActiveTurn(messages, null)).toBe(false);
  });

  it('내 질문의 답이 COMPLETE 면(비활성) → false', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'me' }),
      msg({ id: 'a1', type: 'AGENT_REPLY', status: 'COMPLETE', replyToId: 'h1' }),
    ];
    expect(hasMyActiveTurn(messages, 'me')).toBe(false);
  });
});

describe('buildAttribution', () => {
  it('내 질문 → isMine true, name = myUserName', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'me' }),
      msg({ id: 'a1', type: 'AGENT_REPLY', replyToId: 'h1' }),
    ];
    const out = buildAttribution(messages, baseCtx);
    expect(out.get('a1')).toEqual({
      questionerName: 'MyName',
      isMine: true,
      anchorHumanId: 'h1',
    });
  });

  it('내 질문 + myUserName 빈값 → youLabel 폴백', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'me' }),
      msg({ id: 'a1', type: 'AGENT_REPLY', replyToId: 'h1' }),
    ];
    const out = buildAttribution(messages, { ...baseCtx, myUserName: null });
    expect(out.get('a1')?.questionerName).toBe('you');
    expect(out.get('a1')?.isMine).toBe(true);
  });

  it('게시글 작성자 질문 → name = postAuthorName, isMine false', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'author1' }),
      msg({ id: 'a1', type: 'AGENT_REPLY', replyToId: 'h1' }),
    ];
    const out = buildAttribution(messages, baseCtx);
    expect(out.get('a1')).toEqual({
      questionerName: 'Author',
      isMine: false,
      anchorHumanId: 'h1',
    });
  });

  it('알 수 없는 peer → someoneElse 폴백(빈 라벨 금지)', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'peerX' }),
      msg({ id: 'a1', type: 'AGENT_REPLY', replyToId: 'h1' }),
    ];
    const out = buildAttribution(messages, baseCtx);
    expect(out.get('a1')?.questionerName).toBe('someone');
    expect(out.get('a1')?.isMine).toBe(false);
  });

  it('replyToId null → someoneElse, anchorHumanId null', () => {
    const messages = [msg({ id: 'a1', type: 'AGENT_REPLY', replyToId: null })];
    const out = buildAttribution(messages, baseCtx);
    expect(out.get('a1')).toEqual({
      questionerName: 'someone',
      isMine: false,
      anchorHumanId: null,
    });
  });

  it('non-AGENT_REPLY 는 맵에 미포함', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'me' }),
      msg({ id: 's1', type: 'SYSTEM' }),
      msg({ id: 't1', type: 'TOOL_CALL' }),
    ];
    const out = buildAttribution(messages, baseCtx);
    expect(out.has('h1')).toBe(false);
    expect(out.has('s1')).toBe(false);
    expect(out.has('t1')).toBe(false);
    expect(out.size).toBe(0);
  });
});

describe('attributeToolBubble', () => {
  it('단일 AGENT_REPLY 선행 → 상속', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'me', seq: 0 }),
      msg({ id: 'a1', type: 'AGENT_REPLY', replyToId: 'h1', seq: 1 }),
      msg({ id: 't1', type: 'TOOL_CALL', seq: 2 }),
    ];
    const attrMap = buildAttribution(messages, baseCtx);
    const got = attributeToolBubble(messages, 't1', attrMap);
    expect(got?.questionerName).toBe('MyName');
    expect(got?.isMine).toBe(true);
  });

  it('선행 AGENT_REPLY 없음 → null', () => {
    const messages = [
      msg({ id: 'h1', type: 'HUMAN', authorId: 'me', seq: 0 }),
      msg({ id: 't1', type: 'TOOL_CALL', seq: 1 }),
    ];
    const attrMap = buildAttribution(messages, baseCtx);
    expect(attributeToolBubble(messages, 't1', attrMap)).toBeNull();
  });

  it('찾을 수 없는 toolMessageId → null', () => {
    const messages = [msg({ id: 'a1', type: 'AGENT_REPLY', replyToId: null, seq: 0 })];
    const attrMap = buildAttribution(messages, baseCtx);
    expect(attributeToolBubble(messages, 'nope', attrMap)).toBeNull();
  });

  it('동시 2턴 seq-인접 → 가장 가까운 직전 AGENT_REPLY 상속(best-effort)', () => {
    const messages = [
      msg({ id: 'hMe', type: 'HUMAN', authorId: 'me', seq: 0 }),
      msg({ id: 'aMe', type: 'AGENT_REPLY', status: 'STREAMING', replyToId: 'hMe', seq: 1 }),
      msg({ id: 'hAuthor', type: 'HUMAN', authorId: 'author1', seq: 2 }),
      msg({
        id: 'aAuthor',
        type: 'AGENT_REPLY',
        status: 'STREAMING',
        replyToId: 'hAuthor',
        seq: 3,
      }),
      msg({ id: 'tool', type: 'TOOL_CALL', seq: 4 }), // 직전 = aAuthor
    ];
    const attrMap = buildAttribution(messages, baseCtx);
    const got = attributeToolBubble(messages, 'tool', attrMap);
    expect(got?.questionerName).toBe('Author');
    expect(got?.isMine).toBe(false);
  });
});
