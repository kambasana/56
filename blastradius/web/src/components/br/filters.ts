/**
 * Filter model for List pages (docs/UX.md §4). A filter is one URL param holding a
 * comma-separated value list: `?severity=critical,high&reach=production`.
 * Values within one filter combine with OR; different filters combine with AND.
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { readList, useUpdateParams } from './url-state';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  /** URL param name, e.g. "severity". Must not clash with SCOPE_PARAMS or the peek param. */
  key: string;
  /** Shown in the applied chip as "<label>: <option>", e.g. "Severity: Critical". */
  label: string;
  options: readonly FilterOption[];
  /** One-line explanation for jargon filters, shown behind an ⓘ (Baymard B9). */
  info?: string;
}

/** A promoted one-click chip: toggles one value of one filter. */
export interface QuickFilter {
  label: string;
  key: string;
  value: string;
}

export type FilterValues = Record<string, string[]>;

/** Read every defined filter from the URL. Unknown values are kept (links may be ahead of the UI). */
export function parseFilters(sp: URLSearchParams, defs: readonly FilterDef[]): FilterValues {
  const out: FilterValues = {};
  for (const d of defs) {
    const v = readList(sp, d.key);
    if (v.length) out[d.key] = v;
  }
  return out;
}

/**
 * Keep rows matching every active filter (AND) where each filter matches any of its values (OR).
 * `get` returns the row's value(s) for a filter key; a row with no value never matches an active
 * filter.
 */
export function applyFilters<T>(rows: readonly T[], values: FilterValues, get: (row: T, key: string) => string | readonly string[] | null | undefined): T[] {
  const active = Object.entries(values).filter(([, v]) => v.length > 0);
  if (active.length === 0) return [...rows];
  return rows.filter((row) =>
    active.every(([key, wanted]) => {
      const v = get(row, key);
      const have = v === null || v === undefined ? [] : typeof v === 'string' ? [v] : v;
      return have.some((h) => wanted.includes(h));
    }),
  );
}

/** Applied filters flattened to chips, in definition order. */
export function appliedList(values: FilterValues, defs: readonly FilterDef[]): { key: string; value: string; text: string }[] {
  const out: { key: string; value: string; text: string }[] = [];
  for (const d of defs) {
    for (const v of values[d.key] ?? []) {
      out.push({ key: d.key, value: v, text: `${d.label}: ${d.options.find((o) => o.value === v)?.label ?? v}` });
    }
  }
  return out;
}

export interface UseFilters {
  values: FilterValues;
  /** Number of applied values across all filters. */
  count: number;
  has: (key: string, value: string) => boolean;
  toggle: (key: string, value: string) => void;
  set: (key: string, values: readonly string[]) => void;
  remove: (key: string, value: string) => void;
  clearAll: () => void;
}

/** Filter state in the URL for `defs`. Every change pushes history (Back undoes it). */
export function useFilters(defs: readonly FilterDef[]): UseFilters {
  const [sp] = useSearchParams();
  const update = useUpdateParams();
  const values = useMemo(() => parseFilters(sp, defs), [sp, defs]);
  const current = (key: string) => values[key] ?? [];
  return {
    values,
    count: Object.values(values).reduce((n, v) => n + v.length, 0),
    has: (key, value) => current(key).includes(value),
    toggle: (key, value) => update({ [key]: current(key).includes(value) ? current(key).filter((v) => v !== value) : [...current(key), value] }),
    set: (key, vals) => update({ [key]: [...vals] }),
    remove: (key, value) => update({ [key]: current(key).filter((v) => v !== value) }),
    clearAll: () => update(Object.fromEntries(defs.map((d) => [d.key, null]))),
  };
}
