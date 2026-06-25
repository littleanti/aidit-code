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

export interface AppConfig {
  port: number;
  jwtSecret: string;
  jwtExpires: string;
  databaseUrl: string;
  /** 샌드박스 격리 루트(호스트 절대경로). */
  sandboxRoot: string;
  /** LLM 설정 — 읽되 절대 로그/응답/SSE 에 노출 금지. */
  llm: LlmConfig;
}

export const config: AppConfig = {
  port: Number(process.env.PORT) || 3001,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  databaseUrl: process.env.DATABASE_URL || 'file:./prisma/dev.db',
  sandboxRoot: process.env.SANDBOX_ROOT || defaultSandboxRoot,
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
    llm: {
      apiKey: cfg.llm.apiKey ? '[REDACTED]' : '[EMPTY]',
      baseURL: cfg.llm.baseURL,
      model: cfg.llm.model,
    },
  };
}
