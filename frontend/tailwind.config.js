/** @type {import('tailwindcss').Config} */
// Green-phosphor CRT retro terminal design system.
// Token values are the verbatim SoT from docs/WIREFRAME.md §12.1/§12.2/§12.
// NO new colors may be introduced — use only the term-* tokens defined here.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Token NAMES preserved; VALUES re-mapped by ROLE to the parent Aidit
      // green-phosphor palette (see docs/IMPLEMENTATION_NOTES.md 2026-06-26).
      colors: {
        // ── Text / phosphor steps → Aidit bright/title/dim/faint ──
        'term-fg-bright': '#aaffc0', // Aidit bright
        'term-glow': '#7dffa0', // Aidit title
        'term-fg': '#4fbf72', // Aidit dim
        'term-dim': '#4fbf72', // Aidit dim
        'term-dim-2': '#2f8a52', // Aidit faint
        'term-dim-3': '#2f8a52', // Aidit faint
        'term-faint': '#2f8a52', // Aidit faint (placeholder/hint)
        // ── Surfaces / stacking → Aidit bg/card/input/screen/info ──
        'term-bg': '#020a05', // Aidit bg (app backdrop)
        'term-panel': '#04130b', // Aidit card
        'term-sunken': '#03100a', // Aidit input
        'term-nav': '#04130b', // Aidit screen (header/tabbar bg)
        'term-modal': '#06190e', // Aidit info
        'term-chart': '#06190e', // Aidit info (nearest)
        // ── Borders / dividers → Aidit border, active → Aidit cta ──
        'term-line': '#1d4a30', // Aidit border
        'term-border': '#1d4a30', // Aidit border
        'term-border-dim': '#1d4a30', // Aidit border (single border value)
        'term-active': '#3fa564', // Aidit cta
        // ── Accent / semantic → Aidit amber/danger ──
        'term-amber': '#ffcf6b', // Aidit amber
        'term-amber-line': '#6e5a1e', // kept (no direct Aidit equiv)
        'term-amber-bg': 'rgba(60,48,10,0.4)', // kept
        'term-red': '#ff6b6b', // Aidit danger
        'term-red-line': '#5a2530', // kept
        'term-red-bg': 'rgba(60,12,16,0.35)', // kept
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
        // App background gradient — Aidit CRT screen wash.
        'term-screen':
          'radial-gradient(120% 80% at 50% 0%, #06190e 0%, #04130b 55%, #020a05 100%)',
        // Signature CTA fill (§12.1) — send/post/start buttons, own bubble.
        'term-cta': 'linear-gradient(180deg, #155230 0%, #0c3a20 100%)',
      },
    },
  },
  plugins: [],
};
