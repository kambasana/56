import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Page } from '@server/api-types';
import { usePaged } from './usePaged';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('usePaged', () => {
  it('clears the previous query rows as soon as deps change, and never shows them next to an error', async () => {
    const calls: { project: string; d: ReturnType<typeof deferred<Page<string>>> }[] = [];
    const { result, rerender } = renderHook(({ project }) => usePaged<string>(() => {
      const d = deferred<Page<string>>();
      calls.push({ project, d });
      return d.promise;
    }, [project]), { initialProps: { project: 'p1' } });
    await act(async () => calls[0]!.d.resolve({ items: ['p1-report'], total: 1, nextCursor: null }));
    expect(result.current.items).toEqual(['p1-report']);

    rerender({ project: 'p2' });
    expect(result.current.items).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.loading).toBe(true);
    await act(async () => calls[1]!.d.reject(new Error('boom')));
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    expect(result.current.items).toEqual([]);
  });

  it('keeps the rows on screen during reload() until the fresh page arrives', async () => {
    const pending: ReturnType<typeof deferred<Page<string>>>[] = [];
    const { result } = renderHook(() => usePaged<string>(() => {
      const d = deferred<Page<string>>();
      pending.push(d);
      return d.promise;
    }, []));
    await act(async () => pending[0]!.resolve({ items: ['a', 'b'], total: 2, nextCursor: 'c1' }));
    act(() => result.current.reload());
    expect(result.current.items).toEqual(['a', 'b']);
    expect(result.current.loading).toBe(true);
    await act(async () => pending[1]!.resolve({ items: ['a2'], total: 1, nextCursor: null }));
    expect(result.current.items).toEqual(['a2']);
    expect(result.current.hasMore).toBe(false);
  });
});
