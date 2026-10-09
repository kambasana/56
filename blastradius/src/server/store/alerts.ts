/**
 * Org-wide incident mode in the store: stored inventories of each project's newest succeeded scan,
 * and alerts for (project, component, advisory) hits. An alert is recorded once; checking the same
 * advisory again adds nothing, except to raise the alert's level when the new hit rates it higher.
 */
import type { RiskLevel } from '../../core/types.js';
import type { ExposureHit, StoredInventory } from '../../watch/match.js';
import { all, get, newId, nowIso, placeholders, run, tx, type Store } from './db.js';
import { findingFor, LEVEL_RANK } from './findings.js';
import { reopenIncident } from './incidents.js';
import { getScanInventory } from './scans.js';

export interface AlertRow {
  id: string;
  projectId: string;
  projectName: string;
  scanId: string | null;
  purl: string;
  advisoryId: string;
  advisoryPublished: string | null;
  production: boolean;
  reachText: string;
  createdAt: string;
  /**
   * The advisory's rating, else the finding's level for this package in the alert's scan; null
   * when neither is known.
   */
  level?: RiskLevel | null;
  /** The advisory's summary, when it has one. */
  summary?: string | null;
  /** First fixed version the advisory names. */
  fixedIn?: string | null;
}

/** Newest succeeded scan id of every (visible) project that has one, by project id, in project-name order. SQL only. */
export function latestScanIds(s: Store, orgId: string, projectIds: readonly string[] | null = null): Map<string, string> {
  return new Map(latestScanRows(s, orgId, projectIds).map((r) => [r.projectId, r.scanId] as const));
}

function latestScanRows(s: Store, orgId: string, projectIds: readonly string[] | null): { projectId: string; projectName: string; scanId: string }[] {
  if (projectIds && projectIds.length === 0) return [];
  const filter = projectIds ? ` AND p.id IN (${placeholders(projectIds.length)})` : '';
  return all<{ projectId: string; projectName: string; scanId: string | null }>(
    s,
    `SELECT p.id AS projectId, p.name AS projectName,
       (SELECT sc.id FROM scan sc WHERE sc.project_id = p.id AND sc.status = 'succeeded' ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT 1) AS scanId
     FROM project p WHERE p.org_id = ?${filter} ORDER BY p.name`,
    orgId,
    ...(projectIds ?? []),
  ).filter((r): r is { projectId: string; projectName: string; scanId: string } => !!r.scanId);
}

/** Newest succeeded scan's inventory for every (visible) project that has one. */
export function latestInventories(s: Store, orgId: string, projectIds: readonly string[] | null = null): StoredInventory[] {
  const out: StoredInventory[] = [];
  for (const r of latestScanRows(s, orgId, projectIds)) {
    const inventory = getScanInventory(s, orgId, r.scanId);
    if (inventory) out.push({ projectId: r.projectId, projectName: r.projectName, scanId: r.scanId, inventory });
  }
  return out;
}

export interface RecordedAlerts {
  /** Hits that were not alerts yet. */
  created: AlertRow[];
  /** Existing alerts whose level the hit raised (never lowered), e.g. high → critical. */
  raised: (AlertRow & { raisedFrom: RiskLevel | null })[];
}

/**
 * Record hits as alerts. A (project, purl, advisory) that already has an alert is not duplicated,
 * but its level is raised when the hit rates it higher (never lowered). A new alert for an incident
 * that was closed reopens it (see reopenIncident).
 */
