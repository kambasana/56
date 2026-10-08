/**
 * Back returns to the same scroll position (docs/UX.md §2, Baymard B1/B2). The window's scroll
 * offset is remembered per history entry (location.key) in sessionStorage and restored once the
 * page's data is on screen again.
 */
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

const PREFIX = 'br.scroll.';

function read(key: string): number | null {
  try {
    const v = sessionStorage.getItem(PREFIX + key);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function write(key: string, y: number): void {
  try {
    sessionStorage.setItem(PREFIX + key, String(Math.round(y)));
  } catch {
    /* storage unavailable: Back simply starts at the top */
  }
}

export function useScrollMemory(ready: boolean): void {
  const { key } = useLocation();
  const restored = useRef<string | null>(null);

  useEffect(() => {
    // A new entry (e.g. the peek sheet opened) starts where the page is now; an entry we came
    // Back to keeps its saved offset until it has been restored.
    if (read(key) === null) {
      write(key, window.scrollY);
      restored.current = key;
    }
    let frame = 0;
    const onScroll = () => {
      if (restored.current !== key) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => write(key, window.scrollY));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, [key]);

  useEffect(() => {
    if (!ready || restored.current === key) return;
    restored.current = key;
    const y = read(key);
    if (y !== null && y > 0 && typeof window.scrollTo === 'function') requestAnimationFrame(() => window.scrollTo(0, y));
  }, [ready, key]);
}
