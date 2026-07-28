// src/lib/shellArg.test.ts
// ShellPrompt 장식 줄의 인자 포매터. 실행되지 않는 표시용이지만, 레이아웃이 깨지지 않는 것이
// 계약이다 — 개행/탭이 남으면 고정폭 한 줄 터미널 에코가 무너지고 가로 스크롤이 생긴다.

import { describe, it, expect } from 'vitest';
import { formatPromptArg } from './shellArg';

describe('formatPromptArg', () => {
  it('공백 런(개행·탭 포함)을 한 칸으로 collapse 한다', () => {
    expect(formatPromptArg('a   b')).toBe('a b');
    expect(formatPromptArg('a\nb')).toBe('a b');
    expect(formatPromptArg('a\t\tb')).toBe('a b');
    expect(formatPromptArg('a\r\n\tb')).toBe('a b');
  });

  it('앞뒤 공백을 trim 한다', () => {
    expect(formatPromptArg('  가운데  ')).toBe('가운데');
    expect(formatPromptArg('\n\t x \t\n')).toBe('x');
  });

  it('collapse 결과에 개행·탭이 절대 남지 않는다(레이아웃 계약)', () => {
    const messy = 'first\nsecond\tthird\r\nfourth';
    const out = formatPromptArg(messy, { max: 200 });
    expect(out).not.toMatch(/[\n\r\t]/);
  });

  it('max 초과 시 max-1자 + 생략 문자로 트렁케이트한다', () => {
    const out = formatPromptArg('가'.repeat(50));
    expect(out).toHaveLength(32); // 31자 + '…'
    expect(out.endsWith('…')).toBe(true);
  });

  it('max 이하면 그대로 둔다(경계 포함)', () => {
    const exact = 'a'.repeat(32);
    expect(formatPromptArg(exact)).toBe(exact);
    expect(formatPromptArg(exact)).toHaveLength(32);
  });

  it('max 옵션을 존중한다', () => {
    expect(formatPromptArg('abcdefghij', { max: 5 })).toBe('abcd…');
  });

  it('큰따옴표를 표시용으로 이스케이프한다', () => {
    expect(formatPromptArg('say "hi"')).toBe('say \\"hi\\"');
  });

  it('트렁케이트 후에 이스케이프한다 — 순서 계약', () => {
    // 이스케이프가 먼저면 백슬래시가 길이에 포함돼 트렁케이트 위치가 달라진다.
    const out = formatPromptArg('"'.repeat(10), { max: 5 });
    // 4개의 " 가 남고 각각 \" 로 확장 → 8자 + '…'
    expect(out).toBe('\\"\\"\\"\\"…');
  });

  it('빈 문자열·공백만 입력은 빈 문자열', () => {
    expect(formatPromptArg('')).toBe('');
    expect(formatPromptArg('   \n\t ')).toBe('');
  });

  it('이모지·한글이 섞여도 throw 하지 않는다', () => {
    expect(() => formatPromptArg('🚀 한글 mixed 🎉'.repeat(10))).not.toThrow();
  });
});
