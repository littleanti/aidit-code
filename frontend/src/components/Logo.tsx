import React from 'react';

interface LogoProps {
  size?: 'sm' | 'lg';
  className?: string;
  withWordmark?: boolean;
}

// Green-phosphor CRT brand mark, ported from parent Aidit.
// Inline SVG triangle "A" (open phosphor stroke, no fill) + optional wordmark.
// Uses Audit-Code term-* token names (re-valued to the Aidit palette).
export default function Logo({
  size = 'sm',
  className,
  withWordmark = true,
}: LogoProps): React.ReactElement {
  const markClass = size === 'lg' ? 'h-12 w-12' : 'h-6 w-6';
  const wordmarkClass =
    size === 'lg'
      ? 'font-mono text-3xl font-bold uppercase tracking-[3px] text-term-fg-bright [text-shadow:0_0_10px_rgba(125,255,160,0.6)]'
      : 'font-mono text-lg font-bold uppercase tracking-[3px] text-term-fg-bright [text-shadow:0_0_6px_rgba(125,255,160,0.45)]';
  const gapClass = size === 'lg' ? 'gap-2.5' : 'gap-2';

  return (
    <span
      className={`inline-flex items-center ${gapClass}${className ? ` ${className}` : ''}`}
      aria-label="AIDIT-CODE"
    >
      <svg
        className={`${markClass} [filter:drop-shadow(0_0_4px_rgba(125,255,160,0.55))]`}
        viewBox="0 0 48 48"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-hidden={withWordmark ? true : undefined}
        focusable="false"
      >
        {/* Terminal triangle "A"-mark: open green-phosphor stroke, no fill. */}
        <path
          d="M22.9 7.4 Q24 5 25.1 7.4 L42 41 Q42.8 42.5 41 42.5 L33 42.5 Q31.8 42.5 31.2 41.4 L24.9 29.6 Q24 28 23.1 29.6 L16.8 41.4 Q16.2 42.5 15 42.5 L7 42.5 Q5.2 42.5 6 41 Z"
          fill="none"
          stroke="#5cff9a"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      </svg>
      {withWordmark && <span className={wordmarkClass}>AIDIT-CODE</span>}
    </span>
  );
}
