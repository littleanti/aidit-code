// src/i18n/resolve.test.ts
// 키 해석 폴백 순서(TRD §14.3)와 서버 오류 → 큐레이트된 키 매핑(TRD §11·§14.6).
//
// serverError 를 함께 검증하는 이유: HARD RULE 이 "서버 원문 메시지를 절대 그대로 노출하지 말고
// 항상 큐레이트된 키로 환원한다"이므로, 매핑이 어긋나면 내부 구현이 사용자에게 새어 나간다.

import { describe, it, expect } from 'vitest';
import { resolveKey } from './resolve';
import { DICTS } from './index';
import { errorKeyForApi, errorKeyForSession, errorKeyForSandbox } from './serverError';
import { ApiError } from '../api/rest';

describe('resolveKey — 폴백 순서 lang → ko → raw key', () => {
  it('요청 언어의 값을 우선한다', () => {
    // 사전에 실제로 존재하는 키를 골라 언어별 값이 다름을 확인한다.
    const ko = resolveKey('ko', 'common.cancel');
    const en = resolveKey('en', 'common.cancel');
    expect(ko).toBeTruthy();
    expect(en).toBeTruthy();
    expect(ko).not.toBe('common.cancel'); // raw 폴백이 아님
    expect(en).not.toBe('common.cancel');
  });

  it('없는 키는 키 문자열 자체를 돌려준다(빈 화면 방지)', () => {
    expect(resolveKey('en', 'common.definitelyMissingKey')).toBe('common.definitelyMissingKey');
    expect(resolveKey('en', 'noSuchNamespace.x')).toBe('noSuchNamespace.x');
  });

  it('점이 여러 개면 첫 점만 네임스페이스 구분자로 쓴다', () => {
    // 'a.b.c' → ns='a', sub='b.c'. 없는 키라도 raw 를 돌려주며 throw 하지 않는다.
    expect(() => resolveKey('ko', 'errors.a.b.c')).not.toThrow();
    expect(resolveKey('ko', 'errors.a.b.c')).toBe('errors.a.b.c');
  });

  it('점이 없는 키도 throw 하지 않는다', () => {
    expect(() => resolveKey('ko', 'nodot')).not.toThrow();
    expect(resolveKey('ko', 'nodot')).toBe('nodot');
  });

  it('{var} 치환을 수행한다', () => {
    // 치환은 값 문자열에 대해 동작하므로, 존재하지 않는 키(=raw 반환)로도 계약을 확인한다.
    const withVar = resolveKey('ko', 'errors.missing{name}', { name: '철수' });
    // raw 폴백 경로에서도 치환이 적용된다(값 == 키 문자열).
    expect(withVar).toContain('철수');
  });

  it('vars 에 없는 플레이스홀더는 그대로 남긴다(런타임 크래시 대신 가시적 흔적)', () => {
    const out = resolveKey('ko', 'errors.x{unknown}', {});
    expect(out).toContain('{unknown}');
  });
});

describe('DICTS 구조 정합', () => {
  it('모든 네임스페이스가 ko·en 을 갖는다', () => {
    for (const [ns, dict] of Object.entries(DICTS)) {
      expect(Object.keys(dict), `${ns} missing lang`).toEqual(
        expect.arrayContaining(['ko', 'en']),
      );
    }
  });

  it('ko 와 en 의 키 집합이 일치한다(번역 누락 감시)', () => {
    for (const [ns, dict] of Object.entries(DICTS)) {
      const d = dict as unknown as Record<'ko' | 'en', Record<string, string>>;
      const koKeys = Object.keys(d.ko).sort();
      const enKeys = Object.keys(d.en).sort();
      expect(enKeys, `${ns}: en/ko 키 불일치`).toEqual(koKeys);
    }
  });

  it('빈 문자열 값이 없다', () => {
    for (const [ns, dict] of Object.entries(DICTS)) {
      const d = dict as unknown as Record<'ko' | 'en', Record<string, string>>;
      for (const lang of ['ko', 'en'] as const) {
        for (const [k, v] of Object.entries(d[lang])) {
          expect(v, `${ns}.${lang}.${k} 가 빈 값`).not.toBe('');
        }
      }
    }
  });
});

describe('serverError — 서버 신호를 큐레이트된 키로 환원', () => {
  it('status 0(네트워크) → networkError', () => {
    expect(errorKeyForApi(new ApiError(0, 'Failed to fetch'))).toBe('networkError');
  });

  it('401 → unauthorized', () => {
    expect(errorKeyForApi(new ApiError(401, 'nope'))).toBe('unauthorized');
  });

  it('403 + path 문구 → pathDenied, 그 외 403 → unauthorized', () => {
    expect(errorKeyForApi(new ApiError(403, 'path violation'))).toBe('pathDenied');
    expect(errorKeyForApi(new ApiError(403, 'forbidden'))).toBe('unauthorized');
  });

  it('429 → rateLimited', () => {
    expect(errorKeyForApi(new ApiError(429, 'slow down'))).toBe('rateLimited');
  });

  it('그 외는 generic 으로 환원한다(원문 노출 금지)', () => {
    for (const s of [400, 404, 500, 502, 503]) {
      expect(errorKeyForApi(new ApiError(s, 'internal detail leak'))).toBe('generic');
    }
  });

  it('반환된 모든 키가 errors 사전에 실제로 존재한다', () => {
    const keys = [
      errorKeyForApi(new ApiError(0, '')),
      errorKeyForApi(new ApiError(401, '')),
      errorKeyForApi(new ApiError(403, 'path')),
      errorKeyForApi(new ApiError(429, '')),
      errorKeyForApi(new ApiError(500, '')),
      errorKeyForSession('ERROR'),
      errorKeyForSandbox('ERROR'),
    ].filter((k): k is string => k !== null);
    for (const k of keys) {
      expect(resolveKey('ko', `errors.${k}`), `errors.${k} 미정의`).not.toBe(`errors.${k}`);
      expect(resolveKey('en', `errors.${k}`), `errors.${k}(en) 미정의`).not.toBe(`errors.${k}`);
    }
  });

  it('세션/샌드박스 상태는 ERROR 만 알림을 만든다', () => {
    expect(errorKeyForSession('ERROR')).toBe('sessionFailed');
    for (const s of ['IDLE', 'RUNNING', 'STARTING', 'STOPPED', 'INTERRUPTED'] as const) {
      expect(errorKeyForSession(s)).toBeNull();
    }
    expect(errorKeyForSandbox('ERROR')).toBe('sandboxError');
    for (const s of ['CREATING', 'READY', 'SUSPENDED'] as const) {
      expect(errorKeyForSandbox(s)).toBeNull();
    }
  });
});
