/**
 * Finding rows: one denormalised row per engine Finding per scan, for fast table queries.
 * The engine object itself is kept in `finding_json` (and in the scan's full result).
 * Review status lives in `finding_state`, keyed by (project, versioned purl), so it carries
 * over to later scans of the same project.
 */
import type {
  AssetPathView,
  FindingDetail,
  IntroducedBy,
  FindingRow,
  FindingStatus,
  ListFindingsResponse,
  ScanRef,
  StatusChange,
} from '../api-types.js';
import { FINDING_STATUSES } from '../api-types.js';
import type { Asset, AssetKind, Criticality, Ecosystem, EntityChainEntry, Environment, Finding, Inventory, RiskLevel } from '../../core/types.js';
import { describeReach } from '../../report/reach.js';
import { purlName, purlNameVersion } from '../reach.js';
import { writeAudit } from './audit.js';
import { all, get, likeEscape, newId, nextCursorFor, nowIso, pageWindow, parseJson, placeholders, run, StoreError, tx, type Param, type Store } from './db.js';

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low'];
export const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The most severe of `levels` (nulls ignored), or null when there is none. */
export function worstLevel(levels: Iterable<RiskLevel | null | undefined>): RiskLevel | null {
  let best: RiskLevel | null = null;
  for (const l of levels) if (l && (!best || LEVEL_RANK[l] > LEVEL_RANK[best])) best = l;
  return best;
}

/** "3 projects", "1 project". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

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


const OWNER_RANK: Record<string, number> = { owns: 0, funds: 1, member_of: 2, publishes: 3, maintains: 4, linked_to: 5 };

/** The single most telling "who's behind it" entry for the table column. */
function pickOwner(behind: readonly EntityChainEntry[]): EntityChainEntry | null {
  let best: EntityChainEntry | null = null;
  for (const e of behind) if (!best || (OWNER_RANK[e.relation] ?? 9) < (OWNER_RANK[best.relation] ?? 9)) best = e;
  return best;
}

function ecosystemFor(type: string): Ecosystem {
  if (type === 'npm') return 'npm';
  if (type === 'githubactions' || type === 'github') return 'githubactions';
  if (type === 'docker' || type === 'oci') return 'docker';
  return 'generic';
}

export function deriveFinding(f: Finding, assetOf: (id: string) => AssetMeta = fallbackAssetMeta): DerivedFinding {
  // An unparsable purl keeps the raw purl as the name.
  const nv = purlNameVersion(f.purl);
  const name = nv?.name ?? f.purl;
  const version = nv?.version ?? '';
  const ecosystem: Ecosystem = nv ? ecosystemFor(nv.type) : 'generic';
  const exposures = f.blastRadius?.assets ?? [];
  const reasons = f.reasons ?? [];
  const chain = f.entityChain ?? [];
  // An incident chain says most; otherwise name who is behind the package (repo owner first).
  const last = chain.length > 0 ? chain[chain.length - 1]! : pickOwner(f.behind ?? []);
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
  owner_id: string | null;
  owner_name: string | null;
  risk_expires_at: string | null;
}

/**
 * The status a finding has now, as SQL over `st` (finding_state). A risk acceptance whose expiry
 * has passed (by the store clock) reads as 'reviewed': it is open again and needs a new decision.
 * Every read (lists, counts, Overview tiles, filters, the finding itself) goes through this, so
 * they all agree; the stored row keeps its history until someone triages it again.
 */
export function findingStatusSql(s: Store): string {
  // nowIso is Date#toISOString output: digits, '-', ':', '.', 'T' and 'Z' only, safe to inline.
  const now = nowIso(s);
  return `(CASE WHEN st.status = 'accepted_risk' AND st.risk_expires_at IS NOT NULL AND st.risk_expires_at <= '${now}' THEN 'reviewed' ELSE COALESCE(st.status, 'new') END)`;
}

export function findingColumns(s: Store): string {
  return `f.id, f.scan_id, f.project_id, f.org_id, f.purl, f.name, f.version, f.ecosystem, f.score, f.level,
  f.blast_score, f.assets, f.prod_assets, f.paths, f.reach_text, f.top_factor, f.top_detail, f.factors, f.behind, f.first_seen_at,
  ${findingStatusSql(s)} AS status, st.owner_id, (SELECT u.name FROM app_user u WHERE u.id = st.owner_id) AS owner_name,
  st.risk_expires_at`;
}

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
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name ?? 'Former member' } : null,
    riskExpiresAt: r.status === 'accepted_risk' ? r.risk_expires_at : null,
  };
}

