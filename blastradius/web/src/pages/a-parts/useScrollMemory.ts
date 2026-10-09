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
  const { key, pathname } = useLocation();
  const restored = useRef<string | null>(null);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    // An entry we came Back to keeps its saved offset until it has been restored. A new entry of
    // the same mounted page (same path: the peek sheet opened, a filter changed) starts where the
    // page is now. A newly mounted page, or another path, starts at the top: the previous route's
    // offset belongs to that route.
    const samePage = lastPath.current === pathname;
    lastPath.current = pathname;
    if (read(key) === null) {
      if (!samePage) {
        write(key, 0);
        if (window.scrollY !== 0 && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
      } else {
        write(key, window.scrollY);
      }
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
  }, [key, pathname]);

  useEffect(() => {
    if (!ready || restored.current === key) return;
    restored.current = key;
    const y = read(key);
    if (y !== null && y > 0 && typeof window.scrollTo === 'function') requestAnimationFrame(() => window.scrollTo(0, y));
  }, [ready, key]);
}
