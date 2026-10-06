/**
 * Pure helpers for the Exposure matrix: cell index, shading buckets, row sorting and CSV export.
 */
import type { Environment, ExposureCell, ExposureMatrixResponse, ExposureRow } from '@server/api-types';

export type ExposureSort = 'blast' | 'env' | 'name';

/** Sparse cells keyed by "row:col". */
export function cellIndex(cells: readonly ExposureCell[]): Map<string, ExposureCell> {
  const m = new Map<string, ExposureCell>();
  for (const c of cells) m.set(`${c.row}:${c.col}`, c);
  return m;
}

/** Same buckets as the canvas legend: none, ≤ .3, ≤ .6, > .6 (percent of the destructive tint). */
export function shade(exposure: number): 0 | 18 | 45 | 85 {
  if (!(exposure > 0)) return 0;
  if (exposure <= 0.3) return 18;
  if (exposure <= 0.6) return 45;
  return 85;
}

/** ".6", "1.0": compact cell text. */
export function cellText(exposure: number): string {
  if (!(exposure > 0)) return '';
  return exposure.toFixed(1).replace(/^0/, '');
}

const ENV_ORDER: Record<Environment, number> = { prod: 0, ci: 1, staging: 2, dev: 3 };

/** Row indexes (into `rows`) in display order. */
export function sortRows(rows: readonly ExposureRow[], sort: ExposureSort): number[] {
  const idx = rows.map((_, i) => i);
  const env = (r: ExposureRow) => (r.environment ? (ENV_ORDER[r.environment] ?? 5) : 6);
  idx.sort((a, b) => {
    const x = rows[a]!;
    const y = rows[b]!;
    if (sort === 'name') return x.label.localeCompare(y.label) || a - b;
    if (sort === 'env') return env(x) - env(y) || y.blastScore - x.blastScore || a - b;
    return y.blastScore - x.blastScore || x.label.localeCompare(y.label) || a - b;
  });
  return idx;
}

function csvField(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  // Neutralise spreadsheet formulas from untrusted names (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV with one line per row and one column per component (exposure values, empty when not reached). */
export function toCsv(m: ExposureMatrixResponse, order: readonly number[]): string {
  const idx = cellIndex(m.cells);
  const head = [m.axis === 'asset' ? 'asset' : 'project', 'environment', 'criticality', 'blast_score', ...m.columns.map((c) => `${c.name}@${c.version}`)];
  const lines = [head.map(csvField).join(',')];
  for (const ri of order) {
    const r = m.rows[ri]!;
    const vals = m.columns.map((_, ci) => {
      const c = idx.get(`${ri}:${ci}`);
      return c ? Number(c.exposure.toFixed(3)) : '';
    });
    lines.push([r.label, r.environment, r.criticality, Number(r.blastScore.toFixed(3)), ...vals].map((v) => csvField(v as string | number | null)).join(','));
  }
  return `${lines.join('\n')}\n`;
}
