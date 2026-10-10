/**
 * Regression: the user menu ignored the first click when Chromium briefly shrank the viewport
 * to 1x1 (full-page capture): useIsMobile flipped to true and back, the shadcn Sidebar swapped
 * its desktop tree for the mobile Sheet and back, and the open menu was remounted closed.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_SETTLE_MS, useIsMobile } from './use-mobile';

let matches = false;
const listeners = new Set<() => void>();
const original = window.matchMedia;
const originalWidth = window.innerWidth;

function setWidthMobile(mobile: boolean) {
  matches = mobile;
  Object.defineProperty(window, 'innerWidth', { value: mobile ? 1 : 1440, configurable: true });
  for (const l of listeners) l();
}

beforeEach(() => {
  vi.useFakeTimers();
  matches = false;
  listeners.clear();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = original;
  Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
});

describe('useIsMobile', () => {
  it('ignores a transient trip through the mobile breakpoint', () => {
    const seen: boolean[] = [];
    const { result } = renderHook(() => {
      const v = useIsMobile();
      seen.push(v);
      return v;
    });
    expect(result.current).toBe(false);
    act(() => setWidthMobile(true)); // 1x1 during a full-page capture
    act(() => vi.advanceTimersByTime(25));
    act(() => setWidthMobile(false)); // back to 1440 wide
    act(() => vi.advanceTimersByTime(MOBILE_SETTLE_MS * 2));
    expect(result.current).toBe(false);
    expect(seen).not.toContain(true);
  });

  it('applies a size that sticks', () => {
    const { result } = renderHook(() => useIsMobile());
    act(() => setWidthMobile(true));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(MOBILE_SETTLE_MS));
    expect(result.current).toBe(true);
  });

  it('reads the real value on the first render (no desktop-then-mobile remount)', () => {
    matches = true;
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    const seen: boolean[] = [];
    renderHook(() => {
      const v = useIsMobile();
      seen.push(v);
      return v;
    });
    expect(seen[0]).toBe(true);
    expect(seen).not.toContain(false);
  });
});
