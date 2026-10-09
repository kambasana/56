/**
 * Org-wide triage (docs/UX.md §4): the findings list across every project the caller may read,
 * grouped by package or not, bulk status / owner changes, the people a finding can be assigned
 * to, and the numbers behind the Overview page. Everything reads each project's latest
 * succeeded scan; nothing is re-scanned.
 */
import type {
  FindingRow,
  FindingStatus,
  ListOrgFindingsResponse,
  ListPackageFindingsResponse,
  OrgFindingRow,
  OrgFindingSort,
  OverviewResponse,
  PackageFindingGroup,
  PersonRef,
} from '../api-types.js';
import { OPEN_FINDING_STATUSES } from '../api-types.js';
import type { Finding, RiskLevel } from '../../core/types.js';
import { all, get, likeEscape, nextCursorFor, nowIso, pageWindow, parseJson, placeholders, StoreError, tx, type Param, type Store } from './db.js';
import { purlNameVersion } from '../reach.js';
import { applyTriage, FINDING_FROM, findingColumns, findingStatusSql, getFindingRow, introducedByOf, RISK_LEVELS, toFindingRow, worstLevel, type FindingSqlRow, type FindingTriageInput } from './findings.js';

// ---------------------------------------------------------------------------
// Scope: which scans are listed
// ---------------------------------------------------------------------------

export interface LatestScan {
  projectId: string;
  projectName: string;
  scanId: string | null;
  /** Status and error of the newest scan of any status (for "sources to check"). */
  lastStatus: string | null;
  lastError: string | null;
}

/** Projects in the org (filtered to `projectIds` when given) with their newest succeeded scan. */
export function latestScans(s: Store, orgId: string, projectIds: readonly string[] | null): LatestScan[] {
  if (projectIds && projectIds.length === 0) return [];
  const filter = projectIds ? ` AND p.id IN (${placeholders(projectIds.length)})` : '';
  return all<LatestScan>(
    s,
    `SELECT p.id AS projectId, p.name AS projectName,
       (SELECT sc.id FROM scan sc WHERE sc.project_id = p.id AND sc.status = 'succeeded' ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT 1) AS scanId,
       (SELECT sc.status FROM scan sc WHERE sc.project_id = p.id ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT 1) AS lastStatus,
       (SELECT sc.error FROM scan sc WHERE sc.project_id = p.id ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT 1) AS lastError
     FROM project p WHERE p.org_id = ?${filter} ORDER BY p.name COLLATE NOCASE`,
    orgId,
    ...(projectIds ?? []),
  );
}

