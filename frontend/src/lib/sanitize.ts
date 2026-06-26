// 클라이언트 살균 초크포인트(부모 Aidit XC-3 이식).
//
// 모든 사용자 작성 콘텐츠(게시글 본문 등)는 untrusted 마크다운이므로 반드시 이
// 모듈을 거쳐 렌더한다 — 업스트림 HTML 을 raw `dangerouslySetInnerHTML` 로
// 넣지 않는다. 파이프라인:
//
//     markdown ──(normalize)──▶ (marked) ──▶ HTML ──(DOMPurify)──▶ safe HTML
//
// 보안: DOMPurify 가 script/이벤트 핸들러/iframe/위험 URL 스킴을 콘텐츠가 DOM 에
// 닿기 전에 제거한다. 파싱 throw·비문자열 입력 시 raw HTML 대신 escape 평문으로
// 폴백 → 최악의 경우 "사용자가 자기 마크다운 원문을 본다"이지 스크립트 실행이 아니다.

import DOMPurify, { type Config } from 'dompurify';
import { marked } from 'marked';

// 인라인 지향 마크다운: raw HTML passthrough 없음(marked 가 구조화된 태그만 방출),
// GitHub 스타일 줄바꿈으로 채팅 개행 보존, deprecated mangling/header-id 부작용 없음.
marked.setOptions({
  gfm: true,
  breaks: true,
});

// 엄격 allowlist — 서식 + 링크 + 코드 + GFM 표 + 이미지. 의도적으로 제외:
// script/style/iframe/object/embed/form/input, on* 이벤트 핸들러, `style` 속성.
// 이미지/링크 URL 은 ALLOWED_URI_REGEXP 로 http(s)/mailto 만 통과(javascript:/data: 차단).
const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr',
    'strong', 'b', 'em', 'i', 's', 'del', 'mark', 'sub', 'sup',
    'a',
    'ul', 'ol', 'li',
    'blockquote',
    'code', 'pre',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img',
    'span',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt', 'align'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: [],
  RETURN_TRUSTED_TYPE: false,
};

// 코드 마스킹용 PUA 센티넬(실제 마크다운엔 등장하지 않는 코드포인트라 충돌 없음).
const MASK_OPEN = '';
const MASK_CLOSE = '';

/**
 * `**` 구분자 안쪽에 군더더기 공백이 낀 "느슨한 굵게"("** text **" → "**text**")를
 * 정규화한다. AI 응답이 자주 이렇게 내보내므로 의도대로 다듬는다. 코드(``` 펜스 ·
 * 인라인 `code`)는 먼저 마스킹해 그 안의 `**`(예: 파이썬 `**kwargs`)는 건드리지
 * 않는다. 더블 애스터리스크(굵게)만 처리하고, 단일 `*`(불릿·곱셈 충돌)은 둔다.
 */
function normalizeLooseBold(md: string): string {
  const stash: string[] = [];
  const mask = (s: string): string => {
    const token = `${MASK_OPEN}${stash.length}${MASK_CLOSE}`;
    stash.push(s);
    return token;
  };
  let out = md
    .replace(/```[\s\S]*?```/g, mask) // fenced code blocks
    .replace(/`[^`\n]*`/g, mask); // inline code spans
  // **...** 런 안쪽 가장자리 공백 제거(내부엔 '*'/개행 없음).
  out = out.replace(/\*\*[ \t]*(\S[^*\n]*?\S|\S)[ \t]*\*\*/g, '**$1**');
  // 내부가 구두점으로 시작/끝나는 intraword 굵게는 CommonMark flanking 규칙상
  // 리터럴로 남는데(예: 앞**'내용'**뒤), 그런 런만 <strong> 으로 강제. 띄어쓰기/
  // 단독 굵게·일반 intraword 굵게(A**B**C)는 marked 에 맡긴다. 코드는 여전히
  // 마스킹 상태라 코드 안 ** 는 건드리지 않는다.
  out = out.replace(
    /\*\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*\*/g,
    (m: string, inner: string, off: number, str: string) => {
      const before = str[off - 1] ?? '';
      const after = str[off + m.length] ?? '';
      const wordy = (c: string) => /[\p{L}\p{N}]/u.test(c);
      const punctEdge =
        /[^\p{L}\p{N}\s]/u.test(inner[0]) ||
        /[^\p{L}\p{N}\s]/u.test(inner[inner.length - 1]);
      return (wordy(before) || wordy(after)) && punctEdge
        ? `<strong>${inner}</strong>`
        : m;
    },
  );
  // 마스킹한 코드 원복.
  out = out.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g'),
    (_, i: string) => stash[Number(i)],
  );
  return out;
}

/** 평문 폴백: HTML escape 로 원문을 그대로 보여줄 뿐 절대 파싱하지 않는다. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * untrusted 마크다운을 SAFE HTML 문자열로 변환한다.
 * `dangerouslySetInnerHTML` 에 쓰기 적합한 살균된 HTML 을 반환. 실패(비문자열·
 * 파서 throw) 시 escape 평문을 반환해 최악의 경우에도 스크립트 실행은 없다.
 */
export function renderMarkdownSafe(md: string): string {
  if (typeof md !== 'string' || md.length === 0) return '';
  try {
    const normalized = normalizeLooseBold(md);
    // async:false 일 때 marked.parse 는 동기.
    const rawHtml = marked.parse(normalized, { async: false }) as string;
    return (DOMPurify.sanitize(rawHtml, PURIFY_CONFIG) as string).trim();
  } catch {
    return escapeHtml(md);
  }
}
