/**
 * URL search-param helpers shared by ScopeBar, FilterChips and PeekSheet. Every view state lives
 * in the URL (docs/UX.md §2), and every change pushes a history entry unless told to replace,
 * so Back undoes it.
 */
import { useCallback } from 'react';
import { useSearchParams, type NavigateOptions } from 'react-router';

/** Comma-separated list param → values (empty and duplicate entries dropped). */
export function readList(sp: URLSearchParams, key: string): string[] {
  const raw = sp.get(key);
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

/** Set or delete a comma-separated list param on a copy of `sp`. */
export function writeList(sp: URLSearchParams, key: string, values: readonly string[]): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (values.length === 0) next.delete(key);
  else next.set(key, values.join(','));
  return next;
}

/**
 * Update some params, keeping the rest. `undefined`, null, '' or [] deletes a key.
 * Returns a function that pushes (default) or replaces the history entry.
 */
export function useUpdateParams() {
  const [, setSearchParams] = useSearchParams();
  return useCallback(
    (patch: Record<string, string | readonly string[] | null | undefined>, opts?: NavigateOptions) => {
      setSearchParams((prev) => {
        let next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (Array.isArray(v)) next = writeList(next, k, v);
          else if (v === undefined || v === null || v === '') next.delete(k);
          else next.set(k, v as string);
        }
        return next;
      }, opts);
    },
    [setSearchParams],
  );
}
