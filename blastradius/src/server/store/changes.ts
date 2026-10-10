/**
 * Changes between two succeeded scans of one project, compared by versioned purl.
 * A version bump therefore shows as `resolved` (old purl) plus `new_finding` (new purl).
 * Dependencies added or removed without a finding are not reported: the stored result keeps
 * findings, not the full dependency list.
 */
import type { ChangeRow, ChangeType, ChangesResponse, ScanRef } from '../api-types.js';
import { CHANGE_TYPES } from '../api-types.js';
import type { RiskLevel } from '../../core/types.js';
import { all, get, parseJson, StoreError, type Store } from './db.js';
import { LEVEL_RANK, requireSucceededScan } from './findings.js';

export interface DiffRow {
  id: string;
  purl: string;
  name: string;
  version: string;
  score: number;
  level: RiskLevel;
  assets: number;
  prod_assets: number;
  factors: string;
  top_detail: string | null;
}

function rowsFor(s: Store, scanId: string): Map<string, DiffRow> {
  const rows = all<DiffRow>(s, 'SELECT id, purl, name, version, score, level, assets, prod_assets, factors, top_detail FROM finding WHERE scan_id = ?', scanId);
  return new Map(rows.map((r) => [r.purl, r] as const));
}

function twoLatest(s: Store, projectId: string): ScanRef[] {
  return all<{ id: string; project_id: string; status: ScanRef['status']; created_at: string; finished_at: string | null }>(
    s,
    `SELECT id, project_id, status, created_at, finished_at FROM scan WHERE project_id = ? AND status = 'succeeded'
     ORDER BY created_at DESC, rowid DESC LIMIT 2`,
    projectId,
  ).map((r) => ({ id: r.id, projectId: r.project_id, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at }));
}

function emptyChangeCounts(): Record<ChangeType, number> {
  return Object.fromEntries(CHANGE_TYPES.map((t) => [t, 0])) as Record<ChangeType, number>;
}

const fmt = (level: RiskLevel, score: number) => `${level} (${Math.round(score)})`;

/** Pure diff of two finding sets (from may be empty). Exported for tests. */
export function diffFindingRows(from: Map<string, DiffRow>, to: Map<string, DiffRow>): ChangeRow[] {
  const out: ChangeRow[] = [];
  for (const [purl, t] of to) {
    const f = from.get(purl);
    const tFactors = parseJson<string[]>(t.factors, []);
    const fFactors = f ? parseJson<string[]>(f.factors, []) : [];
    const added = [...new Set(tFactors.filter((x) => !fFactors.includes(x)))];
    const base = {
      purl,
      name: t.name,
      version: t.version,
      from: f ? { score: f.score, level: f.level } : null,
      to: { score: t.score, level: t.level },
      addedFactors: added,
      reach: { assets: t.assets, prodAssets: t.prod_assets },
      findingId: t.id,
    };
    let type: ChangeType | null = null;
    let detail = '';
    if (!f) {
      type = 'new_finding';
      detail = `New ${fmt(t.level, t.score)} finding${t.top_detail ? `: ${t.top_detail}` : ''}`;
    } else if (LEVEL_RANK[t.level] > LEVEL_RANK[f.level]) {
      type = 'risk_up';
      detail = `Risk rose from ${fmt(f.level, f.score)} to ${fmt(t.level, t.score)}${added.length ? `; new reasons: ${added.join(', ')}` : ''}`;
    } else if (LEVEL_RANK[t.level] < LEVEL_RANK[f.level]) {
      type = 'risk_down';
      detail = `Risk fell from ${fmt(f.level, f.score)} to ${fmt(t.level, t.score)}`;
    } else if (added.length > 0) {
      type = 'new_reason';
      detail = `New reasons at ${fmt(t.level, t.score)}: ${added.join(', ')}`;
    }
    if (type) out.push({ id: `${type}:${purl}`, type, detail, ...base });
  }
  for (const [purl, f] of from) {
    if (to.has(purl)) continue;
    out.push({
      id: `resolved:${purl}`,
      type: 'resolved',
      purl,
      name: f.name,
      version: f.version,
      from: { score: f.score, level: f.level },
      to: null,
      addedFactors: [],
      detail: `No longer a finding (was ${fmt(f.level, f.score)})`,
      reach: { assets: f.assets, prodAssets: f.prod_assets },
      findingId: null,
    });
  }
  const typeOrder = new Map(CHANGE_TYPES.map((t, i) => [t, i] as const));
  const score = (c: ChangeRow) => c.to?.score ?? c.from?.score ?? 0;
  return out.sort((a, b) => typeOrder.get(a.type)! - typeOrder.get(b.type)! || score(b) - score(a) || a.purl.localeCompare(b.purl));
}

/**
 * GET /api/changes. Defaults: `to` = latest succeeded scan, `from` = the one before it.
 * With only `to` given, `from` defaults to the succeeded scan just before `to`.
 */
export function diffScans(s: Store, orgId: string, projectId: string, opts: { from?: string; to?: string } = {}): ChangesResponse {
  const p = get<{ id: string }>(s, 'SELECT id FROM project WHERE id = ? AND org_id = ?', projectId, orgId);
  if (!p) throw new StoreError('not_found', 'Project not found');
  let toScan: ScanRef | null;
  let fromScan: ScanRef | null;
  if (opts.to !== undefined) {
    toScan = requireSucceededScan(s, orgId, projectId, opts.to);
    if (opts.from !== undefined) fromScan = requireSucceededScan(s, orgId, projectId, opts.from);
    else {
      const prev = get<{ id: string }>(
        s,
        `SELECT id FROM scan WHERE project_id = ? AND status = 'succeeded' AND id != ?
           AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM scan WHERE id = ?)))
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        projectId,
        toScan.id,
        toScan.createdAt,
        toScan.createdAt,
        toScan.id,
      );
      fromScan = prev ? requireSucceededScan(s, orgId, projectId, prev.id) : null;
    }
  } else {
    const latest = twoLatest(s, projectId);
    toScan = latest[0] ?? null;
    fromScan = opts.from !== undefined ? requireSucceededScan(s, orgId, projectId, opts.from) : (latest[1] ?? null);
  }
  const counts = emptyChangeCounts();
  if (!toScan) return { projectId, fromScan: null, toScan: null, items: [], counts };
  if (fromScan && fromScan.id === toScan.id) throw new StoreError('bad_request', 'from and to are the same scan', ['from']);
  const items = diffFindingRows(fromScan ? rowsFor(s, fromScan.id) : new Map(), rowsFor(s, toScan.id));
  for (const c of items) counts[c.type]++;
  return { projectId, fromScan, toScan, items, counts };
}
