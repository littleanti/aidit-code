// backend/src/agent/config.ts
// AR-CFG — LLM 런타임 설정 단일 출처(에이전트 프로세스 주입 전용).
//
// 보안(CLAUDE.md, TRD §2·§8): apiKey 는 서버 .env → 에이전트 프로세스 ENV 로만 주입한다.
//   - getLlmRuntimeConfig(): { baseURL, model, apiKey } — 내부 주입 전용. 절대 로그/응답/SSE 에 흘리지 않는다.
//   - getPublicRuntimeInfo(): { model, baseURLHost } — 외부 노출 안전. 키 없음, 자격증명 포함 전체 URL 없음.
//
// 기본값: model "openai/gpt-4o-mini", baseURL GitHub Models(https://models.github.ai/inference).
// 실제 값은 src/config.ts 의 config.llm(.env: API_KEY/BASE_URL/MODEL)에서 읽는다.

import { config } from '../config.js';

const DEFAULT_BASE_URL = 'https://models.github.ai/inference';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

/** 절대 http(s) URL 인지 검사. 아니면 기본값으로 폴백한다(환경에 BASE_URL=/ 같은 잡값이 있어도 안전). */
function usableBaseURL(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return raw;
  } catch {
    // fallthrough
  }
  return DEFAULT_BASE_URL;
}

/** 에이전트 프로세스에 주입할 OpenAI-compatible 런타임 설정(내부 전용). apiKey 포함. */
export interface LlmRuntimeConfig {
  baseURL: string;
  model: string;
  /** NEVER log / NEVER return to clients. Injected as ENV into the agent process only. */
  apiKey: string;
}

/** 클라이언트/응답/로그에 노출해도 안전한 런타임 정보. 키·자격증명 없음. */
export interface PublicRuntimeInfo {
  /** 모델명만(공급자 프리픽스 포함). 키 아님. */
  model: string;
  /** BASE_URL 에서 추출한 호스트만(예: "models.github.ai"). 자격증명/경로 없음. */
  baseURLHost: string;
}

/**
 * 에이전트 프로세스 주입용 LLM 설정을 반환한다(INTERNAL ONLY).
 * 반환값에는 apiKey 가 포함되므로 절대 로그/HTTP 응답/SSE payload 에 직접 내보내지 말 것.
 */
export function getLlmRuntimeConfig(): LlmRuntimeConfig {
  return {
    baseURL: usableBaseURL(config.llm.baseURL || DEFAULT_BASE_URL),
    model: config.llm.model || DEFAULT_MODEL,
    apiKey: config.llm.apiKey,
  };
}

/** BASE_URL 에서 호스트만 안전하게 추출. 파싱 실패 시 빈 문자열(키/원본 URL 노출 방지). */
function extractHost(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return '';
  }
}

/**
 * 외부 노출용 런타임 정보를 반환한다: { model, baseURLHost }.
 * apiKey 와 자격증명 포함 전체 URL 은 구조적으로 절대 포함되지 않는다.
 */
export function getPublicRuntimeInfo(): PublicRuntimeInfo {
  const rt = getLlmRuntimeConfig();
  return {
    model: rt.model,
    baseURLHost: extractHost(rt.baseURL),
  };
}
