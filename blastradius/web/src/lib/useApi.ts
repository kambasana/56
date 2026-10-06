import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Load data from the API and re-load when `deps` change. The loader gets an AbortSignal; a
 * stale response (deps changed while in flight) is dropped.
 *
 *   const { data, error, loading } = useApi((s) => api.findings({ project: id }, s), [id]);
 */
export function useApi<T>(loader: (signal: AbortSignal) => Promise<T>, deps: DependencyList): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    loaderRef.current(ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        setData(d);
        setLoading(false);
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
