import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useApi, type ApiState } from './useApi';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Each call to the loader for `id` gets the next pending promise; the test settles them. */
function setup() {
  const pending: { id: string; d: Deferred<string> }[] = [];
  const seen: ApiState<string>[] = [];
  const hook = renderHook(
    ({ id }: { id: string }) => {
      const s = useApi<string>(() => {
        const d = deferred<string>();
        pending.push({ id, d });
        return d.promise;
      }, [id]);
      seen.push(s);
      return s;
    },
    { initialProps: { id: 'f1' } },
  );
  return { hook, pending, seen };
}

describe('useApi', () => {
  it('clears the previous data as soon as deps change, while loading and after an error', async () => {
    const { hook, pending, seen } = setup();
    await act(async () => pending[0]!.d.resolve('data:f1'));
    expect(hook.result.current).toMatchObject({ data: 'data:f1', loading: false });

    const from = seen.length;
    hook.rerender({ id: 'f2' });
    // No render for f2 ever returns f1's data.
    expect(seen.slice(from).every((s) => s.data === null)).toBe(true);
    expect(hook.result.current).toMatchObject({ data: null, loading: true, error: null });

    await act(async () => pending[1]!.d.reject(new Error('boom')));
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.error?.message).toBe('boom');
    expect(hook.result.current.loading).toBe(false);
  });

  it('keeps the data on screen during reload()', async () => {
    const { hook, pending, seen } = setup();
    await act(async () => pending[0]!.d.resolve('v1'));
    const from = seen.length;
    act(() => hook.result.current.reload());
    expect(hook.result.current).toMatchObject({ data: 'v1', loading: true });
    expect(seen.slice(from).every((s) => s.data === 'v1')).toBe(true);
    await act(async () => pending[1]!.d.resolve('v2'));
    await waitFor(() => expect(hook.result.current).toMatchObject({ data: 'v2', loading: false }));
  });
});
