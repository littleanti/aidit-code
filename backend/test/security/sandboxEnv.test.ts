// backend/test/security/sandboxEnv.test.ts
// XC-ENV (2026-07-28, TRD §8 / CLAUDE.md L1):
//   샌드박스 안에서 **실제로 셸을 돌려** 운영자 LLM 키를 읽을 수 없음을 단언한다.
//
//   기존 redaction.test.ts 와의 차이(왜 이 파일이 따로 필요한가):
//     redaction.test.ts 는 "서버가 밖으로 내보내는 표면"(응답·로그·DB·SSE payload)만 스캔한다.
//     그러나 과거 결함은 그 반대 방향이었다 — 자식 셸이 process.env 를 상속받아 **에이전트가
//     스스로 키를 출력**하고, 그 stdout 이 TOOL_RESULT 버블로 정상 경로를 타고 전원에게 흘렀다.
//     즉 "서버가 흘린" 게 아니라 "샌드박스가 읽어서 뱉은" 것이라 표면 스캔으로는 잡히지 않는다.
//     이 테스트는 executeTool(SHELL) 을 직접 구동해 자식의 ENV 를 덤프시켜 그 경로를 막았음을 증명한다.
//
//   단언:
//     ① SENTINEL 값이 자식 stdout 어디에도 없다(= 키를 읽을 수 없다).
//     ② 비밀 변수 '이름' 자체가 자식 ENV 에 없다(API_KEY/JWT_SECRET/DATABASE_URL/…).
//     ③ SANDBOX_ENV_PASSTHROUGH 로도 비밀 이름은 통과하지 못한다(denylist 우선).
//     ④ PATH 는 살아 있고 일반 명령이 정상 실행된다(= 기존 워크로드 무영향, 과잉 차단 아님).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { executeTool, sandboxChildEnv, killAllToolChildren } from '../../src/agent/toolExec.js';

const SENTINEL = 'sk-SANDBOX-ENV-SENTINEL-0123456789abcdef';

/** 비밀로 취급돼야 하는 변수 이름들(값이 아니라 '이름'의 부재도 확인). */
const SECRET_NAMES = [
  'API_KEY',
  'BASE_URL',
  'JWT_SECRET',
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'PI_API_KEY',
];

let sbx = '';
/** 테스트가 심은 env 를 원복하기 위한 스냅샷. */
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  sbx = await mkdtemp(path.join(tmpdir(), 'xcenv-sbx-'));
  for (const n of [...SECRET_NAMES, 'SANDBOX_ENV_PASSTHROUGH']) saved[n] = process.env[n];
  // 부모 프로세스에는 진짜처럼 비밀들을 심어둔다 — 자식이 못 보는 것이 이 테스트의 논점.
  process.env.API_KEY = SENTINEL;
  process.env.BASE_URL = 'https://models.github.ai/inference';
  process.env.JWT_SECRET = SENTINEL + '-jwt';
  process.env.DATABASE_URL = 'file:./prisma/dev.db';
  process.env.OPENAI_API_KEY = SENTINEL + '-openai';
  process.env.PI_API_KEY = SENTINEL + '-pi';
  delete process.env.SANDBOX_ENV_PASSTHROUGH;
});

afterEach(() => {
  killAllToolChildren();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(sbx, { recursive: true, force: true });
});

/**
 * 샌드박스에서 셸 명령을 돌리고 누적 출력을 돌려준다.
 * (executeTool 의 SHELL 경로 = 에이전트 도구 호출이 실제로 타는 그 경로.)
 */
async function shell(command: string): Promise<{ out: string; exitCode: number | null }> {
  let out = '';
  const res = await executeTool(sbx, { kind: 'SHELL', name: 'bash', command }, (c) => {
    out += c;
  });
  return { out, exitCode: res.exitCode };
}

/**
 * 자식의 ENV 전체를 JSON 으로 덤프한다. 플랫폼 셸 문법 차이를 피하려고 node 로 찍는다
 * (node 는 이 리포의 실행 전제라 항상 존재하며, PATH 가 살아있는지도 겸사 검증된다).
 */
