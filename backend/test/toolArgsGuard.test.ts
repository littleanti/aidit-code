// backend/test/toolArgsGuard.test.ts
// 빈/불량 tool_call 인자 가드 검증(데모 EISDIR 회귀 방지):
//   (1) parseToolArgs(순수): 빈 path·빈 command·JSON 파싱 실패·비객체 인자를 ok:false 로 거른다.
//       정상 인자는 ok:true + args 반환(회귀).
//   (2) executeTool(서버 2중 방어): FILE_WRITE/READ/DELETE 에 빈 relPath 가 오면 fs 를 건드리지
//       않고 FAILED 'invalid path: empty relPath' 로 마감한다(EISDIR 도달 불가).

import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseToolArgs } from '../src/agent/piWorkerBody.mjs';
import { executeTool, INVALID_PATH_RESULT } from '../src/agent/toolExec.js';

describe('parseToolArgs (worker-side tool_call argument gate)', () => {
  it('rejects empty/whitespace path for write_file/read_file/delete_file', () => {
    expect(parseToolArgs('write_file', '{"path":"","content":""}').ok).toBe(false);
    expect(parseToolArgs('write_file', '{"path":"  ","content":"x"}').ok).toBe(false);
    expect(parseToolArgs('write_file', '{}').ok).toBe(false);
    expect(parseToolArgs('read_file', '{"path":""}').ok).toBe(false);
    expect(parseToolArgs('delete_file', '{}').ok).toBe(false);
  });

  it('rejects write_file without string content, bash without command', () => {
    expect(parseToolArgs('write_file', '{"path":"a.py"}').ok).toBe(false);
    expect(parseToolArgs('bash', '{"command":""}').ok).toBe(false);
    expect(parseToolArgs('bash', '{}').ok).toBe(false);
  });

  it('rejects malformed JSON and non-object arguments', () => {
    expect(parseToolArgs('write_file', '{"path":"a.py","content":"tru').ok).toBe(false);
    expect(parseToolArgs('write_file', '[]').ok).toBe(false);
    expect(parseToolArgs('write_file', 'null').ok).toBe(false);
  });

  it('accepts valid arguments (regression) — empty argsText defaults to {}', () => {
    const w = parseToolArgs('write_file', '{"path":"a.py","content":""}');
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.args.path).toBe('a.py');
    expect(parseToolArgs('read_file', '{"path":"a.py"}').ok).toBe(true);
    expect(parseToolArgs('bash', '{"command":"echo hi"}').ok).toBe(true);
    // 알 수 없는 도구는 여기서 거르지 않는다(호출부 toolCallToIntent 가 null 처리).
    expect(parseToolArgs('unknown_tool', '{}').ok).toBe(true);
  });
});

describe('executeTool empty-relPath guard (server-side, 2nd line of defense)', () => {
  async function makeRoot(): Promise<string> {
    return await mkdtemp(path.join(tmpdir(), 'tg-'));
  }

  it('FILE_WRITE with empty relPath fails cleanly without touching fs (no EISDIR)', async () => {
    const root = await makeRoot();
    const chunks: string[] = [];
    const result = await executeTool(
      root,
      { kind: 'FILE_WRITE', name: 'write_file', relPath: '', content: '' },
      (c) => chunks.push(c),
    );
    expect(result.status).toBe('FAILED');
    expect(result.result).toBe(INVALID_PATH_RESULT);
    expect(chunks.join('')).not.toContain('EISDIR');
    expect(await readdir(root)).toEqual([]); // 루트에 아무것도 안 만든다.
  });

  it('FILE_READ / FILE_DELETE with empty relPath also fail with INVALID_PATH_RESULT', async () => {
    const root = await makeRoot();
    const read = await executeTool(root, { kind: 'FILE_READ', name: 'read_file', relPath: '  ' }, () => {});
    expect(read.status).toBe('FAILED');
    expect(read.result).toBe(INVALID_PATH_RESULT);
    const del = await executeTool(root, { kind: 'FILE_DELETE', name: 'delete_file' }, () => {});
    expect(del.status).toBe('FAILED');
    expect(del.result).toBe(INVALID_PATH_RESULT);
  });

  it('FILE_WRITE with a valid relPath still succeeds (regression)', async () => {
    const root = await makeRoot();
    const result = await executeTool(
      root,
      { kind: 'FILE_WRITE', name: 'write_file', relPath: 'a.txt', content: 'hi' },
      () => {},
    );
    expect(result.status).toBe('SUCCEEDED');
  });
});
