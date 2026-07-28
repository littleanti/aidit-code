// src/lib/time.test.ts
// 상대 시간·숫자 로케일 포맷(TRD §14.7). 정확한 문자열은 ICU 버전에 따라 달라질 수 있으므로,
// **로케일이 실제로 전환되는가**와 **깨진 입력에 빈 문자열을 돌려주는가**를 계약으로 본다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { relativeTime, formatCount } from './time';
import { useLangStore } from '../stores/langStore';

const NOW = new Date('2026-07-28T12:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useLangStore.getState().setLang('en');
});

afterEach(() => {
  vi.useRealTimers();
});

/** NOW 기준 delta(ms) 만큼 떨어진 ISO 문자열. */
const at = (deltaMs: number): string => new Date(NOW + deltaMs).toISOString();

describe('relativeTime', () => {
  it('잘못된 날짜 문자열은 빈 문자열', () => {
    expect(relativeTime('not-a-date')).toBe('');
    expect(relativeTime('')).toBe('');
  });

  // 정확한 접미사는 ICU 버전·style:'narrow' 에 따라 달라진다("5h ago"/"5시간 전").
  // 따라서 문구가 아니라 **어떤 단위 버킷이 선택됐는지**를 숫자 크기로 검증한다.
  it('1시간 미만은 분 단위 버킷을 쓴다', () => {
    const out = relativeTime(at(-30 * 60_000));
    expect(out).toBeTruthy();
    expect(out).toContain('30'); // 30분 — 시간으로 뭉개지지 않았다
  });

  it('1시간~1일은 시간 단위 버킷을 쓴다', () => {
    const out = relativeTime(at(-5 * 3_600_000));
    expect(out).toContain('5'); // 5시간
    expect(out).not.toContain('300'); // 분으로 표현되지 않았다
  });

  it('1일 이상은 일 단위 버킷을 쓴다', () => {
    const out = relativeTime(at(-3 * 86_400_000));
    expect(out).toContain('3'); // 3일
    expect(out).not.toContain('72'); // 시간으로 표현되지 않았다
  });

  it('경계값을 처리한다 — numeric:"auto" 는 ±1 을 낱말로 바꾼다', () => {
    // 정확히 1시간 전 → "1h ago"(narrow) 또는 "an hour ago".
    expect(relativeTime(at(-3_600_000))).toBeTruthy();
    // 정확히 1일 전 → numeric:'auto' 때문에 숫자가 아니라 "yesterday"/"어제" 가 나온다.
    // 이는 의도된 설정이므로 낱말 형태를 허용한다.
    expect(relativeTime(at(-86_400_000))).toMatch(/yesterday|어제|1/);
  });

  it('언어 전환이 출력에 반영된다', () => {
    const iso = at(-3 * 86_400_000);
    useLangStore.getState().setLang('en');
    const en = relativeTime(iso);
    useLangStore.getState().setLang('ko');
    const ko = relativeTime(iso);
    expect(en).not.toBe(ko);
  });

  it('미래 시각도 throw 하지 않는다', () => {
    expect(() => relativeTime(at(+2 * 3_600_000))).not.toThrow();
    expect(relativeTime(at(+2 * 3_600_000))).toBeTruthy();
  });
});

describe('formatCount', () => {
  it('천 단위 구분을 넣는다', () => {
    expect(formatCount(1234567)).toMatch(/1[,.  ]?234[,.  ]?567/);
  });

  it('0과 음수도 처리한다', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(-5)).toContain('5');
  });

  it('언어를 바꿔도 throw 하지 않는다', () => {
    for (const lang of ['ko', 'en'] as const) {
      useLangStore.getState().setLang(lang);
      expect(() => formatCount(9876)).not.toThrow();
    }
  });
});

describe('langStore', () => {
  it('setLang 이 document.documentElement.lang 을 동기화한다', () => {
    useLangStore.getState().setLang('ko');
    expect(document.documentElement.lang).toBe('ko');
    useLangStore.getState().setLang('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('toggle 이 ko↔en 을 왕복한다', () => {
    useLangStore.getState().setLang('ko');
    useLangStore.getState().toggle();
    expect(useLangStore.getState().lang).toBe('en');
    useLangStore.getState().toggle();
    expect(useLangStore.getState().lang).toBe('ko');
  });
});
