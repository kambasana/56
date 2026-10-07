/**
 * App formatting helpers. `cn` is the shadcn/ui helper from ./utils (clsx + tailwind-merge),
 * re-exported here so existing `@/lib/cn` imports keep working.
 */
export { cn } from './utils';

const nf = new Intl.NumberFormat('en-US');
export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : nf.format(n);
}

const blastNf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * Blast-radius score (risk x weighted exposure, 3 decimals from the engine, often below 1):
 * two decimals like the Exposure matrix; "<0.01" for a positive score that would print as 0.00.
 */
export function fmtBlast(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n > 0 && n < 0.005) return '<0.01';
  return blastNf.format(n);
}

/** Compact UTC time like "2026-10-06 02:14 UTC". */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
