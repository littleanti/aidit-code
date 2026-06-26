// <SafeMarkdown> — sanitize 초크포인트(부모 Aidit XC-3 이식)를 감싸는 렌더 래퍼.
// 사용자 작성 본문은 이 컴포넌트(또는 `renderMarkdownSafe`)로 렌더해 raw 사용자
// HTML 이 절대 그대로 주입되지 않게 한다.
//
// 여기서 `dangerouslySetInnerHTML` 에 넘기는 HTML 은 항상 marked + DOMPurify(./sanitize)
// 를 거친 값이라 구성상(by construction) 살균되어 있다.

import { useMemo } from 'react';
import { renderMarkdownSafe } from './sanitize';

interface SafeMarkdownProps {
  /** untrusted 마크다운 원문(게시글 본문 등). */
  text: string;
  /** 래퍼 엘리먼트 태그 — 기본은 block <div>. */
  as?: 'div' | 'span' | 'p';
  /** 래퍼에 적용할 클래스(타이포그래피 스타일). */
  className?: string;
}

/**
 * untrusted 마크다운을 살균된 HTML 로 렌더. `text` 기준 memo 라 본문이 실제로
 * 바뀔 때만 marked+DOMPurify 패스가 재실행된다.
 */
export default function SafeMarkdown({
  text,
  as = 'div',
  className,
}: SafeMarkdownProps) {
  const html = useMemo(() => renderMarkdownSafe(text), [text]);
  const Tag = as;
  return (
    <Tag
      className={className}
      // 구성상 안전: `html` 은 renderMarkdownSafe 의 출력(DOMPurify 엄격 allowlist).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
