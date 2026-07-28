// src/stores/workspaceStore.test.ts
// FE-WORKSPACE — file.changed SSE 이벤트 적용. rev(단조 카운터)가 구독자의 재조회 트리거이므로
// "같은 경로가 다시 바뀌었을 때 rev 가 반드시 올라간다"가 핵심 계약이다.
// (rev 가 안 오르면 FileView 가 갱신되지 않아 라이브 파일트리가 죽은 것처럼 보인다.)

import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from './workspaceStore';

const store = () => useWorkspaceStore.getState();

beforeEach(() => {
  useWorkspaceStore.getState().reset();
});

describe('선택 파일', () => {
  it('선택과 해제가 동작한다', () => {
    store().selectFile('src/a.py');
    expect(store().selectedPath).toBe('src/a.py');
    store().selectFile(null);
    expect(store().selectedPath).toBeNull();
  });
});

describe('file.changed 적용', () => {
  it('경로와 변경 종류를 기록하고 rev 를 올린다', () => {
    store().applyFileChanged('a.py', 'CREATED');
    expect(store().rev).toBe(1);
    expect(store().changed['a.py']).toEqual({ change: 'CREATED', rev: 1 });
  });

  it('같은 경로가 다시 바뀌면 rev 가 증가한다(재조회 트리거 계약)', () => {
    store().applyFileChanged('a.py', 'CREATED');
    const first = store().changed['a.py'].rev;
    store().applyFileChanged('a.py', 'MODIFIED');
    const second = store().changed['a.py'].rev;
    expect(second).toBeGreaterThan(first);
    expect(store().changed['a.py'].change).toBe('MODIFIED');
  });

  it('여러 경로를 독립적으로 추적한다', () => {
    store().applyFileChanged('a.py', 'CREATED');
    store().applyFileChanged('b.py', 'MODIFIED');
    store().applyFileChanged('c.py', 'DELETED');
    expect(Object.keys(store().changed).sort()).toEqual(['a.py', 'b.py', 'c.py']);
    expect(store().rev).toBe(3);
  });

  it('rev 는 전역 단조 증가 — 이벤트마다 반드시 오른다', () => {
    const revs: number[] = [];
    for (let i = 0; i < 10; i++) {
      store().applyFileChanged(`f${i % 3}.py`, 'MODIFIED');
      revs.push(store().rev);
    }
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i]).toBeGreaterThan(revs[i - 1]);
    }
  });

  it('DELETED 도 기록한다(트리에서 제거하려면 알아야 한다)', () => {
    store().applyFileChanged('gone.py', 'DELETED');
    expect(store().changed['gone.py'].change).toBe('DELETED');
  });
});

describe('clearChanged', () => {
  it('소비한 표식만 지운다', () => {
    store().applyFileChanged('a.py', 'CREATED');
    store().applyFileChanged('b.py', 'CREATED');
    store().clearChanged('a.py');
    expect(store().changed['a.py']).toBeUndefined();
    expect(store().changed['b.py']).toBeDefined();
  });

  it('없는 경로를 지워도 no-op(참조 동일 — 불필요한 리렌더 방지)', () => {
    store().applyFileChanged('a.py', 'CREATED');
    const before = store().changed;
    store().clearChanged('없는파일.py');
    expect(store().changed).toBe(before);
  });

  it('clearChanged 는 rev 를 되돌리지 않는다', () => {
    store().applyFileChanged('a.py', 'CREATED');
    const rev = store().rev;
    store().clearChanged('a.py');
    expect(store().rev).toBe(rev);
  });
});

describe('reset', () => {
  it('전체 상태를 초기화한다(게시글 이동 시)', () => {
    store().selectFile('a.py');
    store().applyFileChanged('a.py', 'CREATED');
    store().reset();
    expect(store().selectedPath).toBeNull();
    expect(store().changed).toEqual({});
    expect(store().rev).toBe(0);
  });
});
