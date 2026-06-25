// backend/src/domain/cursor.ts
// keyset 커서 인코딩/디코딩(TRD §4.2). base64url of `createdAtMs + '|' + id`.
// 잘못된 커서는 BadCursorError 로 던진다(라우트에서 400 매핑).

export interface CursorAnchor {
  createdAt: Date;
  id: string;
}

/** 디코드 실패(malformed cursor) — 라우트에서 400 으로 매핑. */
export class BadCursorError extends Error {
  /** HTTP 매핑용 상태코드. */
  readonly statusCode = 400;
  constructor(message = 'Malformed cursor') {
    super(message);
    this.name = 'BadCursorError';
  }
}

/** {createdAt,id} → base64url("<createdAtMs>|<id>") */
export function encodeCursor(anchor: CursorAnchor): string {
  const ms = anchor.createdAt.getTime();
  const raw = `${ms}|${anchor.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** base64url("<createdAtMs>|<id>") → {createdAt,id}. 형식 위반 시 BadCursorError. */
export function decodeCursor(cursor: string): CursorAnchor {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new BadCursorError();
  }
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new BadCursorError();
  }
  const sep = raw.indexOf('|');
  if (sep < 0) {
    throw new BadCursorError();
  }
  const msPart = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (msPart.length === 0 || id.length === 0) {
    throw new BadCursorError();
  }
  // 정수 milliseconds 만 허용.
  if (!/^\d+$/.test(msPart)) {
    throw new BadCursorError();
  }
  const ms = Number(msPart);
  if (!Number.isFinite(ms)) {
    throw new BadCursorError();
  }
  return { createdAt: new Date(ms), id };
}
