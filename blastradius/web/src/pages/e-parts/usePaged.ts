import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import type { Page } from '@server/api-types';

export interface PagedState<T> {
  items: T[];
  total: number;
  error: Error | null;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Cursor-paged list (Page<T>): loads the first page, `loadMore` appends the next one. Reloads
 * from the start when `deps` change. Stale responses are dropped.
 */
export function usePaged<T>(loader: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>, deps: DependencyList): PagedState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const ctrl = useRef<AbortController | null>(null);

  const run = useCallback((from: string | undefined, append: boolean) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setLoading(true);
    setError(null);
    loaderRef.current(from, ac.signal).then(
      (p) => {
        if (ac.signal.aborted) return;
        setItems((prev) => (append ? [...prev, ...p.items] : p.items));
        setTotal(p.total);
        setCursor(p.nextCursor);
        setLoading(false);
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    run(undefined, false);
    return () => ctrl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const loadMore = useCallback(() => {
    if (cursor) run(cursor, true);
  }, [cursor, run]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { items, total, error, loading, hasMore: cursor !== null, loadMore, reload };
}
