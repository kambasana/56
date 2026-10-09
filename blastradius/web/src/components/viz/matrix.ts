/**
 * Exposure matrix model (design system: ExposureMatrix): projects × packages from the org-wide
 * GET /api/exposure. Rows production first, then by how many columns they hold; columns by how
 * many projects they reach. Above 40 columns only the top 40 are drawn unless asked.
 */
import type { ExposureMatrixResponse, RiskLevel } from '@server/api-types';

export const COLUMN_CAP = 40;

export interface MatrixColumn {
  index: number;
  purl: string;
  name: string;
  version: string;
  level: RiskLevel;
  projects: number;
}

export interface MatrixCell {
  level: RiskLevel;
  findingId: string | null;
  production: boolean;
}

export interface MatrixRow {
  projectId: string;
  name: string;
  production: boolean;
  /** Cells by column index (absent = not present). */
  cells: Map<number, MatrixCell>;
}

export interface MatrixModel {
  rows: MatrixRow[];
  columns: MatrixColumn[];
  /** Columns left out by the cap. */
  hiddenColumns: number;
  totalColumns: number;
}

export function buildMatrix(m: ExposureMatrixResponse, opts: { projects?: readonly string[]; env?: 'all' | 'prod' | 'dev'; showAll?: boolean } = {}): MatrixModel {
  const rowsAll: MatrixRow[] = m.rows.map((r) => ({ projectId: r.projectId, name: r.label, production: !!r.production, cells: new Map() }));
  for (const c of m.cells) {
    const col = m.columns[c.col];
    const row = rowsAll[c.row];
    if (!col || !row) continue;
    row.cells.set(c.col, { level: c.level ?? col.level, findingId: c.findingId ?? (col.projectId === row.projectId ? col.findingId : null), production: !!c.production });
  }
  let rows = rowsAll;
  if (opts.projects && opts.projects.length) rows = rows.filter((r) => opts.projects!.includes(r.projectId));
  if (opts.env === 'prod') rows = rows.filter((r) => r.production);
  if (opts.env === 'dev') rows = rows.filter((r) => !r.production);
  const counts = new Map<number, number>();
  for (const r of rows) for (const i of r.cells.keys()) counts.set(i, (counts.get(i) ?? 0) + 1);
  const rank: Record<RiskLevel, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  const allCols: MatrixColumn[] = m.columns
    .map((c, index) => ({ index, purl: c.purl, name: c.name, version: c.version, level: c.level, projects: counts.get(index) ?? 0 }))
    .filter((c) => c.projects > 0)
    .sort((a, b) => b.projects - a.projects || rank[b.level] - rank[a.level] || a.name.localeCompare(b.name));
  const columns = opts.showAll ? allCols : allCols.slice(0, COLUMN_CAP);
  const shown = new Set(columns.map((c) => c.index));
  const filled = (r: MatrixRow) => [...r.cells.keys()].filter((i) => shown.has(i)).length;
  rows = [...rows].sort((a, b) => Number(b.production) - Number(a.production) || filled(b) - filled(a) || a.name.localeCompare(b.name));
  return { rows, columns, hiddenColumns: allCols.length - columns.length, totalColumns: allCols.length };
}

const LETTER: Record<RiskLevel, string> = { critical: 'C', high: 'H', medium: 'M', low: 'L' };
export const levelLetter = (l: RiskLevel) => LETTER[l];

function csvCell(v: string): string {
  // Neutralise spreadsheet formulas from untrusted names, then quote.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Every present cell as one CSV row (the Table view, as a file). */
export function matrixCsv(model: MatrixModel, origin = ''): string {
  const lines = ['project,environment,package,version,severity,finding'];
  for (const r of model.rows) {
    for (const c of model.columns) {
      const cell = r.cells.get(c.index);
      if (!cell) continue;
      const url = cell.findingId ? `${origin}/projects/${encodeURIComponent(r.projectId)}/findings/${encodeURIComponent(cell.findingId)}` : '';
      lines.push([r.name, r.production ? 'Production' : 'Dev and test', c.name, c.version, cell.level, url].map(csvCell).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}
