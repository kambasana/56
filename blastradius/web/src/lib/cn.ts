/** Join class names, skipping falsy values. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

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
