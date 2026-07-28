// src/lib/sanitize.test.ts
// renderMarkdownSafe 는 untrusted 마크다운이 `dangerouslySetInnerHTML` 로 들어가기 직전의
// **마지막 방어선**이다(SafeMarkdown.tsx). 여기서 새는 건 곧 저장형 XSS이므로,
// allowlist 통과/차단을 공격 벡터별로 못박는다.
//
// 판정 원칙: "출력에 위험 문자열이 없다"가 아니라 **"위험 노드/속성이 DOM 에 살아남지 않는다"**를
// 본다. 살균 결과를 실제로 파싱해서 script 태그·on* 속성·위험 스킴 href 가 0개임을 단언한다
// (문자열 매칭만 하면 `&lt;script&gt;` 같은 안전한 escape 결과를 오탐한다).

import { describe, it, expect } from 'vitest';
import { renderMarkdownSafe } from './sanitize';

/** 살균 결과를 DOM 으로 파싱해 검사용 루트를 돌려준다. */
function parse(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

/** 루트 이하 모든 요소의 on* 속성을 모은다. */
function inlineHandlers(root: HTMLElement): string[] {
  const found: string[] = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) found.push(`${el.tagName}.${attr.name}`);
    }
  }
  return found;
}

describe('renderMarkdownSafe — XSS 차단(핵심 보안 계약)', () => {
  it('script 태그를 제거한다 (raw HTML passthrough 없음)', () => {
    const out = renderMarkdownSafe('안녕 <script>alert(1)</script> 하세요');
    expect(parse(out).querySelectorAll('script')).toHaveLength(0);
    expect(out).not.toMatch(/<script/i);
  });

  it('인라인 이벤트 핸들러(on*)를 전부 벗겨낸다', () => {
    const vectors = [
      '<img src=x onerror="alert(1)">',
      '<div onclick="alert(1)">클릭</div>',
      '<svg/onload=alert(1)>',
      '<body onload=alert(1)>',
      '<a href="https://ok.example" onmouseover="alert(1)">링크</a>',
    ];
    for (const v of vectors) {
      const root = parse(renderMarkdownSafe(v));
      expect(inlineHandlers(root), `handler survived for: ${v}`).toEqual([]);
    }
  });

  it('javascript: / data: / vbscript: URL 을 링크·이미지에서 차단한다', () => {
    const vectors = [
      '[클릭](javascript:alert(1))',
      '[클릭](JaVaScRiPt:alert(1))',
      '[클릭](vbscript:msgbox(1))',
      '![img](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '<a href="javascript:alert(1)">클릭</a>',
      '<img src="javascript:alert(1)">',
    ];
    for (const v of vectors) {
      const root = parse(renderMarkdownSafe(v));
      for (const a of Array.from(root.querySelectorAll('a'))) {
        expect(a.getAttribute('href') ?? '', `href survived for: ${v}`).not.toMatch(
          /^\s*(javascript|data|vbscript):/i,
        );
      }
      for (const img of Array.from(root.querySelectorAll('img'))) {
        expect(img.getAttribute('src') ?? '', `src survived for: ${v}`).not.toMatch(
          /^\s*(javascript|data|vbscript):/i,
        );
      }
    }
  });

  it('iframe/object/embed/form/input 등 위험 태그를 제거한다', () => {
    const md = [
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object>',
      '<embed src="x">',
      '<form action="/steal"><input name="pw" type="password"></form>',
      '<style>body{display:none}</style>',
      '<base href="https://evil.example/">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    ].join('\n\n');
    const root = parse(renderMarkdownSafe(md));
    for (const tag of ['iframe', 'object', 'embed', 'form', 'input', 'style', 'base', 'meta']) {
      expect(root.querySelectorAll(tag), `${tag} survived`).toHaveLength(0);
    }
  });

  it('style 속성을 제거한다 (allowlist 밖 — clickjacking/오버레이 방지)', () => {
    const root = parse(
      renderMarkdownSafe('<span style="position:fixed;inset:0;z-index:9999">덮개</span>'),
    );
    for (const el of Array.from(root.querySelectorAll('*'))) {
      expect(el.getAttribute('style')).toBeNull();
    }
  });

  it('data-* 속성을 제거한다 (ALLOW_DATA_ATTR:false)', () => {
    const root = parse(renderMarkdownSafe('<span data-evil="1">x</span>'));
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name).not.toMatch(/^data-/i);
      }
    }
  });

  it('중첩·난독화된 벡터에도 script 가 부활하지 않는다', () => {
    const vectors = [
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
      '<img src="x" onerror=alert&#40;1&#41;>',
      '`<script>alert(1)</script>`', // 인라인 코드 안 — 텍스트로만 남아야 한다
    ];
    for (const v of vectors) {
      const root = parse(renderMarkdownSafe(v));
      expect(root.querySelectorAll('script'), `script survived for: ${v}`).toHaveLength(0);
      expect(inlineHandlers(root)).toEqual([]);
    }
  });
});

