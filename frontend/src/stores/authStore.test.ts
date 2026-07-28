// src/stores/authStore.test.ts
// 인증 스토어 — 신원 필드만 저장한다는 HARD RULE 의 회귀 감시가 주 목적이다.
// TRD §2·§8: 클라이언트에는 LLM 키가 존재하지 않는다(BYOK 전면 폐기). 이 스토어가
// localStorage 에 persist 되므로, 여기에 키 형태 필드가 들어가면 곧 디스크 유출이다.

import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore, getAuthToken } from './authStore';

const store = () => useAuthStore.getState();

beforeEach(() => {
  useAuthStore.getState().logout();
  localStorage.clear();
});

describe('인증 상태', () => {
  it('초기값은 전부 null', () => {
    expect(store().userId).toBeNull();
    expect(store().username).toBeNull();
    expect(store().token).toBeNull();
  });

  it('setAuth 가 신원을 저장한다', () => {
    store().setAuth({ userId: 'u1', username: '철수#a3f9', token: 'tok' });
    expect(store().userId).toBe('u1');
    expect(store().username).toBe('철수#a3f9');
    expect(store().token).toBe('tok');
  });

  it('logout 이 전부 비운다', () => {
    store().setAuth({ userId: 'u1', username: 'kim', token: 'tok' });
    store().logout();
    expect(store().userId).toBeNull();
    expect(store().token).toBeNull();
  });

  it('getAuthToken 이 비-React 경로에서 현재 토큰을 읽는다', () => {
    expect(getAuthToken()).toBeNull();
    store().setAuth({ userId: 'u1', username: 'kim', token: 'tok' });
    expect(getAuthToken()).toBe('tok');
  });
});

describe('HARD RULE — 키 형태 필드가 존재하지 않는다', () => {
  it('상태 객체에 키 관련 필드가 없다', () => {
    store().setAuth({ userId: 'u1', username: 'kim', token: 'tok' });
    const keys = Object.keys(store());
    for (const forbidden of ['apiKey', 'baseURL', 'model', 'API_KEY', 'BASE_URL']) {
      expect(keys, `${forbidden} 가 스토어에 존재`).not.toContain(forbidden);
    }
  });

  it('persist 된 localStorage 페이로드가 신원 3필드만 담는다', () => {
    store().setAuth({ userId: 'u1', username: 'kim', token: 'tok' });
    const raw = localStorage.getItem('aidit-auth');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(Object.keys(parsed.state).sort()).toEqual(['token', 'userId', 'username']);
  });

  it('persist 된 페이로드에 키 형태 문자열이 없다', () => {
    store().setAuth({ userId: 'u1', username: 'kim', token: 'tok' });
    const raw = localStorage.getItem('aidit-auth') ?? '';
    expect(raw).not.toMatch(/apiKey|API_KEY|baseURL|BASE_URL|sk-[A-Za-z0-9]{8,}/i);
  });

  it('함수(setAuth/logout)는 persist 되지 않는다', () => {
    store().setAuth({ userId: 'u1', username: 'kim', token: 'tok' });
    const raw = localStorage.getItem('aidit-auth') ?? '';
    expect(raw).not.toContain('setAuth');
    expect(raw).not.toContain('logout');
  });
});
