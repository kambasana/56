import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { useScrollMemory } from './useScrollMemory';

let navigate: NavigateFunction = () => {};
let currentKey = '';

function Page({ name }: { name: string }) {
  useScrollMemory(true);
  navigate = useNavigate();
  currentKey = useLocation().key;
  return <div>{name}</div>;
}

const frame = () => act(() => new Promise<void>((r) => setTimeout(r, 40)));
const saved = (key: string) => sessionStorage.getItem(`br.scroll.${key}`);

function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
  window.dispatchEvent(new Event('scroll'));
}

describe('useScrollMemory', () => {
  let spy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sessionStorage.clear();
    scrollTo(0);
    spy = vi.fn((x: number, y: number) => scrollTo(typeof x === 'number' ? y : 0));
    window.scrollTo = spy as unknown as typeof window.scrollTo;
  });
  afterEach(() => sessionStorage.clear());

  function app() {
    return render(
      <MemoryRouter initialEntries={['/a']}>
        <Routes>
          <Route path="/a" element={<Page name="a" />} />
          <Route path="/b" element={<Page name="b" />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('starts another page (even the same component on another path) at the top, not at the previous route offset', async () => {
    app();
    await frame();
    scrollTo(800);
    await frame();
    const aKey = currentKey;
    expect(saved(aKey)).toBe('800');
    await act(async () => navigate('/b'));
    await frame();
    expect(currentKey).not.toBe(aKey);
    expect(saved(currentKey)).toBe('0');
    expect(spy).toHaveBeenCalledWith(0, 0);
    expect(window.scrollY).toBe(0);
  });

  it('keeps the offset for a new entry on the same mounted page (peek sheet), and restores it on Back', async () => {
    app();
    await frame();
    scrollTo(600);
    await frame();
    const listKey = currentKey;
    await act(async () => navigate('/a?peek=1'));
    await frame();
    expect(currentKey).not.toBe(listKey);
    expect(saved(currentKey)).toBe('600');
    expect(spy).not.toHaveBeenCalledWith(0, 0);
    scrollTo(0);
    await act(async () => navigate(-1));
    await frame();
    expect(currentKey).toBe(listKey);
    expect(spy).toHaveBeenLastCalledWith(0, 600);
  });
});
