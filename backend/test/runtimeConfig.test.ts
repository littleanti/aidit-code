// backend/test/runtimeConfig.test.ts
// AR-CFG 검증: getPublicRuntimeInfo() 는 { model, baseURLHost } 만 반환하고
// apiKey 문자열을 절대 포함하지 않는다.

import { describe, it, expect } from 'vitest';
import { config } from '../src/config.js';
import { getPublicRuntimeInfo, getLlmRuntimeConfig } from '../src/agent/config.js';

describe('getPublicRuntimeInfo', () => {
  it('returns model + baseURLHost and never the apiKey', () => {
    const info = getPublicRuntimeInfo();

    expect(info).toHaveProperty('model');
    expect(info).toHaveProperty('baseURLHost');
    expect(typeof info.model).toBe('string');
    expect(typeof info.baseURLHost).toBe('string');

    // host 만(자격증명/경로/프로토콜 없음).
    expect(info.baseURLHost).not.toMatch(/^https?:\/\//);
    expect(info.baseURLHost).not.toContain('/');

    // 키 누출 없음(구조적 + 평문 검증).
    const serialized = JSON.stringify(info);
    expect(serialized).not.toMatch(/apiKey|API_KEY/);
    const realKey = config.llm.apiKey;
    if (realKey) {
      expect(serialized).not.toContain(realKey);
    }
    // 객체에 어떤 키 필드도 없음.
    expect(Object.keys(info).sort()).toEqual(['baseURLHost', 'model']);
  });

  it('internal getLlmRuntimeConfig carries the apiKey (injection-only)', () => {
    const rt = getLlmRuntimeConfig();
    expect(rt).toHaveProperty('apiKey');
    expect(rt).toHaveProperty('baseURL');
    expect(rt).toHaveProperty('model');
    // baseURLHost 는 baseURL 의 host 와 일치해야 한다.
    const host = new URL(rt.baseURL).host;
    expect(getPublicRuntimeInfo().baseURLHost).toBe(host);
  });
});
