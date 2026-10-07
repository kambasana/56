/**
 * Org-wide incident mode: "is X anywhere?" and alerts from new advisories or the knowledge pack,
 * answered from stored inventories (no re-scan).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { searchExposure } from '../../watch/match.js';
import type { CheckAlertsResponse, ListAlertsResponse, SearchExposureResponse } from '../api-types.js';
import { deps, requireOrgPerm, visibleProjects, type AppEnv } from '../context.js';
import { badRequest } from '../errors.js';
import { parseBody, queryInt, queryString } from '../request.js';
import { latestInventories, listAlerts, type AlertRow } from '../store/index.js';

const Affected = z.object({
  package: z.object({ name: z.string().max(214), ecosystem: z.string().max(40) }).optional(),
  versions: z.array(z.string().max(100)).max(5000).optional(),
  ranges: z.array(z.object({ events: z.array(z.record(z.string(), z.string().max(100))).max(50).optional() })).max(50).optional(),
});
const CheckBody = z.object({
  advisories: z
    .array(z.object({ id: z.string().min(1).max(100), published: z.string().max(40).optional(), summary: z.string().max(500).optional(), affected: z.array(Affected).max(200).optional() }))
    .max(5000)
    .optional(),
});

/** "chalk", "chalk@5.6.1", "@scope/pkg" or "@scope/pkg@1.0.0". */
export function parseExposureQuery(q: string): { name: string; version?: string } | null {
  const m = /^(@?[^@\s]+)(?:@([^@\s]+))?$/.exec(q.trim());
  if (!m) return null;
  return m[2] ? { name: m[1]!, version: m[2] } : { name: m[1]! };
}

const toItem = (a: AlertRow) => ({ ...a });

export function registerAlertRoutes(app: Hono<AppEnv>): void {
  app.get('/api/search/exposure', (c) => {
    const q = queryString(c, 'q', 300);
    const query = q ? parseExposureQuery(q) : null;
    if (!query) throw badRequest('Give a package name, optionally with @version', ['q']);
    const { orgId, projectIds } = visibleProjects(c, 'exposure');
    const inventories = latestInventories(deps(c).store, orgId, projectIds);
    const items = searchExposure(inventories, query).map(({ projectId, projectName, purl, name, version, production, reachText }) => ({ projectId, projectName, purl, name, version, production, reachText }));
    return c.json<SearchExposureResponse>({ query: { name: query.name, version: query.version ?? null }, projectsSearched: inventories.length, items });
  });

  app.get('/api/alerts', (c) => {
    const { orgId, projectIds } = visibleProjects(c, 'findings', 'exposure');
    const limit = queryInt(c, 'limit', 1, 1000);
    return c.json<ListAlertsResponse>({ items: listAlerts(deps(c).store, orgId, { projectIds, ...(limit !== undefined ? { limit } : {}) }).map(toItem) });
  });

  app.post('/api/alerts/check', async (c) => {
    const { orgId } = requireOrgPerm(c, 'manage_projects');
    const body = await parseBody(c, CheckBody);
    const { watcher } = deps(c);
    if (!body.advisories && !watcher.enabled) throw badRequest('No advisories given and no knowledge pack configured (BLASTRADIUS_PACK)', ['advisories']);
    const started = performance.now();
    const r = await watcher.checkOrg(orgId, body.advisories ? { advisories: body.advisories } : {});
    return c.json<CheckAlertsResponse>({ source: r.source, projectsChecked: r.projectsChecked, ms: Math.round(performance.now() - started), created: r.created.map(toItem) });
  });
}
