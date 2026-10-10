/**
 * The project's scan list for the Scans screen.
 *
 * - The first page loads newest first; "Load older scans" appends the next cursor page.
 * - `refresh()` asks only for what changed: GET /api/projects/:id/scans?updatedSince=<last
 *   serverTime>, following its cursor, and merges the rows by id. Older pages already loaded
 *   stay in place (a full reload would drop them).
 * - Against a server that sends no `serverTime`, refresh re-reads the first page and merges it
 *   the same way, so loaded pages are still kept.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListScansQuery, ListScansResponse, Scan } from '@server/api-types';
import { api } from '@/api';

export const SCAN_PAGE_SIZE = 200;
/** Cap on delta pages followed in one refresh (200 rows each). */
const MAX_DELTA_PAGES = 10;

type Fetch = (projectId: string, q: ListScansQuery, signal: AbortSignal) => Promise<ListScansResponse>;

const defaultFetch: Fetch = (projectId, q, signal) => api.scans(projectId, q, signal);

/** Merge `incoming` into `prev` by id: known rows are replaced in place, new rows go first. */
export function mergeScans(prev: readonly Scan[], incoming: readonly Scan[]): { items: Scan[]; added: number } {
  if (incoming.length === 0) return { items: prev as Scan[], added: 0 };
  const byId = new Map(incoming.map((s) => [s.id, s]));
  const known = new Set(prev.map((s) => s.id));
  const fresh = incoming.filter((s) => !known.has(s.id));
  const items = [...fresh, ...prev.map((s) => byId.get(s.id) ?? s)];
  return { items, added: fresh.length };
}

export interface ScanListState {
  items: Scan[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  /** Fetch changes since the last read and merge them (keeps loaded pages). */
  refresh: () => Promise<void>;
  /** Start over from the first page. */
  reload: () => void;
}

export function useScanList(projectId: string, fetchPage: Fetch = defaultFetch): ScanListState {
  const [items, setItems] = useState<Scan[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const serverTime = useRef<string | null>(null);
  const itemsRef = useRef<Scan[]>([]);
  itemsRef.current = items;
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  // One controller for the whole list: a project change or reload aborts every request in flight.
  const ctrl = useRef<AbortController>(new AbortController());
  const refreshing = useRef(false);

  useEffect(() => {
    const ac = new AbortController();
    ctrl.current = ac;
    serverTime.current = null;
    setItems([]);
    setTotal(0);
    setCursor(null);
    setLoading(true);
    setError(null);
    fetchRef.current(projectId, { limit: SCAN_PAGE_SIZE }, ac.signal).then(
      (p) => {
        if (ac.signal.aborted) return;
        serverTime.current = p.serverTime ?? null;
        setItems(p.items);
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
    return () => ac.abort();
  }, [projectId, tick]);

  const loadMore = useCallback(() => {
    if (!cursor) return;
    const ac = ctrl.current;
    setLoadingMore(true);
    fetchRef.current(projectId, { limit: SCAN_PAGE_SIZE, cursor }, ac.signal).then(
      (p) => {
        if (ac.signal.aborted) return;
        // Appended rows can overlap the first page if scans arrived meanwhile; merge by id.
        setItems((prev) => {
          const seen = new Set(prev.map((s) => s.id));
          return [...prev, ...p.items.filter((s) => !seen.has(s.id))];
        });
        setCursor(p.nextCursor);
        setLoadingMore(false);
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoadingMore(false);
      },
    );
  }, [cursor, projectId]);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const ac = ctrl.current;
    try {
      const since = serverTime.current;
      const incoming: Scan[] = [];
      let next: string | undefined;
      let latest: string | null = null;
      for (let i = 0; i < MAX_DELTA_PAGES; i++) {
        const q: ListScansQuery = { limit: SCAN_PAGE_SIZE, ...(since ? { updatedSince: since } : {}), ...(next ? { cursor: next } : {}) };
        const p = await fetchRef.current(projectId, q, ac.signal);
        if (ac.signal.aborted) return;
        latest ??= p.serverTime ?? null;
        incoming.push(...p.items);
        // Without updatedSince only the first page is re-read.
        if (!since || !p.nextCursor) break;
        next = p.nextCursor;
      }
      if (ac.signal.aborted) return;
      if (latest) serverTime.current = latest;
      const { items: merged, added } = mergeScans(itemsRef.current, incoming);
      itemsRef.current = merged;
      setItems(merged);
      if (added) setTotal((t) => t + added);
      setError(null);
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      refreshing.current = false;
    }
  }, [projectId]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { items, total, loading, loadingMore, error, hasMore: cursor !== null, loadMore, refresh, reload };
}
