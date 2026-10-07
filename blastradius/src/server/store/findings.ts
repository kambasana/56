/**
 * Finding rows: one denormalised row per engine Finding per scan, for fast table queries.
 * The engine object itself is kept in `finding_json` (and in the scan's full result).
 * Review status lives in `finding_state`, keyed by (project, versioned purl), so it carries
 * over to later scans of the same project.
 */
import type {
  AssetPathView,
  FindingDetail,
  FindingRow,
  FindingStatus,
  ListFindingsResponse,
  ScanRef,
  StatusChange,
} from '../api-types.js';
import { FINDING_STATUSES } from '../api-types.js';
import type { Asset, AssetKind, Criticality, Ecosystem, Environment, Finding, Inventory, RiskLevel } from '../../core/types.js';
import { parsePurl } from '../../core/types.js';
import { describeReach } from '../../report/reach.js';
import { writeAudit } from './audit.js';
import { all, get, likeEscape, newId, nextCursorFor, nowIso, pageWindow, parseJson, placeholders, run, StoreError, tx, type Param, type Store } from './db.js';

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low'];
export const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

export function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === 'string' && (RISK_LEVELS as readonly string[]).includes(v);
}

export function isFindingStatus(v: unknown): v is FindingStatus {
  return typeof v === 'string' && (FINDING_STATUSES as readonly string[]).includes(v);
}

export function emptyCounts(): Record<RiskLevel, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

// ---------------------------------------------------------------------------
// Asset metadata (from the scan's inventory, with a fallback derived from the id)
// ---------------------------------------------------------------------------

export interface AssetMeta {
  id: string;
  kind: AssetKind;
  name: string;
  environment: Environment;
  criticality: Criticality;
}

export function assetMetaFromInventory(inv: Pick<Inventory, 'assets'> | undefined | null): AssetMeta[] {
  return (inv?.assets ?? []).map((a: Asset) => ({ id: a.id, kind: a.kind, name: a.name, environment: a.environment, criticality: a.criticality }));
}

/** Best effort when the inventory was not stored: "repo:my-app" -> repo "my-app". */
export function fallbackAssetMeta(id: string): AssetMeta {
  const i = id.indexOf(':');
  const prefix = i > 0 ? id.slice(0, i) : '';
  const kind: AssetKind = prefix === 'workflow' || prefix === 'image' ? prefix : 'repo';
  return { id, kind, name: i > 0 ? id.slice(i + 1) : id, environment: kind === 'workflow' ? 'ci' : 'dev', criticality: 3 };
}

export function assetLookup(assets: readonly AssetMeta[]): (id: string) => AssetMeta {
  const m = new Map(assets.map((a) => [a.id, a] as const));
  return (id) => m.get(id) ?? fallbackAssetMeta(id);
}

// ---------------------------------------------------------------------------
// Row derivation (pure)
// ---------------------------------------------------------------------------

export interface DerivedFinding {
  purl: string;
  name: string;
  version: string;
  ecosystem: Ecosystem;
  score: number;
  level: RiskLevel;
  blastScore: number;
  assets: number;
  prodAssets: number;
  reachText: string;
  paths: number;
  mainReason: { factor: string; detail: string } | null;
  factors: string[];
  behind: FindingRow['behind'];
  search: string;
}

function ecosystemFor(type: string): Ecosystem {
  if (type === 'npm') return 'npm';
  if (type === 'githubactions' || type === 'github') return 'githubactions';
  if (type === 'docker' || type === 'oci') return 'docker';
  return 'generic';
}

export function deriveFinding(f: Finding, assetOf: (id: string) => AssetMeta = fallbackAssetMeta): DerivedFinding {
  let name = f.purl;
  let version = '';
  let ecosystem: Ecosystem = 'generic';
  try {
    const p = parsePurl(f.purl);
    name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
    version = p.version ?? '';
    ecosystem = ecosystemFor(p.type);
  } catch {
    // keep the raw purl as the name
  }
  const exposures = f.blastRadius?.assets ?? [];
  const reasons = f.reasons ?? [];
  const chain = f.entityChain ?? [];
  const last = chain.length > 0 ? chain[chain.length - 1]! : null;
  const top = reasons[0];
  return {
    purl: f.purl,
    name,
    version,
    ecosystem,
    score: f.score,
    level: f.level,
    blastScore: f.blastRadius?.score ?? 0,
    assets: exposures.length,
    prodAssets: exposures.filter((a) => assetOf(a.assetId).environment === 'prod').length,
    paths: exposures.reduce((n, a) => n + (a.paths?.length ?? 0), 0),
    reachText: describeReach(f, (id) => assetOf(id)),
    mainReason: top ? { factor: top.factor, detail: top.detail } : null,
    factors: reasons.map((r) => r.factor),
    behind: last ? { entityId: last.entityId, relation: last.relation, confidence: last.confidence } : null,
    search: [name, f.purl, ...reasons.map((r) => r.detail)].join('\n').toLowerCase(),
  };
}