describe('renderMarkdownSafe — allowlist 통과(기능 보존)', () => {
  it('기본 서식을 살린다', () => {
    const root = parse(renderMarkdownSafe('**굵게** _기울임_ `코드`'));
    expect(root.querySelector('strong')?.textContent).toBe('굵게');
    expect(root.querySelector('em')?.textContent).toBe('기울임');
    expect(root.querySelector('code')?.textContent).toBe('코드');
  });

  it('http(s)·mailto 링크는 통과시킨다', () => {
    for (const url of ['https://example.com/a', 'http://example.com', 'mailto:a@b.co']) {
      const root = parse(renderMarkdownSafe(`[링크](${url})`));
      expect(root.querySelector('a')?.getAttribute('href'), `blocked: ${url}`).toBe(url);
    }
  });

  it('코드 펜스·목록·표를 렌더한다', () => {
    const md = [
      '```python',
      'def f(**kwargs): pass',
      '```',
      '',
      '- 하나',
      '- 둘',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const root = parse(renderMarkdownSafe(md));
    expect(root.querySelector('pre code')?.textContent).toContain('**kwargs');
    expect(root.querySelectorAll('li')).toHaveLength(2);
    expect(root.querySelectorAll('table tbody td')).toHaveLength(2);
  });

  it('GFM 줄바꿈(breaks)을 보존한다 — 채팅 개행', () => {
    const root = parse(renderMarkdownSafe('첫 줄\n둘째 줄'));
    expect(root.querySelectorAll('br').length).toBeGreaterThanOrEqual(1);
  });
});

describe('renderMarkdownSafe — 느슨한 굵게 정규화', () => {
  it('구분자 안쪽 공백을 흡수한다 ("** text **" → <strong>)', () => {
    const root = parse(renderMarkdownSafe('앞 ** 굵게 ** 뒤'));
    expect(root.querySelector('strong')?.textContent).toBe('굵게');
  });

  it('코드 안의 ** 는 건드리지 않는다 (파이썬 **kwargs)', () => {
    const inline = parse(renderMarkdownSafe('`def f(**kwargs)` 설명'));
    expect(inline.querySelector('code')?.textContent).toBe('def f(**kwargs)');
    expect(inline.querySelector('code strong')).toBeNull();

    const fenced = parse(renderMarkdownSafe('```\nf(** a **)\n```'));
    expect(fenced.querySelector('pre code')?.textContent).toContain('** a **');
    expect(fenced.querySelector('pre strong')).toBeNull();
  });

  it('구두점으로 둘러싸인 intraword 굵게를 강제 렌더한다', () => {
    const root = parse(renderMarkdownSafe("앞**'내용'**뒤"));
    expect(root.querySelector('strong')?.textContent).toBe("'내용'");
  });
});

describe('renderMarkdownSafe — 입력 방어', () => {
  it('빈 문자열·비문자열 입력에 빈 문자열을 돌려준다(throw 없음)', () => {
    expect(renderMarkdownSafe('')).toBe('');
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(renderMarkdownSafe(bad as unknown as string)).toBe('');
    }
  });

  it('아주 긴 입력에도 throw 하지 않는다', () => {
    const long = '**a** '.repeat(20_000);
    expect(() => renderMarkdownSafe(long)).not.toThrow();
  });

  it('평문은 텍스트로 보존된다', () => {
    const root = parse(renderMarkdownSafe('그냥 평문입니다'));
    expect(root.textContent).toContain('그냥 평문입니다');
  });
});
