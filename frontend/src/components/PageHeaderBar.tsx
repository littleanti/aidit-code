import type { ReactNode } from 'react';
import { useHideOnScroll } from '../hooks/useHideOnScroll';

// Sticky page header bar (부모 Aidit 이식) — 글로벌 앱바(h-12, AppShell `sticky top-0`)
// 바로 아래에 고정되어 모든 주요 화면이 하나의 "고정 상단바" 언어를 공유한다.
// window 스크롤(및 페이지의 IntersectionObserver 무한스크롤)은 그대로 동작 —
// 내부 스크롤 컨테이너를 만들지 않고 sticky 만 한다.
//
// 배치 계약: 페이지의 FIRST child 로 렌더하고, 페이지 ShellPrompt 를 바로 뒤에 둔다.
// `-mt-4` 가 <main> 의 pt-4 를, `-mx-4` 가 모바일 좌우 패딩을 상쇄해 테두리/배경이
// 가장자리까지 풀블리드된다. (Aidit-Code 토큰: term-border→term-line,
// term-screen 솔리드→term-nav.)
//
// `autoHide`(옵트인): true 면 게시글(Thread)처럼 아래로 스크롤할 때 글로벌 앱바
// 뒤로 슬라이드업되어 사라지고, 위로 스크롤하거나 최상단에선 다시 나타난다 —
// 긴 댓글 스레드에서 댓글 영역을 넓힌다. 글로벌 헤더(z-20)보다 낮은 z-10 이라
// 숨을 때 그 뒤로 들어간다. 다른 페이지는 기본값(false)이라 항상 고정.
export default function PageHeaderBar({
  children,
  autoHide = false,
}: {
  children: ReactNode;
  autoHide?: boolean;
}) {
  const hide = useHideOnScroll() && autoHide;
  return (
    <div
      className={`sticky top-12 z-10 -mx-4 -mt-4 flex h-12 items-center gap-2 border-b border-term-line bg-term-screen px-4 transition-transform duration-200 ${
        hide ? '-translate-y-[calc(100%+1px)]' : 'translate-y-0'
      }`}
    >
      {children}
    </div>
  );
}