/**
 * Insert finding rows for a succeeded scan. Call inside the scan-completion transaction.
 * Duplicate purls in one result keep the first (highest-scored) entry.
 */
export function insertFindingRows(
  s: Store,
  scan: { id: string; projectId: string; orgId: string; createdAt: string },
  findings: readonly Finding[],
  assets: readonly AssetMeta[],
): number {
  const assetOf = assetLookup(assets);
  const seen = new Set<string>();
  let n = 0;
  findings.forEach((f, ord) => {
    if (seen.has(f.purl)) return;
    seen.add(f.purl);
    const d = deriveFinding(f, assetOf);
    const prior = get<{ first: string | null }>(s, 'SELECT min(first_seen_at) AS first FROM finding WHERE project_id = ? AND purl = ?', scan.projectId, f.purl)?.first;
    const firstSeen = prior && prior < scan.createdAt ? prior : scan.createdAt;
    run(
      s,
      `INSERT INTO finding (id, scan_id, project_id, org_id, ord, purl, name, version, ecosystem, score, level, level_rank,
         blast_score, assets, prod_assets, paths, reach_text, top_factor, top_detail, factors, behind, search, first_seen_at, finding_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('fnd'),
      scan.id,
      scan.projectId,
      scan.orgId,
      ord,
      d.purl,
      d.name,
      d.version,
      d.ecosystem,
      d.score,
      d.level,
      LEVEL_RANK[d.level] ?? 0,
      d.blastScore,
      d.assets,
      d.prodAssets,
      d.paths,
      d.reachText,
      d.mainReason?.factor ?? null,
      d.mainReason?.detail ?? null,
      JSON.stringify(d.factors),
      d.behind ? JSON.stringify(d.behind) : null,
      d.search,
      firstSeen,
      JSON.stringify(f),
    );
    n++;
  });
  return n;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface FindingSqlRow {
  id: string;
  scan_id: string;
  project_id: string;
  org_id: string;
  purl: string;
  name: string;
  version: string;
  ecosystem: Ecosystem;
  score: number;
  level: RiskLevel;
  blast_score: number;
  assets: number;
  prod_assets: number;
  paths: number;
  reach_text: string | null;
  top_factor: string | null;
  top_detail: string | null;
  factors: string;
  behind: string | null;
  first_seen_at: string;
  status: FindingStatus;
}

export const FINDING_COLUMNS = `f.id, f.scan_id, f.project_id, f.org_id, f.purl, f.name, f.version, f.ecosystem, f.score, f.level,
  f.blast_score, f.assets, f.prod_assets, f.paths, f.reach_text, f.top_factor, f.top_detail, f.factors, f.behind, f.first_seen_at,
  COALESCE(st.status, 'new') AS status`;

export const FINDING_FROM = `finding f LEFT JOIN finding_state st ON st.project_id = f.project_id AND st.purl = f.purl`;

/** Rows stored before reach_text existed: say what the counts can. */
function countsReach(assets: number, prod: number): string {
  if (assets === 0) return 'In the lockfile, but no dependency path from this project reaches it';
  const where = assets === 1 ? 'Used by 1 part of this project' : `Used by ${assets} parts of this project`;
  return prod > 0 ? `${where} (${prod === assets ? 'production' : `${prod} in production`})` : where;
}

export function toFindingRow(r: FindingSqlRow): FindingRow {
  return {
    id: r.id,
    scanId: r.scan_id,
    projectId: r.project_id,
    purl: r.purl,
    name: r.name,
    version: r.version,
    ecosystem: r.ecosystem,
    score: r.score,
    level: r.level,
    mainReason: r.top_factor !== null ? { factor: r.top_factor, detail: r.top_detail ?? '' } : null,
    factors: parseJson<string[]>(r.factors, []),
    reach: { assets: r.assets, prodAssets: r.prod_assets, paths: r.paths },
    reachText: r.reach_text ?? countsReach(r.assets, r.prod_assets),
    blastScore: r.blast_score,
    behind: parseJson<FindingRow['behind']>(r.behind, null),
    status: r.status,
    firstSeenAt: r.first_seen_at,
  };
}

export type FindingSort = 'score' | '-score' | 'name' | 'reach';

const SORT_SQL: Record<FindingSort, string> = {
  '-score': 'f.score DESC, f.blast_score DESC, f.ord',
  score: 'f.score ASC, f.ord',
  name: 'f.name COLLATE NOCASE ASC, f.version, f.ord',
  reach: 'f.assets DESC, f.prod_assets DESC, f.score DESC, f.ord',
};

export interface FindingQuery {
  projectId: string;
  /** Defaults to the project's latest succeeded scan. */
  scanId?: string;
  levels?: readonly RiskLevel[];
  statuses?: readonly FindingStatus[];
  /** Case-insensitive substring of name, purl or any reason detail. */
  q?: string;
  /** "-score" (default): highest first; "score": lowest first; "name"; "reach": most assets first. */
  sort?: FindingSort;
  limit?: number;
  offset?: number;
  cursor?: string;
}

/** Parse "critical,high" style filters; throws bad_request on unknown values. */
export function parseLevelList(v: string | undefined): RiskLevel[] | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const out = v.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = out.filter((x) => !isRiskLevel(x));
  if (bad.length > 0) throw new StoreError('bad_request', 'Unknown level', ['level']);
  return out as RiskLevel[];
}

export function parseStatusList(v: string | undefined): FindingStatus[] | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const out = v.split(',').map((x) => x.trim()).filter(Boolean);
  if (out.some((x) => !isFindingStatus(x))) throw new StoreError('bad_request', 'Unknown status', ['status']);
  return out as FindingStatus[];
}

interface ScanRefRow {
  id: string;
  project_id: string;
  status: ScanRef['status'];
  created_at: string;
  finished_at: string | null;
}

const toScanRef = (r: ScanRefRow): ScanRef => ({ id: r.id, projectId: r.project_id, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at });

/** Latest succeeded scan of a project (by creation time). */
export function latestSucceededScan(s: Store, projectId: string): ScanRef | null {
  const r = get<ScanRefRow>(
    s,
    `SELECT id, project_id, status, created_at, finished_at FROM scan
     WHERE project_id = ? AND status = 'succeeded' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    projectId,
  );
  return r ? toScanRef(r) : null;
}

/** A succeeded scan of this project in this org, or not_found. */
export function requireSucceededScan(s: Store, orgId: string, projectId: string, scanId: string): ScanRef {
  const r = get<ScanRefRow>(
    s,
    `SELECT id, project_id, status, created_at, finished_at FROM scan WHERE id = ? AND project_id = ? AND org_id = ?`,
    scanId,
    projectId,
    orgId,
  );
  if (!r) throw new StoreError('not_found', 'Scan not found');
  if (r.status !== 'succeeded') throw new StoreError('bad_request', 'Scan has not succeeded', ['scan']);
  return toScanRef(r);
}

function projectInOrg(s: Store, orgId: string, projectId: string): boolean {
  return get<{ id: string }>(s, 'SELECT id FROM project WHERE id = ? AND org_id = ?', projectId, orgId) !== undefined;
}

export function listFindings(s: Store, orgId: string, q: FindingQuery): ListFindingsResponse {
  if (!projectInOrg(s, orgId, q.projectId)) throw new StoreError('not_found', 'Project not found');
  const scan = q.scanId !== undefined ? requireSucceededScan(s, orgId, q.projectId, q.scanId) : latestSucceededScan(s, q.projectId);
  const { limit, offset } = pageWindow(q);
  if (!scan) return { items: [], total: 0, nextCursor: null, scan: null };
  const where: string[] = ['f.scan_id = ?'];
  const params: Param[] = [scan.id];
  if (q.levels && q.levels.length > 0) {
    where.push(`f.level IN (${placeholders(q.levels.length)})`);
    params.push(...q.levels);
  }
  if (q.statuses && q.statuses.length > 0) {
    where.push(`COALESCE(st.status, 'new') IN (${placeholders(q.statuses.length)})`);
    params.push(...q.statuses);
  }
  const text = q.q?.trim().toLowerCase();
  if (text) {
    where.push(`f.search LIKE ? ESCAPE '\\'`);
    params.push(`%${likeEscape(text.slice(0, 200))}%`);
  }
  const whereSql = where.join(' AND ');
  const total = get<{ n: number }>(s, `SELECT count(*) AS n FROM ${FINDING_FROM} WHERE ${whereSql}`, ...params)?.n ?? 0;
  const rows = all<FindingSqlRow>(
    s,
    `SELECT ${FINDING_COLUMNS} FROM ${FINDING_FROM} WHERE ${whereSql} ORDER BY ${SORT_SQL[q.sort ?? '-score'] ?? SORT_SQL['-score']} LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return { items: rows.map(toFindingRow), total, nextCursor: nextCursorFor(offset, rows.length, total), scan };
}

export function getFindingRow(s: Store, orgId: string, findingId: string): FindingRow | null {
  const r = get<FindingSqlRow>(s, `SELECT ${FINDING_COLUMNS} FROM ${FINDING_FROM} WHERE f.id = ? AND f.org_id = ?`, findingId, orgId);
  return r ? toFindingRow(r) : null;
}

/** The engine Finding for a row (org-scoped). */
export function getEngineFinding(s: Store, orgId: string, findingId: string): Finding | null {
  const r = get<{ finding_json: string }>(s, 'SELECT finding_json FROM finding WHERE id = ? AND org_id = ?', findingId, orgId);
  return r ? parseJson<Finding | null>(r.finding_json, null) : null;
}

export function scanAssets(s: Store, scanId: string): AssetMeta[] {
  const r = get<{ assets_json: string | null }>(s, 'SELECT assets_json FROM scan WHERE id = ?', scanId);
  return parseJson<AssetMeta[]>(r?.assets_json, []);
}

export function statusHistory(s: Store, projectId: string, purl: string): StatusChange[] {
  return all<{ at: string; by_user: string; from_status: FindingStatus; to_status: FindingStatus; note: string | null }>(
    s,
    'SELECT at, by_user, from_status, to_status, note FROM finding_status_history WHERE project_id = ? AND purl = ? ORDER BY seq DESC',
    projectId,
    purl,
  ).map((r) => ({ at: r.at, by: r.by_user, from: r.from_status, to: r.to_status, note: r.note }));
}

/** GET /api/findings/:id */
export function getFindingDetail(s: Store, orgId: string, findingId: string): FindingDetail | null {
  const row = getFindingRow(s, orgId, findingId);
  const finding = row ? getEngineFinding(s, orgId, findingId) : null;
  if (!row || !finding) return null;
  const assetOf = assetLookup(scanAssets(s, row.scanId));
  const assets: AssetPathView[] = (finding.blastRadius?.assets ?? []).map((a) => {
    const m = assetOf(a.assetId);
    return {
      assetId: a.assetId,
      assetName: m.name,
      kind: m.kind,
      environment: m.environment,
      criticality: m.criticality,
      exposure: a.exposure,
      paths: a.paths,
    };
  });
  const current = get<{ created_at: string }>(s, 'SELECT created_at FROM scan WHERE id = ?', row.scanId)!;
  const history = all<{ scan_id: string; at: string; score: number; level: RiskLevel }>(
    s,
    `SELECT f.scan_id, sc.created_at AS at, f.score, f.level FROM finding f JOIN scan sc ON sc.id = f.scan_id
     WHERE f.project_id = ? AND f.purl = ? AND f.scan_id != ? AND sc.created_at <= ?
     ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT 50`,
    row.projectId,
    row.purl,
    row.scanId,
    current.created_at,
  ).map((h) => ({ scanId: h.scan_id, at: h.at, score: h.score, level: h.level }));
  return {
    ...row,
    reasons: finding.reasons ?? [],
    assets,
    entityChain: finding.entityChain ?? [],
    finding,
    history,
    statusHistory: statusHistory(s, row.projectId, row.purl),
  };
}

/**
 * PATCH /api/findings/:id. The server checks review / accept_risk first.
 * The status applies to this purl in this project (and so to later scans too).
 */
export function updateFindingStatus(
  s: Store,
  orgId: string,
  findingId: string,
  input: { status: FindingStatus; note?: string | null },
  actor: string,
): FindingRow {
  if (!isFindingStatus(input.status)) throw new StoreError('bad_request', 'Unknown status', ['status']);
  const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null;
  return tx(s, () => {
    const row = getFindingRow(s, orgId, findingId);
    if (!row) throw new StoreError('not_found', 'Finding not found');
    if (row.status === input.status && note === null) return row;
    const at = nowIso(s);
    run(
      s,
      `INSERT INTO finding_state (project_id, purl, status, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, purl) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      row.projectId,
      row.purl,
      input.status,
      at,
      actor,
    );
    run(
      s,
      'INSERT INTO finding_status_history (project_id, purl, at, by_user, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.projectId,
      row.purl,
      at,
      actor,
      row.status,
      input.status,
      note,
    );
    writeAudit(s, {
      orgId,
      actor,
      action: 'finding.status',
      target: findingId,
      detail: { projectId: row.projectId, purl: row.purl, from: row.status, to: input.status, note },
    });
    return getFindingRow(s, orgId, findingId)!;
  });
}

/** Level counts and "new" count for one scan. */
export function scanFindingStats(s: Store, scanId: string): { counts: Record<RiskLevel, number>; toReview: number } {
  const counts = emptyCounts();
  for (const r of all<{ level: RiskLevel; n: number }>(s, 'SELECT level, count(*) AS n FROM finding WHERE scan_id = ? GROUP BY level', scanId)) {
    if (isRiskLevel(r.level)) counts[r.level] = r.n;
  }
  const toReview =
    get<{ n: number }>(s, `SELECT count(*) AS n FROM ${FINDING_FROM} WHERE f.scan_id = ? AND COALESCE(st.status, 'new') = 'new'`, scanId)?.n ?? 0;
  return { counts, toReview };
}
