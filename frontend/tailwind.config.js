/** @type {import('tailwindcss').Config} */
// Green-phosphor CRT retro terminal design system.
// Token values are the verbatim SoT from docs/WIREFRAME.md §12.1/§12.2/§12.
// NO new colors may be introduced — use only the term-* tokens defined here.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Text / phosphor steps (§12.1) ──
        'term-fg-bright': '#9affc4',
        'term-glow': '#5cff9a',
        'term-fg': '#36c46f',
        'term-dim': '#1f9d56',
        'term-dim-2': '#1c8f4d',
        'term-dim-3': '#157a3f',
        'term-faint': '#176a3b',
        // ── Surfaces / stacking (§12.1) ──
        'term-bg': '#04130b',
        'term-panel': '#08220f',
        'term-sunken': '#04130b',
        'term-nav': '#061a0d',
        'term-modal': '#06160c',
        'term-chart': '#06140a',
        // ── Borders / dividers (§12.1) ──
        'term-line': '#114e2b',
        'term-border': '#1c7a42',
        'term-border-dim': '#185c33',
        'term-active': '#2bd46f',
        // ── Accent / semantic (§12.1) ──
        'term-amber': '#ffcf4a',
        'term-amber-line': '#6e5a1e',
        'term-amber-bg': 'rgba(60,48,10,0.4)',
        'term-red': '#ff7a7a',
        'term-red-line': '#5a2530',
        'term-red-bg': 'rgba(60,12,16,0.35)',
      },
      fontFamily: {
        // §12.2 system monospace stack — NO web font CDN.
        mono: [
          'JetBrains Mono',
          'D2Coding',
          'ui-monospace',
          'SFMono-Regular',
          'SF Mono',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'Noto Sans KR',
          'monospace',
        ],
      },
      backgroundImage: {
        // App background gradient (§12.1).
        'term-screen':
          'radial-gradient(125% 80% at 50% -5%, #0c2a18 0%, #04130b 58%, #020a06 100%)',
        // Signature CTA fill (§12.1) — send/post/start buttons, own bubble.
        'term-cta': 'linear-gradient(180deg, #155230 0%, #0c3a20 100%)',
      },
    },
  },
  plugins: [],
};