export function recordAlerts(s: Store, orgId: string, hits: readonly ExposureHit[]): RecordedAlerts {
  const out: RecordedAlerts = { created: [], raised: [] };
  tx(s, () => {
    const at = nowIso(s);
    const reopened = new Set<string>();
    for (const h of hits) {
      if (!h.advisoryId) continue;
      const summary = h.summary?.slice(0, 500) ?? null;
      const row = (id: string, createdAt: string, level: RiskLevel | null): AlertRow => ({
        id,
        projectId: h.projectId,
        projectName: h.projectName,
        scanId: h.scanId ?? null,
        purl: h.purl,
        advisoryId: h.advisoryId!,
        advisoryPublished: h.advisoryPublished ?? null,
        production: h.production,
        reachText: h.reachText,
        createdAt,
        level,
        summary,
        fixedIn: h.fixedIn ?? null,
      });
      const existing = get<{ id: string; scan_id: string | null; level: RiskLevel | null; created_at: string }>(
        s,
        'SELECT id, scan_id, level, created_at FROM alert WHERE org_id = ? AND project_id = ? AND purl = ? AND advisory_id = ?',
        orgId,
        h.projectId,
        h.purl,
        h.advisoryId,
      );
      if (existing) {
        if (!h.level) continue;
        const current = existing.level ?? findingFor(s, existing.scan_id, h.purl)?.level ?? null;
        if (current && LEVEL_RANK[h.level] <= LEVEL_RANK[current]) continue;
        run(s, 'UPDATE alert SET level = ?, summary = COALESCE(?, summary) WHERE id = ?', h.level, summary, existing.id);
        out.raised.push({ ...row(existing.id, existing.created_at, h.level), raisedFrom: current });
        continue;
      }
      const id = newId('alr');
      run(
        s,
        `INSERT INTO alert (id, org_id, project_id, scan_id, purl, advisory_id, advisory_published, production, reach_text, created_at, level, summary, fixed_in) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        orgId,
        h.projectId,
        h.scanId ?? null,
        h.purl,
        h.advisoryId,
        h.advisoryPublished ?? null,
        h.production ? 1 : 0,
        h.reachText,
        at,
        h.level ?? null,
        summary,
        h.fixedIn ?? null,
      );
      out.created.push(row(id, at, h.level ?? findingFor(s, h.scanId, h.purl)?.level ?? null));
      if (!reopened.has(h.advisoryId)) {
        reopened.add(h.advisoryId);
        reopenIncident(s, orgId, h.advisoryId, `New alert: ${h.name}@${h.version} in ${h.projectName}`);
      }
    }
  });
  return out;
}

export interface ListAlertsOptions {
  projectIds?: readonly string[] | null;
  /** Default 200, at most 5000; null (NO_LIMIT) for every matching alert. */
  limit?: number | null;
  /** Only alerts of this advisory. */
  advisoryId?: string;
  /** Only alerts created at or after this time. */
  since?: string;
}

/** listAlerts with no row limit (one advisory's alerts, for the Incident page). */
export const NO_LIMIT = null;

/** Newest first. `level` falls back to the finding's level in the alert's scan. */
export function listAlerts(s: Store, orgId: string, opts: ListAlertsOptions = {}): AlertRow[] {
  if (opts.projectIds && opts.projectIds.length === 0) return [];
  const where: string[] = ['a.org_id = ?'];
  const params: (string | number)[] = [orgId];
  if (opts.projectIds) {
    where.push(`a.project_id IN (${placeholders(opts.projectIds.length)})`);
    params.push(...opts.projectIds);
  }
  if (opts.advisoryId !== undefined) {
    where.push('a.advisory_id = ?');
    params.push(opts.advisoryId);
  }
  if (opts.since !== undefined) {
    where.push('a.created_at >= ?');
    params.push(opts.since);
  }
  return all<Omit<AlertRow, 'production'> & { production: number }>(
    s,
    `SELECT a.id, a.project_id AS projectId, p.name AS projectName, a.scan_id AS scanId, a.purl, a.advisory_id AS advisoryId,
       a.advisory_published AS advisoryPublished, a.production, a.reach_text AS reachText, a.created_at AS createdAt,
       COALESCE(a.level, (SELECT f.level FROM finding f WHERE f.scan_id = a.scan_id AND f.purl = a.purl)) AS level,
       a.summary, a.fixed_in AS fixedIn
     FROM alert a JOIN project p ON p.id = a.project_id
     WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.production DESC, p.name${opts.limit === null ? '' : ' LIMIT ?'}`,
    ...params,
    ...(opts.limit === null ? [] : [Math.min(5000, Math.max(1, opts.limit ?? 200))]),
  ).map((r) => ({ ...r, production: r.production === 1, level: r.level ?? null, summary: r.summary ?? null, fixedIn: r.fixedIn ?? null }));
}

// ---------------------------------------------------------------------------
// Incident aggregates (the Incidents list)
// ---------------------------------------------------------------------------

/** One advisory's alerts in one project, aggregated in SQL. */
export interface IncidentProjectAggregate {
  advisoryId: string;
  projectId: string;
  projectName: string;
  production: boolean;
  /** Distinct purls alerted in this project. */
  purls: string[];
  firstAt: string;
  published: string | null;
  /** Worst level (the alert's rating, else the finding's in the alert's scan). */
  level: RiskLevel | null;
}

const RANK_LEVEL: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];
const SEP = '\u001f';

/**
 * Every alert of the org (visible projects only), grouped by (advisory, project), with no row cap:
 * the list is as long as incidents × affected projects, never alerts.
 */
export function incidentProjectAggregates(s: Store, orgId: string, projectIds: readonly string[] | null): IncidentProjectAggregate[] {
  if (projectIds && projectIds.length === 0) return [];
  const filter = projectIds ? ` AND a.project_id IN (${placeholders(projectIds.length)})` : '';
  return all<{ advisoryId: string; projectId: string; projectName: string; production: number; purls: string; firstAt: string; published: string | null; rank: number | null }>(
    s,
    `SELECT a.advisory_id AS advisoryId, a.project_id AS projectId, p.name AS projectName, max(a.production) AS production,
       group_concat(a.purl, char(31)) AS purls, min(a.created_at) AS firstAt, min(a.advisory_published) AS published,
       max(CASE COALESCE(a.level, (SELECT f.level FROM finding f WHERE f.scan_id = a.scan_id AND f.purl = a.purl))
             WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 WHEN 'low' THEN 0 END) AS rank
     FROM alert a JOIN project p ON p.id = a.project_id
     WHERE a.org_id = ?${filter}
     GROUP BY a.advisory_id, a.project_id`,
    orgId,
    ...(projectIds ?? []),
  ).map((r) => ({
    advisoryId: r.advisoryId,
    projectId: r.projectId,
    projectName: r.projectName,
    production: r.production === 1,
    purls: r.purls.split(SEP),
    firstAt: r.firstAt,
    published: r.published,
    level: r.rank === null ? null : (RANK_LEVEL[r.rank] ?? null),
  }));
}

/** The newest alert summary of each advisory (visible projects only). */
export function incidentSummaries(s: Store, orgId: string, projectIds: readonly string[] | null): Map<string, string> {
  if (projectIds && projectIds.length === 0) return new Map();
  const filter = projectIds ? ` AND project_id IN (${placeholders(projectIds.length)})` : '';
  // SQLite takes the bare `summary` from the row holding max(created_at).
  const rows = all<{ advisoryId: string; summary: string }>(
    s,
    `SELECT advisory_id AS advisoryId, summary, max(created_at) AS at FROM alert WHERE org_id = ? AND summary IS NOT NULL${filter} GROUP BY advisory_id`,
    orgId,
    ...(projectIds ?? []),
  );
  return new Map(rows.map((r) => [r.advisoryId, r.summary] as const));
}

const scanPurlCache = new WeakMap<Store, Map<string, ReadonlySet<string>>>();
const SCAN_PURL_CACHE_MAX = 256;

/**
 * Purls in one succeeded scan's inventory, cached by scan id (a scan's inventory never changes once
 * stored), so listing incidents does not re-parse every inventory on each call.
 */
export function scanPurls(s: Store, orgId: string, scanId: string): ReadonlySet<string> {
  let cache = scanPurlCache.get(s);
  if (!cache) scanPurlCache.set(s, (cache = new Map()));
  const key = `${orgId}\u0000${scanId}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const set = new Set((getScanInventory(s, orgId, scanId)?.components ?? []).map((c) => c.purl));
  cache.set(key, set);
  if (cache.size > SCAN_PURL_CACHE_MAX) cache.delete(cache.keys().next().value!);
  return set;
}
