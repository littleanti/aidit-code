// backend/src/config.ts
// 환경설정 단일 출처. dotenv로 .env 로드 후 타입드 config 객체를 export.
// 보안(TRD §2·§8): LLM 키(API_KEY/BASE_URL/MODEL)는 서버 .env 에만 존재한다.
//   - config.llm 으로 읽되, 로그/응답/SSE 어디에도 키를 노출하지 않는다.
//   - redactConfig() 헬퍼로 apiKey 를 항상 마스킹한 안전 객체만 로깅한다.

import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadDotenv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// backend/src/ → backend/ → Audit-Code/  (repo 루트)
const repoRoot = path.resolve(__dirname, '..', '..');
const defaultSandboxRoot = path.join(repoRoot, '.sandboxes');

export interface LlmConfig {
  /** 운영자 LLM 키. NEVER log/expose. */
  apiKey: string;
  /** OpenAI-compatible 엔드포인트. */
  baseURL: string;
  /** 활성 모델명(공급자 프리픽스 포함). */
  model: string;
}

/** 쓰기 라우트용 인메모리 레이트리밋 설정(TRD §8 남용 방지, M7 XC-RATE). */
export interface RateLimitConfig {
  /** 1 이면 레이트리밋 미적용(테스트/스모크에서 기존 스위트 영향 차단). */
  disabled: boolean;
  /** 고정 윈도우 길이(ms). */
  windowMs: number;
  /** 윈도우당 POST /posts 허용 횟수(userId+ip). 초과 시 429. */
  postsPerWindow: number;
  /** 윈도우당 POST /posts/:id/messages 허용 횟수(userId+ip). 초과 시 429. */
  messagesPerWindow: number;
}

/** 샌드박스 격리 하드닝 설정(TRD §8, M7 XC-ISO). best-effort PoC. */
export interface IsolationConfig {
  /** SHELL/PACKAGE 자식 도구의 벽시계 타임아웃(ms). 초과 시 kill → ToolCall FAILED 'timeout'. */
  toolTimeoutMs: number;
  /** 샌드박스당 동시 실행 자식 프로세스 상한(best-effort). 초과 시 도구 실행 거부. */
  maxProcsPerSandbox: number;
  /** 네트워크 정책 플래그. 'restricted' | 'open'. 메타에 기록(실제 강제는 범위 외 — 정직히 문서화). */
  networkPolicy: 'restricted' | 'open';
}

export interface AppConfig {
  port: number;
  /** 바인드 호스트. 기본 `0.0.0.0`(모든 인터페이스). 내부 전용 실행 시 `127.0.0.1`. */
  host: string;
  jwtSecret: string;
  jwtExpires: string;
  databaseUrl: string;
  /** 샌드박스 격리 루트(호스트 절대경로). */
  sandboxRoot: string;
  /** 동시 샌드박스 프로비저닝/활성 실행 상한(TRD §8 남용 방지). 초과 시 429. */
  sandboxMaxConcurrent: number;
  /** 쓰기 라우트 레이트리밋(M7 XC-RATE). */
  rateLimit: RateLimitConfig;
  /** 샌드박스 격리 하드닝(M7 XC-ISO). */
  isolation: IsolationConfig;
  /** LLM 설정 — 읽되 절대 로그/응답/SSE 에 노출 금지. */
  llm: LlmConfig;
}

export const config: AppConfig = {
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  databaseUrl: process.env.DATABASE_URL || 'file:./prisma/dev.db',
  sandboxRoot: process.env.SANDBOX_ROOT || defaultSandboxRoot,
  sandboxMaxConcurrent: Number(process.env.SANDBOX_MAX_CONCURRENT) || 4,
  rateLimit: {
    // 테스트/스모크는 RATE_LIMIT_DISABLED=1 로 끈다(M1-M6 스위트 무영향). 기본 활성.
    disabled: process.env.RATE_LIMIT_DISABLED === '1',
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
    // GENEROUS — 정상 흐름/기존 테스트를 절대 막지 않는 넉넉한 한도.
    postsPerWindow: Number(process.env.RATE_LIMIT_POSTS_PER_WINDOW) || 30,
    messagesPerWindow: Number(process.env.RATE_LIMIT_MESSAGES_PER_WINDOW) || 120,
  },
  isolation: {
    toolTimeoutMs: Number(process.env.TOOL_TIMEOUT_MS) || 30_000,
    maxProcsPerSandbox: Number(process.env.SANDBOX_MAX_PROCS) || 16,
    networkPolicy: process.env.NETWORK_POLICY === 'open' ? 'open' : 'restricted',
  },
  llm: {
    apiKey: process.env.API_KEY || '',
    baseURL: process.env.BASE_URL || 'https://models.github.ai/inference',
    model: process.env.MODEL || 'openai/gpt-4o-mini',
  },
};

/**
 * 로깅/직렬화 안전용 redactor. apiKey 와 jwtSecret 은 절대 평문으로 노출하지 않는다.
 * 로그·디버그·헬스 출력 등 config 를 외부로 내보내야 할 때 반드시 이 함수를 사용한다.
 */
export function redactConfig(cfg: AppConfig = config): Record<string, unknown> {
  return {
    port: cfg.port,
    jwtSecret: '[REDACTED]',
    jwtExpires: cfg.jwtExpires,
    databaseUrl: cfg.databaseUrl,
    sandboxRoot: cfg.sandboxRoot,
    sandboxMaxConcurrent: cfg.sandboxMaxConcurrent,
    rateLimit: cfg.rateLimit,
    isolation: cfg.isolation,
    llm: {
      apiKey: cfg.llm.apiKey ? '[REDACTED]' : '[EMPTY]',
      baseURL: cfg.llm.baseURL,
      model: cfg.llm.model,
    },
  };
}
