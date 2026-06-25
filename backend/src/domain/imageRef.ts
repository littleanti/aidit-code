// backend/src/domain/imageRef.ts
// 메시지에 첨부된 이미지 참조(/uploads/<uuid>.<ext>)의 검증/해석 공용 헬퍼.
//
// 보안(CLAUDE.md/TRD §8):
//   - 화이트리스트: 정확히 `/uploads/<uuid>.<ext>` 형태만 허용한다.
//     절대경로(http(s)://, file://, C:\, /etc/...)·traversal('..')·다른 prefix 는 전부 거부.
//   - 해석된 절대경로는 반드시 업로드 디렉토리 내부여야 한다(경로 가드 — 워커가 읽기 전에 재확인).
//   - 확장자는 허용 이미지 확장자만(MIME 도출과 일관).

import path from 'node:path';
import { config } from '../config.js';

/** 허용 확장자 → MIME(워커가 data-url 구성 시 사용). */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** `/uploads/<uuid>.<ext>` 정확 매칭. uuid 는 표준 8-4-4-4-12 hex(대소문자 무관). */
const UPLOADS_RE =
  /^\/uploads\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.(png|jpe?g|webp|gif)$/;

/**
 * 후보 imageUrl 이 자기-소유 업로드 경로 형태인지 검사한다.
 * 형태만 본다(파일 존재 여부는 보지 않음 — 저장 직후 메시지 생성 레이스 허용).
 */
export function isOwnUploadUrl(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') return false;
  return UPLOADS_RE.test(candidate);
}

/** 해석 결과: 정적 URL + 호스트 절대경로 + MIME. */
export interface ResolvedImageRef {
  /** 그대로 DB 에 저장/응답할 정적 경로(/uploads/<uuid>.<ext>). */
  url: string;
  /** 워커가 읽을 호스트 절대경로(업로드 디렉토리 내부 — 가드 통과 보장). */
  absPath: string;
  /** image_url data-url 구성용 MIME. */
  mime: string;
}

/**
 * imageUrl 을 검증하고 호스트 절대경로 + MIME 으로 해석한다.
 * 화이트리스트 불통과 또는 경로가 업로드 디렉토리를 벗어나면 null(거부).
 */
export function resolveImageRef(candidate: unknown): ResolvedImageRef | null {
  if (typeof candidate !== 'string') return null;
  const m = UPLOADS_RE.exec(candidate);
  if (!m) return null;
  const fileName = `${m[1]}.${m[2]}`;
  const ext = m[2].toLowerCase();
  const mime = EXT_MIME[ext];
  if (!mime) return null;

  // 경로 가드: 업로드 디렉토리 기준 join 후 내부인지 재확인(uuid 형태라 traversal 불가하지만 방어적으로).
  const rootAbs = path.resolve(config.uploadDir);
  const absPath = path.resolve(rootAbs, fileName);
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (!absPath.startsWith(withSep)) return null;

  return { url: candidate, absPath, mime };
}
