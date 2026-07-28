// backend/test/sandboxPythonWorkload.test.ts
// 2026-07-28 회귀 방어: ENV 화이트리스트(XC-ENV) 아래에서 **실제 데모 워크로드가 돈다**.
//
// 왜 필요한가:
//   sandboxEnv.test.ts 는 "키가 안 새는가"(차단 방향)를 본다. 그런데 화이트리스트는 반대 방향으로도
//   틀릴 수 있다 — 필요한 변수를 빠뜨려 **정상 워크로드를 죽이는** 것. 그건 보안이 아니라 고장이다.
//   데모 시나리오(docs/DEMO_SCENARIO.md)는 python + pytest 를 돌리는데, 화이트리스트 검증은
//   `node` 로만 했다. python 은 `APPDATA`(pip/유저 site) · `TEMP` · `SystemRoot`(Windows) 중
//   하나만 없어도 깨질 수 있어, 그 조합이 실제로 살아있는지 확인해야 한다.
//
// 이 테스트는 executeTool(SHELL) — 에이전트 도구 호출이 실제로 타는 경로 — 로만 구동한다.
// python 이 없는 환경에서는 **명확히 skip** 한다(없는 걸 통과로 위장하지 않는다).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { executeTool, killAllToolChildren } from '../src/agent/toolExec.js';

/** python 실행 파일 후보를 순서대로 시도해 사용 가능한 것을 고른다. */
function detectPython(): string | null {
  for (const cmd of ['python', 'python3', 'py']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: true });
    if (r.status === 0) return cmd;
  }
  return null;
}

const PYTHON = detectPython();
/** pytest 가 있는지(없으면 pytest 케이스만 skip 하고 순수 python 케이스는 돈다). */
const HAS_PYTEST =
  PYTHON !== null &&
  spawnSync(PYTHON, ['-m', 'pytest', '--version'], { encoding: 'utf8', shell: true }).status === 0;

let sbx = '';
/** 부모에 비밀을 심어 둔다 — 워크로드가 도는 동시에 키가 안 새는지도 같이 본다. */
const SENTINEL = 'sk-PYTHON-WORKLOAD-SENTINEL-abc123';
let savedApiKey: string | undefined;

beforeAll(async () => {
  sbx = await mkdtemp(path.join(tmpdir(), 'pyload-sbx-'));
  savedApiKey = process.env.API_KEY;
  process.env.API_KEY = SENTINEL;
});

afterEach(() => {
  killAllToolChildren();
});

afterAll(async () => {
  if (savedApiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = savedApiKey;
  await rm(sbx, { recursive: true, force: true });
});

/** 샌드박스에 파일을 쓴다(FILE_WRITE 도구 경로). */
async function write(relPath: string, content: string): Promise<void> {
  const res = await executeTool(sbx, { kind: 'FILE_WRITE', name: 'write_file', relPath, content }, () => {});
  expect(res.status, `write ${relPath} failed`).toBe('SUCCEEDED');
}

/** 샌드박스에서 셸 명령을 돌린다(SHELL 도구 경로). */
async function shell(command: string): Promise<{ out: string; exitCode: number | null }> {
  let out = '';
  const res = await executeTool(
    sbx,
    { kind: 'SHELL', name: 'bash', command },
    (c) => { out += c; },
    undefined,
    { timeoutMs: 120_000 },
  );
  return { out, exitCode: res.exitCode };
}

describe.skipIf(PYTHON === null)('데모 워크로드 — python (ENV 화이트리스트 아래)', () => {
  it('python 이 샌드박스에서 실행되고 출력 인코딩이 정상이다', async () => {
    const r = await shell(`${PYTHON} -c "print('안녕 sandbox')"`);
    expect(r.exitCode, `python 실행 실패: ${r.out}`).toBe(0);
    // PYTHONIOENCODING=utf-8 을 명시 주입하므로 한글이 깨지지 않아야 한다.
    expect(r.out).toContain('안녕 sandbox');
  }, 60_000);

  it('python 이 파일을 쓰고 읽는다(모듈 import 포함)', async () => {
    const r = await shell(
      `${PYTHON} -c "import os,json,sys; open('py.txt','w').write(json.dumps({'v':1})); print(open('py.txt').read())"`,
    );
    expect(r.exitCode, r.out).toBe(0);
    expect(r.out).toContain('"v": 1');
  }, 60_000);

  it('python 이 API_KEY 를 읽을 수 없다(차단 방향도 함께 확인)', async () => {
    const r = await shell(`${PYTHON} -c "import os; print('KEY=' + os.environ.get('API_KEY','<unset>'))"`);
    expect(r.exitCode, r.out).toBe(0);
    expect(r.out).toContain('KEY=<unset>');
    expect(r.out).not.toContain(SENTINEL);
  }, 60_000);
});

describe.skipIf(!HAS_PYTEST)('데모 워크로드 — pytest green (DEMO_SCENARIO 재현)', () => {
  it('파일 생성 → python -m pytest → 전부 통과', async () => {
    // 데모 시나리오와 같은 형태: 결정적 함수 + 함수별 테스트 파일 분리.
    await write(
      'vowels.py',
      [
        'def count_vowels(s):',
        '    return sum(1 for ch in s if ch.lower() in "aeiou")',
        '',
        'def count_consonants(s):',
        '    return sum(1 for ch in s if ch.isalpha() and ch.lower() not in "aeiou")',
        '',
      ].join('\n'),
    );
    await write(
      'test_vowels.py',
      [
        'from vowels import count_vowels, count_consonants',
        '',
        'def test_vowels():',
        '    assert count_vowels("Hello World") == 3',
        '',
        'def test_consonants():',
        '    assert count_consonants("Hello World") == 7',
        '',
      ].join('\n'),
    );

    const r = await shell(`${PYTHON} -m pytest -q`);
    expect(r.exitCode, `pytest 실패:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/2 passed/);
  }, 120_000);

  it('실패하는 테스트는 실패로 보고된다(거짓 green 방지)', async () => {
    await write(
      'test_broken.py',
      ['def test_fails():', '    assert 1 == 2', ''].join('\n'),
    );
    const r = await shell(`${PYTHON} -m pytest -q test_broken.py`);
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toMatch(/1 failed|failed/);
  }, 120_000);
});

describe('환경 진단 기록(스킵 사유를 명시적으로 남긴다)', () => {
  it('python/pytest 탐지 결과를 보고한다', () => {
    // 이 테스트는 항상 통과하지만, 위 스위트가 skip 됐을 때 그 이유를 로그로 남긴다.
    if (PYTHON === null) {
      console.warn('[sandboxPythonWorkload] python 미설치 — python 워크로드 검증 SKIP');
    } else if (!HAS_PYTEST) {
      console.warn(`[sandboxPythonWorkload] ${PYTHON} 있음, pytest 없음 — pytest 케이스 SKIP`);
    }
    expect(true).toBe(true);
  });
});
