/**
 * Org-wide incident mode in the store: stored inventories of each project's newest succeeded scan,
 * and alerts for (project, component, advisory) hits. An alert is recorded once; checking the same
 * advisory again adds nothing.
 */
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
        `INSERT INTO alert (id, org_id, project_id, scan_id, purl, advisory_id, advisory_published, production, reach_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
      created.push({ id, projectId: h.projectId, projectName: h.projectName, scanId: h.scanId ?? null, purl: h.purl, advisoryId: h.advisoryId, advisoryPublished: h.advisoryPublished ?? null, production: h.production, reachText: h.reachText, createdAt: at });
    }
  });
  return created;
}

export function listAlerts(s: Store, orgId: string, opts: { projectIds?: readonly string[] | null; limit?: number } = {}): AlertRow[] {
  if (opts.projectIds && opts.projectIds.length === 0) return [];
  const filter = opts.projectIds ? ` AND a.project_id IN (${placeholders(opts.projectIds.length)})` : '';
  return all<Omit<AlertRow, 'production'> & { production: number }>(
    s,
    `SELECT a.id, a.project_id AS projectId, p.name AS projectName, a.scan_id AS scanId, a.purl, a.advisory_id AS advisoryId,
       a.advisory_published AS advisoryPublished, a.production, a.reach_text AS reachText, a.created_at AS createdAt
     FROM alert a JOIN project p ON p.id = a.project_id
     WHERE a.org_id = ?${filter} ORDER BY a.created_at DESC, a.production DESC, p.name LIMIT ?`,
    orgId,
    ...(opts.projectIds ?? []),
    Math.min(1000, Math.max(1, opts.limit ?? 200)),
  ).map((r) => ({ ...r, production: r.production === 1 }));
}
