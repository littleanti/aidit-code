// backend/src/routes/files.ts
// BE-FILES + BE-FILECONTENT (TRD §4·§6.3, PLAN §M6):
//   GET /posts/:id/files?path=          샌드박스 파일 트리(디렉토리 엔트리 목록, optionalAuth)
//   GET /posts/:id/files/content?path=  샌드박스 단일 파일 내용(optionalAuth)
//
// 경로 격리(TRD §6.3): 요청 path 는 항상 sandbox.path 기준으로 pathGuard.resolveInsideRoot 로 해석한다.
//   '..'/절대경로/symlink 탈출은 PathEscapeError → 400 {error:'path violation'}. 루트 밖은 절대 읽지 않는다.
//
// PoC 범위(문서화): 트리는 요청된 디렉토리의 단일 레벨(shallow)만 반환한다. FE 가 하위를 lazy 로 확장한다.
// 보안(CLAUDE.md/TRD §8): 응답에 LLM 키 절대 미포함 — 경로/엔트리/내용/크기만 다룬다.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { readdir, stat, readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { resolveInsideRoot, PathEscapeError } from '../sandbox/pathGuard.js';

/** 단일 파일 내용 반환 상한(초과 시 잘라서 truncated:true). */
const MAX_CONTENT_BYTES = 256 * 1024;
/** 바이너리 판별 시 검사할 선두 바이트 수(NUL 스니프). */
const BINARY_SNIFF_BYTES = 8192;

/** path violation 응답(경로 탈출 — TRD §6.3). */
const PATH_VIOLATION = { error: 'path violation' } as const;

/** 디렉토리 엔트리(루트 상대 경로, 파일/디렉토리, size). */
interface TreeEntry {
  name: string;
  /** 루트 상대 경로(forward-slash 정규화). */
  path: string;
  type: 'file' | 'dir';
  /** 파일이면 바이트 크기. 디렉토리는 생략. */
  size?: number;
}

/** 루트 상대 경로를 forward-slash 로 정규화하고 선행 './' 를 제거한다. */
function toRootRelative(rootAbs: string, abs: string): string {
  const rel = path.relative(rootAbs, abs).replace(/\\/g, '/');
  return rel.replace(/^\.\//, '');
}

/** ENOENT(존재하지 않음) 에러인지. CREATING 단계의 빈 트리 처리를 위해 사용. */
function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * NUL 바이트 스니프로 바이너리 여부 판정. 선두 BINARY_SNIFF_BYTES 만 읽어 0x00 포함 시 binary.
 * (PoC 휴리스틱 — 0x00 이 없으면 텍스트로 간주하고 utf8 로 읽는다.)
 */
async function looksBinary(abs: string): Promise<boolean> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}

export async function filesRoutes(app: FastifyInstance): Promise<void> {
  // ── 파일 트리(단일 레벨 디렉토리 엔트리) ───────────────
  app.get('/posts/:id/files', { preHandler: app.optionalAuth }, async (req, reply) => {
    const { id: postId } = req.params as { id: string };
    const query = (req.query ?? {}) as { path?: unknown };
    const relInput = typeof query.path === 'string' && query.path.length > 0 ? query.path : '.';

    const sandbox = await prisma.sandbox.findUnique({ where: { postId } });
    if (!sandbox) {
      return reply.code(404).send({ error: 'post not found' });
    }

    const rootAbs = path.resolve(sandbox.path);
    let dirAbs: string;
    try {
      dirAbs = resolveInsideRoot(rootAbs, relInput);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return reply.code(400).send(PATH_VIOLATION);
      }
      throw err;
    }

    let dirents;
    try {
      dirents = await readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      // CREATING 등으로 디렉토리가 아직 없으면 빈 트리로 우아하게 응답.
      if (isENOENT(err)) {
        return reply.code(200).send({ path: toRootRelative(rootAbs, dirAbs), entries: [] });
      }
      throw err;
    }

    const entries: TreeEntry[] = [];
    for (const d of dirents) {
      const childAbs = path.join(dirAbs, d.name);
      const isDir = d.isDirectory();
      const entry: TreeEntry = {
        name: d.name,
        path: toRootRelative(rootAbs, childAbs),
        type: isDir ? 'dir' : 'file',
      };
      if (!isDir) {
        try {
          const st = await stat(childAbs);
          entry.size = st.size;
        } catch {
          // 심링크 깨짐 등 — size 없이 엔트리만 노출.
        }
      }
      entries.push(entry);
    }

    // dirs-first, 그다음 이름 오름차순.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return reply.code(200).send({ path: toRootRelative(rootAbs, dirAbs), entries });
  });

  // ── 단일 파일 내용 ────────────────────────────────────
  app.get('/posts/:id/files/content', { preHandler: app.optionalAuth }, async (req, reply) => {
    const { id: postId } = req.params as { id: string };
    const query = (req.query ?? {}) as { path?: unknown };
    const relInput = typeof query.path === 'string' ? query.path : '';

    if (!relInput) {
      return reply.code(400).send({ error: 'path is required' });
    }

    const sandbox = await prisma.sandbox.findUnique({ where: { postId } });
    if (!sandbox) {
      return reply.code(404).send({ error: 'post not found' });
    }

    const rootAbs = path.resolve(sandbox.path);
    let abs: string;
    try {
      abs = resolveInsideRoot(rootAbs, relInput);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return reply.code(400).send(PATH_VIOLATION);
      }
      throw err;
    }

    return await readContent(reply, rootAbs, abs);
  });
}

/** 단일 파일 내용 응답을 구성한다(디렉토리/바이너리/대용량 분기). */
async function readContent(
  reply: FastifyReply,
  rootAbs: string,
  abs: string,
): Promise<FastifyReply> {
  let st;
  try {
    st = await stat(abs);
  } catch (err) {
    if (isENOENT(err)) {
      return reply.code(404).send({ error: 'file not found' });
    }
    throw err;
  }

  if (st.isDirectory()) {
    return reply.code(400).send({ error: 'path is a directory' });
  }

  const relPath = toRootRelative(rootAbs, abs);
  const size = st.size;

  // 바이너리: 메타만(내용 미포함).
  if (await looksBinary(abs)) {
    return reply.code(200).send({ binary: true, size, path: relPath });
  }

  // 대용량: 상한까지만 읽어 truncated:true.
  if (size > MAX_CONTENT_BYTES) {
    const fh = await open(abs, 'r');
    try {
      const buf = Buffer.alloc(MAX_CONTENT_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_CONTENT_BYTES, 0);
      const content = buf.subarray(0, bytesRead).toString('utf8');
      return reply.code(200).send({ content, truncated: true, size, path: relPath });
    } finally {
      await fh.close();
    }
  }

  const content = await readFile(abs, 'utf8');
  return reply.code(200).send({ content, truncated: false, size, path: relPath });
}
