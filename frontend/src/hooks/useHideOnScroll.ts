// src/hooks/useHideOnScroll.ts
// Auto-hide-on-scroll for a window-scrolled top bar: returns `true` when the bar
// should slide up out of view (the reader is scrolling DOWN, past `revealAtTop`px)
// and `false` when it should be shown (scrolling UP, or near the very top). A
// small `threshold` swallows scroll jitter so the bar doesn't flicker mid-gesture.
// Window scroll only — pairs with a `position: sticky` bar (e.g. PageHeaderBar).
import { useEffect, useRef, useState } from 'react';

export function useHideOnScroll({
  threshold = 6,
  revealAtTop = 64,
}: { threshold?: number; revealAtTop?: number } = {}): boolean {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;
    const onScroll = () => {
      const y = Math.max(0, window.scrollY);
      // Always reveal within the top band (entry / scrolled back to the head).
      if (y <= revealAtTop) {
        setHidden(false);
        lastY.current = y;
        return;
      }
      const dY = y - lastY.current;
      // Below the jitter threshold: keep the current state AND the anchor, so a
      // slow drift accumulates until it crosses the threshold (no missed direction).
      if (Math.abs(dY) < threshold) return;
      setHidden(dY > 0); // scrolling down → hide; up → show
      lastY.current = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold, revealAtTop]);

  return hidden;
}