async function dumpChildEnv(): Promise<Record<string, string>> {
  const { out, exitCode } = await shell(
    'node -e "process.stdout.write(JSON.stringify(process.env))"',
  );
  expect(exitCode, `env dump failed — output: ${out}`).toBe(0);
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  expect(start, `no JSON in output: ${out}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(start, end + 1)) as Record<string, string>;
}

describe('XC-ENV: sandbox shell cannot read operator secrets', () => {
  it('sanity — the parent process really holds the SENTINEL (test is meaningful)', () => {
    expect(process.env.API_KEY).toBe(SENTINEL);
  });

  it('child ENV contains neither the SENTINEL value nor any secret variable name', async () => {
    const childEnv = await dumpChildEnv();
    const blob = JSON.stringify(childEnv);

    // ① 값 유출 없음.
    expect(blob, 'SENTINEL leaked into sandbox child ENV').not.toContain(SENTINEL);
    expect(blob).not.toMatch(/sk-[A-Za-z0-9-]{8,}/);

    // ② 이름 자체가 없음.
    for (const name of SECRET_NAMES) {
      expect(Object.keys(childEnv), `secret var ${name} present in child ENV`).not.toContain(name);
    }
  });

  it('`echo $API_KEY` inside the sandbox yields nothing (the original attack path)', async () => {
    // 과거 결함 재현 경로 그대로 — 에이전트가 키를 출력하려 시도.
    const isWin = process.platform === 'win32';
    const { out } = await shell(isWin ? 'echo %API_KEY%' : 'echo "$API_KEY"');
    expect(out).not.toContain(SENTINEL);
    // Windows cmd 는 미정의 변수를 리터럴 '%API_KEY%' 로 출력, POSIX 는 빈 줄 → 둘 다 유출 아님.
    expect(out.trim()).toMatch(/^(%API_KEY%)?$/);
  });

  it('SANDBOX_ENV_PASSTHROUGH cannot smuggle a secret through (denylist wins)', async () => {
    process.env.SANDBOX_ENV_PASSTHROUGH = 'API_KEY,JWT_SECRET,LANG';
    try {
      const env = sandboxChildEnv();
      expect(env.API_KEY).toBeUndefined();
      expect(env.JWT_SECRET).toBeUndefined();
      // 비밀이 아닌 항목은 정상 통과해야 한다(훅 자체는 동작).
      if (process.env.LANG) expect(env.LANG).toBe(process.env.LANG);

      // 실제 자식에서도 동일한지 확인(정적 함수와 런타임 경로의 일치).
      const childEnv = await dumpChildEnv();
      expect(childEnv.API_KEY).toBeUndefined();
      expect(childEnv.JWT_SECRET).toBeUndefined();
    } finally {
      delete process.env.SANDBOX_ENV_PASSTHROUGH;
    }
  });

  it('does not over-restrict — PATH survives and ordinary commands still run', async () => {
    const childEnv = await dumpChildEnv();
    // PATH 부재는 곧 모든 워크로드 붕괴 — 과잉 차단 회귀 감시.
    expect(childEnv.PATH ?? childEnv.Path).toBeTruthy();
    // 명시 주입 항목(상속 아님)도 도착해야 한다.
    expect(childEnv.PYTHONIOENCODING).toBe('utf-8');
    expect(childEnv.AIDIT_SANDBOX).toBe('1');

    // Windows cmd 는 SystemRoot 없이는 대부분의 내장/외부 명령이 깨진다.
    if (process.platform === 'win32') {
      expect(childEnv.SystemRoot ?? childEnv.SYSTEMROOT).toBeTruthy();
      expect(childEnv.COMSPEC ?? childEnv.ComSpec).toBeTruthy();
    }

    // 파일 생성 워크로드가 여전히 도는지(도구 체인 스모크).
    const { exitCode } = await shell('node -e "require(\'fs\').writeFileSync(\'ok.txt\',\'ok\')"');
    expect(exitCode).toBe(0);
    const { out } = await shell('node -e "process.stdout.write(require(\'fs\').readFileSync(\'ok.txt\',\'utf8\'))"');
    expect(out).toContain('ok');
  });
});