/** Who brings the package in, from the finding's dependency paths ([assetId, purl, ..., purl]). */
export function introducedByOf(f: Pick<Finding, 'blastRadius'> | null | undefined): IntroducedBy {
  const paths = (f?.blastRadius?.assets ?? []).flatMap((a) => a.paths ?? []);
  const direct = paths.some((p) => p.length === 2);
  const via: string[] = [];
  for (const p of [...paths].filter((x) => x.length > 2).sort((a, b) => a.length - b.length)) {
    const n = purlName(p[1]!) ?? p[1]!;
    if (!via.includes(n)) via.push(n);
    if (via.length >= 5) break;
  }
  return { direct, via };
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
    where.push(`${findingStatusSql(s)} IN (${placeholders(q.statuses.length)})`);
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
    `SELECT ${findingColumns(s)} FROM ${FINDING_FROM} WHERE ${whereSql} ORDER BY ${SORT_SQL[q.sort ?? '-score'] ?? SORT_SQL['-score']} LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return { items: rows.map(toFindingRow), total, nextCursor: nextCursorFor(offset, rows.length, total), scan };
}

/** The finding for `purl` in one scan (id and level), or null. The one (scan, purl) lookup. */
export function findingFor(s: Store, scanId: string | null | undefined, purl: string): { id: string; level: RiskLevel } | null {
  if (!scanId) return null;
  return get<{ id: string; level: RiskLevel }>(s, 'SELECT id, level FROM finding WHERE scan_id = ? AND purl = ?', scanId, purl) ?? null;
}

export function getFindingRow(s: Store, orgId: string, findingId: string): FindingRow | null {
  const r = get<FindingSqlRow>(s, `SELECT ${findingColumns(s)} FROM ${FINDING_FROM} WHERE f.id = ? AND f.org_id = ?`, findingId, orgId);
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
  return all<{ at: string; by_user: string; from_status: FindingStatus; to_status: FindingStatus; note: string | null; by_name: string | null }>(
    s,
    `SELECT h.at, h.by_user, h.from_status, h.to_status, h.note, u.name AS by_name
     FROM finding_status_history h LEFT JOIN app_user u ON u.id = h.by_user
     WHERE h.project_id = ? AND h.purl = ? ORDER BY h.seq DESC`,
    projectId,
    purl,
  ).map((r) => ({ at: r.at, by: r.by_user, from: r.from_status, to: r.to_status, note: r.note, ...(r.by_name ? { byName: r.by_name } : {}) }));
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
    ownership: finding.behind ?? [],
    finding,
    history,
    statusHistory: statusHistory(s, row.projectId, row.purl),
  };
}

export interface FindingTriageInput {
  status?: FindingStatus;
  note?: string | null;
  /** accepted_risk only: ISO date or time when the acceptance runs out. */
  expiresAt?: string | null;
  /** A member id to assign, or null to unassign. Undefined leaves the owner alone. */
  ownerId?: string | null;
}

/**
 * The permission a triage change needs. accept_risk for anything that sets, keeps-with-a-new-date
 * or leaves accepted_risk, and for any expiresAt at all (it only ever means a risk acceptance's
 * end date, so a review-only user must not be able to extend or shorten one). review otherwise.
 */
export function triagePermission(input: Pick<FindingTriageInput, 'status' | 'expiresAt'>, currentStatus: FindingStatus): 'accept_risk' | 'review' {
  if (input.expiresAt !== undefined) return 'accept_risk';
  if (input.status === 'accepted_risk') return 'accept_risk';
  if (input.status !== undefined && currentStatus === 'accepted_risk') return 'accept_risk';
  return 'review';
}

/** Validate an expiry: a parseable date, in the future (relative to the store clock). */
export function normaliseExpiry(s: Store, v: string | null | undefined): string | null {
  if (v === undefined || v === null || v.trim() === '') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new StoreError('bad_request', 'expiresAt is not a date', ['expiresAt']);
  if (t <= s.now().getTime()) throw new StoreError('bad_request', 'expiresAt must be in the future', ['expiresAt']);
  return new Date(t).toISOString();
}

/**
 * PATCH /api/findings/:id. The server checks review / accept_risk first.
 * Status and owner apply to this purl in this project (and so to later scans too).
 */
export function updateFindingStatus(s: Store, orgId: string, findingId: string, input: FindingTriageInput, actor: string): FindingRow {
  return tx(s, () => {
    const row = getFindingRow(s, orgId, findingId);
    if (!row) throw new StoreError('not_found', 'Finding not found');
    return applyTriage(s, orgId, row, input, actor);
  });
}

/** Apply one triage change to a row (inside a transaction). Exported for bulk updates. */
export function applyTriage(s: Store, orgId: string, row: FindingRow, input: FindingTriageInput, actor: string): FindingRow {
  if (input.status !== undefined && !isFindingStatus(input.status)) throw new StoreError('bad_request', 'Unknown status', ['status']);
  if (input.status === undefined && input.ownerId === undefined) throw new StoreError('bad_request', 'Nothing to change: give status or ownerId', ['status']);
  const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null;
  const status = input.status ?? row.status;
  const expires = status === 'accepted_risk' ? (input.expiresAt !== undefined ? normaliseExpiry(s, input.expiresAt) : row.riskExpiresAt) : null;
  if (input.ownerId !== undefined && input.ownerId !== null) {
    const member = get<{ ok: number }>(s, 'SELECT 1 AS ok FROM role_binding WHERE org_id = ? AND subject_kind = ? AND subject_ref = ? LIMIT 1', orgId, 'user', input.ownerId);
    if (!member) throw new StoreError('bad_request', 'Unknown member', ['ownerId']);
  }
  const ownerId = input.ownerId !== undefined ? input.ownerId : (row.owner?.id ?? null);
  const statusChanged = status !== row.status || (input.status !== undefined && note !== null) || expires !== row.riskExpiresAt;
  const ownerChanged = ownerId !== (row.owner?.id ?? null);
  if (!statusChanged && !ownerChanged) return row;
  const at = nowIso(s);
  run(
    s,
    `INSERT INTO finding_state (project_id, purl, status, owner_id, risk_expires_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, purl) DO UPDATE SET status = excluded.status, owner_id = excluded.owner_id,
       risk_expires_at = excluded.risk_expires_at, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    row.projectId,
    row.purl,
    status,
    ownerId,
    expires,
    at,
    actor,
  );
  if (statusChanged) {
    run(
      s,
      'INSERT INTO finding_status_history (project_id, purl, at, by_user, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.projectId,
      row.purl,
      at,
      actor,
      row.status,
      status,
      expires ? `${note ?? ''}${note ? ' ' : ''}(until ${expires.slice(0, 10)})` : note,
    );
    writeAudit(s, {
      orgId,
      actor,
      action: 'finding.status',
      target: row.id,
      detail: { projectId: row.projectId, purl: row.purl, from: row.status, to: status, note, ...(expires ? { expiresAt: expires } : {}) },
    });
  }
  if (ownerChanged) {
    writeAudit(s, {
      orgId,
      actor,
      action: 'finding.owner',
      target: row.id,
      detail: { projectId: row.projectId, purl: row.purl, from: row.owner?.id ?? null, to: ownerId },
    });
  }
  return getFindingRow(s, orgId, row.id)!;
}

/** Level counts and "new" count for one scan. */
export function scanFindingStats(s: Store, scanId: string): { counts: Record<RiskLevel, number>; toReview: number } {
  const counts = emptyCounts();
  for (const r of all<{ level: RiskLevel; n: number }>(s, 'SELECT level, count(*) AS n FROM finding WHERE scan_id = ? GROUP BY level', scanId)) {
    if (isRiskLevel(r.level)) counts[r.level] = r.n;
  }
  const toReview =
    get<{ n: number }>(s, `SELECT count(*) AS n FROM ${FINDING_FROM} WHERE f.scan_id = ? AND ${findingStatusSql(s)} = 'new'`, scanId)?.n ?? 0;
  return { counts, toReview };
}