/** Visible ∩ requested project ids (null = all visible). Unknown ids are dropped, never an error. */
export function scopeProjects(visible: readonly string[] | null, requested: readonly string[] | undefined): string[] | null {
  if (!requested || requested.length === 0) return visible ? [...visible] : null;
  if (!visible) return [...new Set(requested)];
  const allowed = new Set(visible);
  return [...new Set(requested)].filter((id) => allowed.has(id));
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface OrgFindingFilter {
  /** Project ids in scope (already intersected with what the caller may see); null = all in org. */
  projectIds: readonly string[] | null;
  env?: 'prod' | 'dev';
  levels?: readonly RiskLevel[];
  statuses?: readonly FindingStatus[];
  /** Member ids; "none" = unassigned. */
  owners?: readonly string[];
  since?: string;
  q?: string;
}

interface Where {
  sql: string;
  params: Param[];
  /** Only the "latest scans in scope" part, for counts that ignore the other filters. */
  scanSql: string;
  scanParams: Param[];
  scanned: number;
}

function buildWhere(s: Store, orgId: string, f: OrgFindingFilter): Where | null {
  const scans = latestScans(s, orgId, f.projectIds).filter((x) => x.scanId);
  if (scans.length === 0) return null;
  const where: string[] = [`f.scan_id IN (${placeholders(scans.length)})`, 'f.org_id = ?'];
  const params: Param[] = [...scans.map((x) => x.scanId!), orgId];
  if (f.env === 'prod') where.push('f.prod_assets > 0');
  if (f.env === 'dev') where.push('f.prod_assets = 0');
  if (f.levels && f.levels.length > 0) {
    where.push(`f.level IN (${placeholders(f.levels.length)})`);
    params.push(...f.levels);
  }
  if (f.statuses && f.statuses.length > 0) {
    where.push(`${findingStatusSql(s)} IN (${placeholders(f.statuses.length)})`);
    params.push(...f.statuses);
  }
  if (f.owners && f.owners.length > 0) {
    const ids = f.owners.filter((o) => o !== 'none');
    const parts: string[] = [];
    if (f.owners.includes('none')) parts.push('st.owner_id IS NULL');
    if (ids.length > 0) {
      parts.push(`st.owner_id IN (${placeholders(ids.length)})`);
      params.push(...ids);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.since) {
    where.push('f.first_seen_at >= ?');
    params.push(f.since);
  }
  const text = f.q?.trim().toLowerCase();
  if (text) {
    where.push(`f.search LIKE ? ESCAPE '\\'`);
    params.push(`%${likeEscape(text.slice(0, 200))}%`);
  }
  return { sql: where.join(' AND '), params, scanSql: where.slice(0, 2).join(' AND '), scanParams: params.slice(0, scans.length + 1), scanned: scans.length };
}

/** Parse "a,b" owner filters: member ids (opaque) or "none". */
export function parseOwnerList(v: string | undefined): string[] | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const out = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
  if (out.length > 50 || out.some((x) => !/^[A-Za-z0-9_-]{1,100}$/.test(x))) throw new StoreError('bad_request', 'Invalid owner', ['owner']);
  return out;
}

/** Parse an ISO "since" filter. */
export function parseSince(v: string | undefined): string | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new StoreError('bad_request', 'since is not a date', ['since']);
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// GET /api/findings (no project): one row per finding
// ---------------------------------------------------------------------------

const ORG_SORT_SQL: Record<OrgFindingSort, string> = {
  '-score': 'f.level_rank DESC, f.score DESC, f.prod_assets DESC, p.name COLLATE NOCASE, f.ord',
  score: 'f.level_rank ASC, f.score ASC, p.name COLLATE NOCASE, f.ord',
  name: 'f.name COLLATE NOCASE ASC, f.version, p.name COLLATE NOCASE',
  reach: 'f.prod_assets DESC, f.assets DESC, f.score DESC, f.ord',
  '-firstSeen': 'f.first_seen_at DESC, f.score DESC, f.ord',
  firstSeen: 'f.first_seen_at ASC, f.score DESC, f.ord',
};

type OrgSqlRow = FindingSqlRow & { project_name: string; finding_json: string };

/** How many listed projects have each purl, and how many of those reach production. */
function spreadFor(s: Store, w: Where, purls: readonly string[]): Map<string, { projects: number; prodProjects: number }> {
  const out = new Map<string, { projects: number; prodProjects: number }>();
  if (purls.length === 0) return out;
  // Spread counts every listed project with the package, regardless of status / owner filters.
  for (const r of all<{ purl: string; projects: number; prod: number }>(
    s,
    `SELECT f.purl, count(DISTINCT f.project_id) AS projects, count(DISTINCT CASE WHEN f.prod_assets > 0 THEN f.project_id END) AS prod
     FROM finding f WHERE ${w.scanSql} AND f.purl IN (${placeholders(purls.length)}) GROUP BY f.purl`,
    ...w.scanParams,
    ...purls,
  )) {
    out.set(r.purl, { projects: r.projects, prodProjects: r.prod });
  }
  return out;
}

export function listOrgFindings(
  s: Store,
  orgId: string,
  f: OrgFindingFilter & { sort?: OrgFindingSort; limit?: number; cursor?: string },
): ListOrgFindingsResponse {
  const { limit, offset } = pageWindow(f);
  const w = buildWhere(s, orgId, f);
  if (!w) return { items: [], total: 0, nextCursor: null, scannedProjects: 0 };
  const from = `${FINDING_FROM} JOIN project p ON p.id = f.project_id`;
  const total = get<{ n: number }>(s, `SELECT count(*) AS n FROM ${from} WHERE ${w.sql}`, ...w.params)?.n ?? 0;
  const rows = all<OrgSqlRow>(
    s,
    `SELECT ${findingColumns(s)}, p.name AS project_name, f.finding_json FROM ${from} WHERE ${w.sql}
     ORDER BY ${ORG_SORT_SQL[f.sort ?? '-score'] ?? ORG_SORT_SQL['-score']} LIMIT ? OFFSET ?`,
    ...w.params,
    limit,
    offset,
  );
  const spread = spreadFor(s, w, [...new Set(rows.map((r) => r.purl))]);
  const items: OrgFindingRow[] = rows.map((r) => ({
    ...toFindingRow(r),
    projectName: r.project_name,
    introducedBy: introducedByOf(parseJson<Finding | null>(r.finding_json, null)),
    spread: spread.get(r.purl) ?? { projects: 1, prodProjects: r.prod_assets > 0 ? 1 : 0 },
  }));
  return { items, total, nextCursor: nextCursorFor(offset, rows.length, total), scannedProjects: w.scanned };
}

// ---------------------------------------------------------------------------
// GET /api/findings/packages: one row per package version
// ---------------------------------------------------------------------------

const GROUP_SORT_SQL: Record<OrgFindingSort, string> = {
  '-score': 'max(f.level_rank) DESC, max(f.score) DESC, prod DESC, projects DESC, f.purl',
  score: 'max(f.level_rank) ASC, max(f.score) ASC, f.purl',
  name: 'min(f.name) COLLATE NOCASE ASC, f.purl',
  reach: 'prod DESC, projects DESC, max(f.score) DESC, f.purl',
  '-firstSeen': 'min(f.first_seen_at) DESC, max(f.score) DESC, f.purl',
  firstSeen: 'min(f.first_seen_at) ASC, max(f.score) DESC, f.purl',
};

export function listPackageFindings(
  s: Store,
  orgId: string,
  f: OrgFindingFilter & { sort?: OrgFindingSort; limit?: number; cursor?: string },
): ListPackageFindingsResponse {
  const { limit, offset } = pageWindow(f);
  const w = buildWhere(s, orgId, f);
  if (!w) return { items: [], total: 0, nextCursor: null, scannedProjects: 0 };
  const total = get<{ n: number }>(s, `SELECT count(DISTINCT f.purl) AS n FROM ${FINDING_FROM} WHERE ${w.sql}`, ...w.params)?.n ?? 0;
  const groups = all<{ purl: string; projects: number; prod: number; first: string }>(
    s,
    `SELECT f.purl, count(DISTINCT f.project_id) AS projects, count(DISTINCT CASE WHEN f.prod_assets > 0 THEN f.project_id END) AS prod,
       min(f.first_seen_at) AS first
     FROM ${FINDING_FROM} WHERE ${w.sql} GROUP BY f.purl ORDER BY ${GROUP_SORT_SQL[f.sort ?? '-score'] ?? GROUP_SORT_SQL['-score']} LIMIT ? OFFSET ?`,
    ...w.params,
    limit,
    offset,
  );
  const purls = groups.map((g) => g.purl);
  const members = purls.length
    ? all<OrgSqlRow>(
        s,
        `SELECT ${findingColumns(s)}, p.name AS project_name, f.finding_json FROM ${FINDING_FROM} JOIN project p ON p.id = f.project_id
         WHERE ${w.sql} AND f.purl IN (${placeholders(purls.length)})
         ORDER BY f.prod_assets > 0 DESC, f.score DESC, p.name COLLATE NOCASE`,
        ...w.params,
        ...purls,
      )
    : [];
  const byPurl = new Map<string, OrgSqlRow[]>();
  for (const m of members) byPurl.set(m.purl, [...(byPurl.get(m.purl) ?? []), m]);
  const items: PackageFindingGroup[] = [];
  for (const g of groups) {
    const list = byPurl.get(g.purl) ?? [];
    const top = [...list].sort((a, b) => b.score - a.score)[0];
    if (!top) continue;
    const row = toFindingRow(top);
    const worst = worstLevel([row.level, ...list.map((m) => m.level)]) ?? row.level;
    items.push({
      purl: row.purl,
      name: row.name,
      version: row.version,
      ecosystem: row.ecosystem,
      level: worst,
      score: row.score,
      mainReason: row.mainReason,
      introducedBy: introducedByOf(parseJson<Finding | null>(top.finding_json, null)),
      firstSeenAt: g.first,
      projects: g.projects,
      prodProjects: g.prod,
      findings: list.map((m) => {
        const r = toFindingRow(m);
        return { id: r.id, projectId: r.projectId, projectName: m.project_name, production: m.prod_assets > 0, status: r.status, owner: r.owner };
      }),
    });
  }
  return { items, total, nextCursor: nextCursorFor(offset, groups.length, total), scannedProjects: w.scanned };
}

// ---------------------------------------------------------------------------
// Bulk changes
// ---------------------------------------------------------------------------

/** Rows for ids in the org; not_found when any id is unknown (or in another org). */
export function findingRowsFor(s: Store, orgId: string, ids: readonly string[]): FindingRow[] {
  const out: FindingRow[] = [];
  for (const id of new Set(ids)) {
    const row = getFindingRow(s, orgId, id);
    if (!row) throw new StoreError('not_found', 'Finding not found');
    out.push(row);
  }
  return out;
}

/**
 * Apply one change to many findings, all or nothing. Rows sharing a (project, purl) share a state,
 * so each pair is changed once. The caller checks permissions first.
 */
export function bulkUpdateFindings(s: Store, orgId: string, rows: readonly FindingRow[], input: FindingTriageInput, actor: string): FindingRow[] {
  return tx(s, () => {
    const seen = new Set<string>();
    const out: FindingRow[] = [];
    for (const row of rows) {
      const key = `${row.projectId}\u0000${row.purl}`;
      if (seen.has(key)) {
        out.push(getFindingRow(s, orgId, row.id)!);
        continue;
      }
      seen.add(key);
      const fresh = getFindingRow(s, orgId, row.id)!;
      out.push(applyTriage(s, orgId, fresh, input, actor));
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Assignees
// ---------------------------------------------------------------------------

/** Members of the org (anyone with a user binding), by name. */
export function listAssignees(s: Store, orgId: string): PersonRef[] {
  return all<PersonRef>(
    s,
    `SELECT DISTINCT u.id, u.name FROM role_binding b JOIN app_user u ON u.id = b.subject_ref
     WHERE b.org_id = ? AND b.subject_kind = 'user' AND u.disabled = 0 ORDER BY u.name COLLATE NOCASE, u.id LIMIT 1000`,
    orgId,
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const RANGE_DAYS: Record<string, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };
const DAY = 86_400_000;

export function overview(
  s: Store,
  orgId: string,
  opts: { projectIds: readonly string[] | null; env?: 'prod' | 'dev'; range?: '7d' | '30d' | '90d' | 'all' },
): OverviewResponse {
  const at = nowIso(s);
  const now = Date.parse(at);
  const days = RANGE_DAYS[opts.range ?? '30d'] ?? null;
  const since = days === null ? null : new Date(now - days * DAY).toISOString();
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const projects = latestScans(s, orgId, opts.projectIds);
  const scanned = projects.filter((p) => p.scanId);
  const sourcesToCheck = projects
    .filter((p) => p.lastStatus === 'failed' || !p.scanId)
    .filter((p) => p.lastStatus !== 'queued' && p.lastStatus !== 'running')
    .map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      problem: (p.lastStatus === 'failed' ? 'failed' : 'never_scanned') as 'failed' | 'never_scanned',
      detail: p.lastStatus === 'failed' ? p.lastError : null,
    }));

  const empty: OverviewResponse = {
    at,
    since,
    projects: projects.length,
    scannedProjects: scanned.length,
    attention: { criticalOpen: 0, criticalOpenProd: 0, highUnassigned: 0, highUnassignedOldest: null, newThisWeek: 0, newThisWeekProjects: 0, sourcesToCheck },
    bySeverity: RISK_LEVELS.map((level) => ({ level, open: 0, newInRange: since ? 0 : null })),
    topPackages: [],
    incident: null,
  };
  const w = buildWhere(s, orgId, { projectIds: opts.projectIds, ...(opts.env ? { env: opts.env } : {}), statuses: OPEN_FINDING_STATUSES });
  if (w) {
    const levelRows = all<{ level: RiskLevel; open: number; fresh: number; prod: number; unassigned: number; oldest: string | null; week: number }>(
      s,
      `SELECT f.level, count(*) AS open,
         sum(CASE WHEN f.first_seen_at >= ? THEN 1 ELSE 0 END) AS fresh,
         sum(CASE WHEN f.prod_assets > 0 THEN 1 ELSE 0 END) AS prod,
         sum(CASE WHEN st.owner_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
         min(CASE WHEN st.owner_id IS NULL THEN f.first_seen_at END) AS oldest,
         sum(CASE WHEN f.first_seen_at >= ? THEN 1 ELSE 0 END) AS week
       FROM ${FINDING_FROM} WHERE ${w.sql} GROUP BY f.level`,
      since ?? '',
      weekAgo,
      ...w.params,
    );
    const by = new Map(levelRows.map((r) => [r.level, r] as const));
    empty.bySeverity = RISK_LEVELS.map((level) => ({ level, open: by.get(level)?.open ?? 0, newInRange: since ? (by.get(level)?.fresh ?? 0) : null }));
    empty.attention.criticalOpen = by.get('critical')?.open ?? 0;
    empty.attention.criticalOpenProd = by.get('critical')?.prod ?? 0;
    empty.attention.highUnassigned = by.get('high')?.unassigned ?? 0;
    empty.attention.highUnassignedOldest = by.get('high')?.oldest ?? null;
    empty.attention.newThisWeek = levelRows.reduce((n, r) => n + (r.week ?? 0), 0);
    empty.attention.newThisWeekProjects =
      get<{ n: number }>(s, `SELECT count(DISTINCT f.project_id) AS n FROM ${FINDING_FROM} WHERE ${w.sql} AND f.first_seen_at >= ?`, ...w.params, weekAgo)?.n ?? 0;
    empty.topPackages = all<{ purl: string; name: string; version: string; lr: number; reason: string | null; projects: number; prod: number }>(
      s,
      `SELECT f.purl, min(f.name) AS name, min(f.version) AS version, max(f.level_rank) AS lr,
         max(f.top_detail) AS reason,
         count(DISTINCT f.project_id) AS projects, count(DISTINCT CASE WHEN f.prod_assets > 0 THEN f.project_id END) AS prod
       FROM ${FINDING_FROM} WHERE ${w.sql} GROUP BY f.purl
       ORDER BY projects DESC, prod DESC, lr DESC, max(f.score) DESC, f.purl LIMIT 5`,
      ...w.params,
    ).map((r) => ({
      purl: r.purl,
      name: r.name,
      version: r.version,
      level: (['low', 'medium', 'high', 'critical'] as const)[Math.max(0, Math.min(3, r.lr))]!,
      reason: r.reason,
      projects: r.projects,
      prodProjects: r.prod,
    }));
  }

  // The newest alert in range (production first on ties) of an incident that is not closed names
  // the live incident. A closed incident never shows here (a new alert reopens it).
  const scopeIds = projects.map((p) => p.projectId);
  if (scopeIds.length > 0) {
    const newest = get<{ advisory_id: string; purl: string; created_at: string }>(
      s,
      `SELECT advisory_id, purl, created_at FROM alert WHERE org_id = ? AND project_id IN (${placeholders(scopeIds.length)})
         ${since ? 'AND created_at >= ?' : ''} ${opts.env === 'prod' ? 'AND production = 1' : opts.env === 'dev' ? 'AND production = 0' : ''}
         AND advisory_id NOT IN (SELECT advisory_id FROM incident_state WHERE org_id = ? AND status = 'closed')
       ORDER BY created_at DESC, production DESC LIMIT 1`,
      orgId,
      ...scopeIds,
      ...(since ? [since] : []),
      orgId,
    );
    if (newest) {
      const agg = get<{ projects: number; prod: number; first: string }>(
        s,
        `SELECT count(DISTINCT project_id) AS projects, count(DISTINCT CASE WHEN production = 1 THEN project_id END) AS prod, min(created_at) AS first
         FROM alert WHERE org_id = ? AND advisory_id = ? AND purl = ? AND project_id IN (${placeholders(scopeIds.length)})`,
        orgId,
        newest.advisory_id,
        newest.purl,
        ...scopeIds,
      )!;
      const { name, version } = purlNameVersion(newest.purl) ?? { name: newest.purl, version: '' };
      empty.incident = { advisoryId: newest.advisory_id, purl: newest.purl, name, version, projects: agg.projects, production: agg.prod, detectedAt: agg.first };
    }
  }
  return empty;
}

// ---------------------------------------------------------------------------
// Finding page extras
// ---------------------------------------------------------------------------

/** Alerts recorded for one package in one project, oldest first. */
export function listAlertsFor(s: Store, orgId: string, projectId: string, purl: string): { advisoryId: string; advisoryPublished: string | null; createdAt: string }[] {
  return all<{ advisoryId: string; advisoryPublished: string | null; createdAt: string }>(
    s,
    `SELECT advisory_id AS advisoryId, advisory_published AS advisoryPublished, created_at AS createdAt
     FROM alert WHERE org_id = ? AND project_id = ? AND purl = ? ORDER BY created_at, advisory_id LIMIT 50`,
    orgId,
    projectId,
    purl,
  );
}

/** Projects (of `projectIds`, null = all) whose latest succeeded scan has this purl as a finding. */
export function packageSpread(s: Store, orgId: string, projectIds: readonly string[] | null, purl: string): { projects: number; prodProjects: number } {
  const scans = latestScans(s, orgId, projectIds).filter((x) => x.scanId);
  if (scans.length === 0) return { projects: 0, prodProjects: 0 };
  const r = get<{ projects: number; prod: number }>(
    s,
    `SELECT count(DISTINCT project_id) AS projects, count(DISTINCT CASE WHEN prod_assets > 0 THEN project_id END) AS prod
     FROM finding WHERE org_id = ? AND purl = ? AND scan_id IN (${placeholders(scans.length)})`,
    orgId,
    purl,
    ...scans.map((x) => x.scanId!),
  );
  return { projects: r?.projects ?? 0, prodProjects: r?.prod ?? 0 };
}
