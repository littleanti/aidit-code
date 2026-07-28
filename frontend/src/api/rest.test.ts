// src/api/rest.test.ts
// REST 클라이언트의 계약 — Bearer 인터셉터·ApiError 상태 매핑·본문 파싱 관용성.
//
// 왜 중요한가: 이 모듈은 모든 화면의 유일한 서버 접점이다. Authorization 헤더가 빠지면
// 전 기능이 401 이 되고, 오류 매핑이 어긋나면 i18n 오류 사전(serverError.ts)이 오작동한다.
// HARD RULE 회귀 감시도 겸한다 — 요청 어디에도 LLM 키 형태 필드가 실리면 안 된다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError, assetUrl } from './rest';
import * as rest from './rest';
import { useAuthStore } from '../stores/authStore';

/** fetch 호출을 가로채 마지막 인자를 기록하는 스파이. */
interface Captured {
  url: string;
  init: RequestInit;
}
let captured: Captured[] = [];

function mockFetch(status: number, body: string, opts: { throwNetwork?: boolean } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      if (opts.throwNetwork) throw new TypeError('Failed to fetch');
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      } as unknown as Response;
    }),
  );
}

const lastInit = (): RequestInit => captured[captured.length - 1].init;
const headers = (): Record<string, string> =>
  (lastInit().headers ?? {}) as Record<string, string>;

beforeEach(() => {
  captured = [];
  useAuthStore.getState().logout();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Bearer 인터셉터', () => {
  it('토큰이 있으면 Authorization 헤더를 붙인다', async () => {
    useAuthStore.getState().setAuth({ userId: 'u1', username: 'kim', token: 'tok123' });
    mockFetch(200, '{"items":[],"nextCursor":null}');
    await rest.getPosts('hot');
    expect(headers()['Authorization']).toBe('Bearer tok123');
  });

  it('토큰이 없으면 Authorization 헤더를 붙이지 않는다', async () => {
    mockFetch(200, '{"items":[],"nextCursor":null}');
    await rest.getPosts('hot');
    expect(headers()['Authorization']).toBeUndefined();
  });

  it('auth:false 경로(회원가입)는 토큰이 있어도 헤더를 붙이지 않는다', async () => {
    useAuthStore.getState().setAuth({ userId: 'u1', username: 'kim', token: 'tok123' });
    mockFetch(201, '{"id":"u2","username":"new","token":"t"}');
    await rest.register('new', 'pw');
    expect(headers()['Authorization']).toBeUndefined();
  });

  it('본문이 있으면 Content-Type: application/json 을 붙인다', async () => {
    mockFetch(201, '{"id":"u2","username":"new","token":"t"}');
    await rest.register('new', 'pw');
    expect(headers()['Content-Type']).toBe('application/json');
    expect(String(lastInit().body)).toContain('"username":"new"');
  });

  it('요청 어디에도 LLM 키 형태 필드가 실리지 않는다 (HARD RULE)', async () => {
    useAuthStore.getState().setAuth({ userId: 'u1', username: 'kim', token: 'tok123' });
    mockFetch(201, '{}');
    await rest.register('new', 'pw');
    const blob = JSON.stringify(captured);
    expect(blob).not.toMatch(/apiKey|API_KEY|baseURL|BASE_URL|OPENAI/i);
  });
});

describe('ApiError 매핑', () => {
  it('네트워크 실패는 status 0 이다', async () => {
    mockFetch(0, '', { throwNetwork: true });
    await expect(rest.getPosts('hot')).rejects.toBeInstanceOf(ApiError);
    await expect(rest.getPosts('hot')).rejects.toMatchObject({ status: 0 });
  });

  it('서버가 message 를 주면 그 문구를 쓴다', async () => {
    mockFetch(429, '{"message":"too many"}');
    await expect(rest.getPosts('hot')).rejects.toMatchObject({
      status: 429,
      message: 'too many',
    });
  });

  it('message 가 없으면 일반 문구로 폴백한다', async () => {
    mockFetch(500, '{"error":"boom"}');
    await expect(rest.getPosts('hot')).rejects.toMatchObject({
      status: 500,
      message: 'request failed (500)',
    });
  });

  it('JSON 이 아닌 본문도 삼키지 않고 그대로 담는다', async () => {
    mockFetch(502, '<html>bad gateway</html>');
    await expect(rest.getPosts('hot')).rejects.toMatchObject({ status: 502 });
  });

  it('빈 본문(204 등)에도 throw 하지 않는다', async () => {
    mockFetch(204, '');
    await expect(rest.deletePost('p1')).resolves.toBeUndefined();
  });
});

describe('assetUrl', () => {
  it('빈 값은 빈 문자열', () => {
    expect(assetUrl(null)).toBe('');
    expect(assetUrl(undefined)).toBe('');
    expect(assetUrl('')).toBe('');
  });

  it('절대 URL·data:·blob: 은 그대로 통과시킨다', () => {
    for (const u of [
      'https://cdn.example/a.png',
      'http://x/a.png',
      '//cdn.example/a.png',
      'data:image/png;base64,AAA',
      'blob:http://localhost/abc',
    ]) {
      expect(assetUrl(u)).toBe(u);
    }
  });

  it('VITE_API_ORIGIN 미설정 시 상대경로를 유지한다(동일 origin 배포)', () => {
    expect(assetUrl('/uploads/a.png')).toBe('/uploads/a.png');
  });
});
