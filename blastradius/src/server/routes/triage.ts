/** Org-wide triage: /api/findings/packages, /api/findings/bulk, /api/assignees, /api/overview. */
import type { Hono } from 'hono';
import { z } from 'zod';
import type {
  BulkUpdateFindingsResponse,
  ListAssigneesResponse,
  ListOrgFindingsResponse,
  ListPackageFindingsResponse,
  OrgFindingSort,
  OverviewResponse,
} from '../api-types.js';
import { FINDING_STATUSES, ORG_FINDING_SORTS } from '../api-types.js';
import { deps, hasProjectPerm, requireOrg, visibleProjects, type AppEnv, type Ctx } from '../context.js';
import { badRequest, forbidden } from '../errors.js';
import { pageQuery, parseBody, queryString } from '../request.js';
import {
  bulkUpdateFindings,
  findingRowsFor,
  listAssignees,
  listOrgFindings,
  listPackageFindings,
  overview,
  parseLevelList,
  parseOwnerList,
  parseSince,
  parseStatusList,
  scopeProjects,
  type OrgFindingFilter,
} from '../store/index.js';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/** Body fields shared by PATCH /api/findings/:id and POST /api/findings/bulk. */
export const TriageFields = {
  status: z.enum(FINDING_STATUSES).optional(),
  note: z.string().max(2000).optional(),
  expiresAt: z.string().max(40).optional(),
  ownerId: ID.nullable().optional(),
};

const BulkBody = z.strictObject({ ids: z.array(ID).min(1).max(500), ...TriageFields });

type OrgQuery = OrgFindingFilter & { sort?: OrgFindingSort; limit?: number; cursor?: string };

function listParam(c: Ctx, name: string): string[] | undefined {
  const v = queryString(c, name, 5000);
  if (v === undefined) return undefined;
  const out = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
  if (out.length > 500 || out.some((x) => !/^[A-Za-z0-9_-]{1,100}$/.test(x))) throw badRequest(`Invalid ${name}`, [name]);
  return out;
}

function envParam(c: Ctx): 'prod' | 'dev' | undefined {
  const env = queryString(c, 'env', 10);
  if (env === undefined) return undefined;
  if (env !== 'prod' && env !== 'dev') throw badRequest('env must be prod or dev', ['env']);
  return env;
}

/** Filters of the org-wide findings list, scoped to the projects the caller may read findings in. */
export function orgFindingQuery(c: Ctx): { orgId: string; filter: OrgQuery } {
  const { orgId, projectIds } = visibleProjects(c, 'findings');
  const sort = queryString(c, 'sort', 20);
  if (sort !== undefined && !(ORG_FINDING_SORTS as readonly string[]).includes(sort)) throw badRequest('Unknown sort', ['sort']);
  const levels = parseLevelList(queryString(c, 'level', 100));
  const statuses = parseStatusList(queryString(c, 'status', 200));
  const owners = parseOwnerList(queryString(c, 'owner', 5000));
  const since = parseSince(queryString(c, 'since', 40));
  const q = queryString(c, 'q', 200);
  const env = envParam(c);
  const filter: OrgQuery = {
    projectIds: scopeProjects(projectIds, listParam(c, 'projects')),
    ...(env ? { env } : {}),
    ...(levels ? { levels } : {}),
    ...(statuses ? { statuses } : {}),
    ...(owners ? { owners } : {}),
    ...(since ? { since } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(sort !== undefined ? { sort: sort as OrgFindingSort } : {}),
    ...pageQuery(c),
  };
  return { orgId, filter };
}

/** GET /api/findings without `project`. */
export function listOrgFindingsHandler(c: Ctx) {
  const { orgId, filter } = orgFindingQuery(c);
  return c.json<ListOrgFindingsResponse>(listOrgFindings(deps(c).store, orgId, filter));
}

export function registerTriageRoutes(app: Hono<AppEnv>): void {
  app.get('/api/findings/packages', (c) => {
    const { orgId, filter } = orgFindingQuery(c);
    return c.json<ListPackageFindingsResponse>(listPackageFindings(deps(c).store, orgId, filter));
  });

  app.post('/api/findings/bulk', async (c) => {
    const { orgId, session } = requireOrg(c);
    const body = await parseBody(c, BulkBody);
    if (body.status === undefined && body.ownerId === undefined) throw badRequest('Nothing to change: give status or ownerId', ['status']);
    if (body.status === 'accepted_risk' && (!body.note?.trim() || !body.expiresAt)) {
      const fields = [...(!body.note?.trim() ? ['note'] : []), ...(!body.expiresAt ? ['expiresAt'] : [])];
      throw badRequest('Accepting risk needs a reason (note) and an expiry date (expiresAt)', fields);
    }
    const { store } = deps(c);
    // 404 before 403: every id must exist in this org first.
    const rows = findingRowsFor(store, orgId, body.ids);
    for (const row of rows) {
      const touchesRisk = body.status === 'accepted_risk' || (body.status !== undefined && row.status === 'accepted_risk');
      const perm = touchesRisk ? 'accept_risk' : 'review';
      if (!hasProjectPerm(c, orgId, session.user.id, row.projectId, perm)) throw forbidden(`Missing permission: ${perm}`);
    }
    const { ids: _ids, ...input } = body;
    const items = bulkUpdateFindings(store, orgId, rows, input, session.user.id);
    return c.json<BulkUpdateFindingsResponse>({ updated: items.length, items });
  });

  app.get('/api/assignees', (c) => {
    const { orgId } = visibleProjects(c, 'findings');
    return c.json<ListAssigneesResponse>({ items: listAssignees(deps(c).store, orgId) });
  });

  app.get('/api/overview', (c) => {
    const { orgId, projectIds } = visibleProjects(c, 'findings');
    const range = queryString(c, 'range', 10);
    if (range !== undefined && !['7d', '30d', '90d', 'all'].includes(range)) throw badRequest('Unknown range', ['range']);
    const env = envParam(c);
    return c.json<OverviewResponse>(
      overview(deps(c).store, orgId, {
        projectIds: scopeProjects(projectIds, listParam(c, 'projects')),
        ...(env ? { env } : {}),
        ...(range ? { range: range as '7d' | '30d' | '90d' | 'all' } : {}),
      }),
    );
  });
}
