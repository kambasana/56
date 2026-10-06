/**
 * App formatting helpers. `cn` is the shadcn/ui helper from ./utils (clsx + tailwind-merge),
 * re-exported here so existing `@/lib/cn` imports keep working.
 */
export { cn } from './utils';

const nf = new Intl.NumberFormat('en-US');
export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : nf.format(n);
}

/** Compact UTC time like "2026-10-06 02:14 UTC". */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
