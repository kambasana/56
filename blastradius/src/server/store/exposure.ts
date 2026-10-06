/**
 * Exposure matrix from the latest succeeded scan(s).
 *   - With a project: rows are that project's assets, columns its components (findings).
 *   - Org-wide: rows are projects, columns are components (grouped by purl across projects).
 */
import type { ExposureCell, ExposureColumn, ExposureMatrixResponse, ExposureRow } from '../api-types.js';
import type { Finding, RiskLevel } from '../../core/types.js';
import { all, parseJson, placeholders, StoreError, type Store } from './db.js';
import { assetLookup, isRiskLevel, LEVEL_RANK, latestSucceededScan, scanAssets } from './findings.js';
import { getProject, listProjects } from './projects.js';

export interface ExposureOptions {
  projectId?: string;
  /** Default "medium". */
  minLevel?: RiskLevel;
  /** Max columns, default 50 (max 200). */
  limit?: number;
  /** Max rows, default 200. */
  rowLimit?: number;
  /** Org-wide only: projects the caller may see (null = all). */
  projectIds?: readonly string[] | null;
}

interface ColRow {
  id: string;
  project_id: string;
  purl: string;
  name: string;
  version: string;
  level: RiskLevel;
  score: number;
  finding_json: string;
}

function columnRows(s: Store, scanIds: readonly string[], minRank: number): ColRow[] {
  if (scanIds.length === 0) return [];
  return all<ColRow>(
    s,
    `SELECT id, project_id, purl, name, version, level, score, finding_json FROM finding
     WHERE scan_id IN (${placeholders(scanIds.length)}) AND level_rank >= ?
     ORDER BY score DESC, blast_score DESC, ord`,
    ...scanIds,
    minRank,
  );
}

export function exposureMatrix(s: Store, orgId: string, opts: ExposureOptions = {}): ExposureMatrixResponse {
  const minLevel = opts.minLevel ?? 'medium';
  if (!isRiskLevel(minLevel)) throw new StoreError('bad_request', 'Unknown level', ['minLevel']);
  const colLimit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
  const rowLimit = Math.min(1000, Math.max(1, Math.floor(opts.rowLimit ?? 200)));
  const minRank = LEVEL_RANK[minLevel];

  if (opts.projectId !== undefined) {
    const project = getProject(s, orgId, opts.projectId);
    if (!project) throw new StoreError('not_found', 'Project not found');
    const scan = latestSucceededScan(s, project.id);
    if (!scan) return { axis: 'asset', rows: [], columns: [], cells: [], truncated: false };
    const candidates = columnRows(s, [scan.id], minRank);
    const picked = candidates.slice(0, colLimit);
    let truncated = candidates.length > picked.length;
    const assetOf = assetLookup(scanAssets(s, scan.id));
    const rowAgg = new Map<string, { blast: number; cells: { col: number; exposure: number; pathCount: number }[] }>();
    const columns: ExposureColumn[] = picked.map((c, col) => {
      const f = parseJson<Finding | null>(c.finding_json, null);
      const exposures = f?.blastRadius?.assets ?? [];
      for (const a of exposures) {
        const r = rowAgg.get(a.assetId) ?? { blast: 0, cells: [] };
        r.blast += a.exposure * c.score;
        r.cells.push({ col, exposure: a.exposure, pathCount: a.paths?.length ?? 0 });
        rowAgg.set(a.assetId, r);
      }
      return { findingId: c.id, projectId: c.project_id, purl: c.purl, name: c.name, version: c.version, level: c.level, score: c.score, reach: exposures.length };
    });
    let rowKeys = [...rowAgg.entries()].sort((a, b) => b[1].blast - a[1].blast || a[0].localeCompare(b[0]));
    if (rowKeys.length > rowLimit) {
      rowKeys = rowKeys.slice(0, rowLimit);
      truncated = true;
    }
    const rows: ExposureRow[] = [];
    const cells: ExposureCell[] = [];
    rowKeys.forEach(([assetId, agg], row) => {
      const m = assetOf(assetId);
      rows.push({ key: assetId, label: m.name, projectId: project.id, environment: m.environment, criticality: m.criticality, blastScore: round(agg.blast) });
      for (const c of agg.cells) cells.push({ row, col: c.col, exposure: c.exposure, pathCount: c.pathCount });
    });
    return { axis: 'asset', rows, columns, cells: sortCells(cells), truncated };
  }

  // Org-wide: rows = projects, columns = purls across projects.
  const projects = listProjects(s, orgId, opts.projectIds ?? null);
  const latest = new Map<string, string>();
  for (const p of projects) {
    const sc = latestSucceededScan(s, p.id);
    if (sc) latest.set(p.id, sc.id);
  }
  const rowsAll = columnRows(s, [...latest.values()], minRank);
  const byPurl = new Map<string, { best: ColRow; perProject: Map<string, { exposure: number; pathCount: number }> }>();
  for (const c of rowsAll) {
    const f = parseJson<Finding | null>(c.finding_json, null);
    const exposures = f?.blastRadius?.assets ?? [];
    const entry = byPurl.get(c.purl) ?? { best: c, perProject: new Map() };
    if (c.score > entry.best.score) entry.best = c;
    const cell = entry.perProject.get(c.project_id) ?? { exposure: 0, pathCount: 0 };
    for (const a of exposures) {
      cell.exposure = Math.max(cell.exposure, a.exposure);
      cell.pathCount += a.paths?.length ?? 0;
    }
    entry.perProject.set(c.project_id, cell);
    byPurl.set(c.purl, entry);
  }
  const ordered = [...byPurl.values()].sort((a, b) => b.best.score - a.best.score || b.perProject.size - a.perProject.size || a.best.purl.localeCompare(b.best.purl));
  const picked = ordered.slice(0, colLimit);
  let truncated = ordered.length > picked.length;
  const columns: ExposureColumn[] = picked.map((e) => ({
    findingId: e.best.id,
    projectId: e.best.project_id,
    purl: e.best.purl,
    name: e.best.name,
    version: e.best.version,
    level: e.best.level,
    score: e.best.score,
    reach: e.perProject.size,
  }));
  const blast = new Map<string, number>();
  picked.forEach((e) => {
    for (const [pid, cell] of e.perProject) blast.set(pid, (blast.get(pid) ?? 0) + cell.exposure * e.best.score);
  });
  let rowProjects = projects.filter((p) => latest.has(p.id)).sort((a, b) => (blast.get(b.id) ?? 0) - (blast.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  if (rowProjects.length > rowLimit) {
    rowProjects = rowProjects.slice(0, rowLimit);
    truncated = true;
  }
  const rowIndex = new Map(rowProjects.map((p, i) => [p.id, i] as const));
  const rows: ExposureRow[] = rowProjects.map((p) => ({
    key: p.id,
    label: p.name,
    projectId: p.id,
    environment: null,
    criticality: null,
    blastScore: round(blast.get(p.id) ?? 0),
  }));
  const cells: ExposureCell[] = [];
  picked.forEach((e, col) => {
    for (const [pid, cell] of e.perProject) {
      const row = rowIndex.get(pid);
      if (row === undefined) continue;
      cells.push({ row, col, exposure: cell.exposure, pathCount: cell.pathCount });
    }
  });
  return { axis: 'project', rows, columns, cells: sortCells(cells), truncated };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function sortCells(cells: ExposureCell[]): ExposureCell[] {
  return cells.sort((a, b) => a.row - b.row || a.col - b.col);
}
