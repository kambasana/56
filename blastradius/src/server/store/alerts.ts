/**
 * Org-wide incident mode in the store: stored inventories of each project's newest succeeded scan,
 * and alerts for (project, component, advisory) hits. An alert is recorded once; checking the same
 * advisory again adds nothing.
 */
import type { RiskLevel } from '../../core/types.js';
import type { ExposureHit, StoredInventory } from '../../watch/match.js';
import { all, get, newId, nowIso, placeholders, run, tx, type Store } from './db.js';
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

/** Newest succeeded scan's inventory for every (visible) project that has one. */
export function latestInventories(s: Store, orgId: string, projectIds: readonly string[] | null = null): StoredInventory[] {
  if (projectIds && projectIds.length === 0) return [];
  const filter = projectIds ? ` AND p.id IN (${placeholders(projectIds.length)})` : '';
  const rows = all<{ projectId: string; projectName: string; scanId: string }>(
    s,
    `SELECT p.id AS projectId, p.name AS projectName,
       (SELECT sc.id FROM scan sc WHERE sc.project_id = p.id AND sc.status = 'succeeded' ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT 1) AS scanId
     FROM project p WHERE p.org_id = ?${filter} ORDER BY p.name`,
    orgId,
    ...(projectIds ?? []),
  );
  const out: StoredInventory[] = [];
  for (const r of rows) {
    if (!r.scanId) continue;
    const inventory = getScanInventory(s, orgId, r.scanId);
    if (inventory) out.push({ projectId: r.projectId, projectName: r.projectName, scanId: r.scanId, inventory });
  }
  return out;
}

/** Record hits that are not alerts yet; returns only the new ones. */
export function recordAlerts(s: Store, orgId: string, hits: readonly ExposureHit[]): AlertRow[] {
  const created: AlertRow[] = [];
  tx(s, () => {
    const at = nowIso(s);
    for (const h of hits) {
      if (!h.advisoryId) continue;
      const exists = get<{ id: string }>(s, 'SELECT id FROM alert WHERE org_id = ? AND project_id = ? AND purl = ? AND advisory_id = ?', orgId, h.projectId, h.purl, h.advisoryId);
      if (exists) continue;
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
        h.summary?.slice(0, 500) ?? null,
        h.fixedIn ?? null,
      );
      const level = h.level ?? findingLevel(s, h.scanId ?? null, h.purl);
      created.push({
        id,
        projectId: h.projectId,
        projectName: h.projectName,
        scanId: h.scanId ?? null,
        purl: h.purl,
        advisoryId: h.advisoryId,
        advisoryPublished: h.advisoryPublished ?? null,
        production: h.production,
        reachText: h.reachText,
        createdAt: at,
        level,
        summary: h.summary?.slice(0, 500) ?? null,
        fixedIn: h.fixedIn ?? null,
      });
    }
  });
  return created;
}

/** The finding's level for `purl` in `scanId`, or null. */
function findingLevel(s: Store, scanId: string | null, purl: string): RiskLevel | null {
  if (!scanId) return null;
  return get<{ level: RiskLevel }>(s, 'SELECT level FROM finding WHERE scan_id = ? AND purl = ?', scanId, purl)?.level ?? null;
}

export interface ListAlertsOptions {
  projectIds?: readonly string[] | null;
  limit?: number;
  /** Only alerts of this advisory. */
  advisoryId?: string;
  /** Only alerts created at or after this time. */
  since?: string;
}

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
     WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.production DESC, p.name LIMIT ?`,
    ...params,
    Math.min(5000, Math.max(1, opts.limit ?? 200)),
  ).map((r) => ({ ...r, production: r.production === 1, level: r.level ?? null, summary: r.summary ?? null, fixedIn: r.fixedIn ?? null }));
}
