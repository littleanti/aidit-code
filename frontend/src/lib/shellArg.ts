// 장식용 ShellPrompt 줄의 라이브 인자 포매터(부모 Aidit 이식).
//
// 각 주요 화면은 라이브 사용자 입력을 반영하는 작은 셸 명령(예: `post --new "title"`)을
// 에코한다. 사용자 입력 부분은 단일 줄·고정폭 터미널 에코에 안전하도록(레이아웃
// 시프트·가로 스크롤 없음, 따옴표가 줄을 깨지 않도록) 정규화한다.
//
// PURE 헬퍼(React/state 없음). INNER 문자열만 반환 — 호출부가 따옴표로 감싼다.
// 명령은 실행되지 않고 프롬프트 줄 전체가 aria-hidden 이라 이스케이프는 순전히 표시용.

interface FormatPromptArgOpts {
  /** 트렁케이트 전 inner 문자열의 최대 표시 길이. 기본 32. */
  max?: number;
}

/** 단일 생략 문자(점 3개 아님)로 트렁케이션을 콤팩트하게 유지. */
const ELLIPSIS = '…';

/**
 * raw 사용자 값을 셸 프롬프트 인라인 표시용으로 포맷한다. 순서대로:
 *   1) 모든 공백 런(개행/탭 포함)을 한 칸으로 collapse;
 *   2) 앞뒤 공백 trim;
 *   3) `max`(기본 32)보다 길면 `max-1`자 + 생략 문자;
 *   4) 큰따옴표를 `\"` 로 이스케이프(표시용).
 * INNER 문자열만 반환 — 호출부가 따옴표로 감싼다.
 */
export function formatPromptArg(raw: string, opts?: FormatPromptArgOpts): string {
  const max = opts?.max ?? 32;

  let result = raw.replace(/\s+/g, ' ').trim();

  if (result.length > max) {
    result = result.slice(0, max - 1) + ELLIPSIS;
  }

  result = result.replace(/"/g, '\\"');

  return result;
}
