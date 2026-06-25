// backend/src/routes/uploads.ts
// BE-UPLOAD (Feature A): 메시지 컴포저용 이미지 업로드.
//   POST /uploads (requireAuth)  multipart 파일 1개 → <uuid>.<ext> 로 저장 → 201 { imageUrl }
//
// 보안(CLAUDE.md/TRD §8):
//   - 파일명은 항상 서버가 부여한 UUID. 클라이언트 파일명은 절대 사용/노출하지 않는다(경로 주입 차단).
//   - MIME 화이트리스트(png/jpeg/webp/gif). 그 외는 400.
//   - 5MB 초과는 413(@fastify/multipart 의 fileSize limit 가 1차, 여기서도 truncated 검사).
//   - 응답에는 imageUrl 만. 키/시크릿/내부 절대경로 미포함.

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/** 허용 MIME → 저장 확장자 매핑(확장자는 MIME 에서만 도출 — 클라 파일명 미사용). */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 업로드 파일 크기 상한(바이트). @fastify/multipart 의 fileSize limit 과 일치(5MB). */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post('/uploads', { preHandler: app.requireAuth }, async (req, reply) => {
    // @fastify/multipart: 단일 파일을 읽는다. 파일이 없으면 400.
    let data;
    try {
      data = await req.file();
    } catch {
      // 파싱 단계 실패(멀티파트 아님 등).
      return reply.code(400).send({ error: 'invalid multipart upload' });
    }
    if (!data) {
      return reply.code(400).send({ error: 'file is required' });
    }

    // ── MIME 화이트리스트 검사(비이미지/미허용 타입 → 400). ──
    const mime = (data.mimetype || '').toLowerCase();
    const ext = MIME_EXT[mime];
    if (!ext) {
      // 스트림을 비워 백프레셔로 인한 hang 을 막는다(소비 후 거부).
      try {
        await data.toBuffer();
      } catch {
        /* noop — 어차피 거부 */
      }
      return reply.code(400).send({ error: 'unsupported image type' });
    }

    // ── 파일 바이트 수집(5MB 상한). multipart fileSize limit 초과 시 truncated. ──
    let buf: Buffer;
    try {
      buf = await data.toBuffer();
    } catch {
      // multipart 가 fileSize 초과로 스트림을 끊으면 여기로 떨어질 수 있다 → 413.
      return reply.code(413).send({ error: 'file too large' });
    }
    // @fastify/multipart 는 limit 초과 시 file.truncated 플래그를 세운다.
    if (data.file.truncated || buf.byteLength > MAX_UPLOAD_BYTES) {
      return reply.code(413).send({ error: 'file too large' });
    }

    // ── UUID 파일명으로 기록(클라 파일명 절대 미사용 — 경로 주입/충돌 차단). ──
    const name = `${randomUUID()}.${ext}`;
    const absPath = path.join(config.uploadDir, name);
    await writeFile(absPath, buf);

    // 자기-소유 정적 경로만 반환(키/내부 절대경로 미포함).
    return reply.code(201).send({ imageUrl: `/uploads/${name}` });
  });
}
