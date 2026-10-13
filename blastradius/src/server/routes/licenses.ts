/**
 * Licences (docs/WHO-BEHIND-PLAN.md L1, L2, L4; docs/WEB-API.md "Licences").
 *   GET    /api/licenses[?project=<id>]  latest scan per visible project, org policy applied (page `exposure`)
 *   GET    /api/license-policy           the org's policy (any member with `exposure` or `settings`)
 *   PUT    /api/license-policy           replace it (`manage_projects`; validated, audited)
 *   DELETE /api/license-policy           back to the shipped default template (`manage_projects`)
 */
import type { Hono } from 'hono';
import { ZodError } from 'zod';
import type { LicensePolicyResponse, LicensesResponse } from '../api-types.js';
import { deps, requireOrgPerm, requireProjectPerm, visibleProjects, type AppEnv } from '../context.js';
import { badRequest } from '../errors.js';
import { readJson, queryString } from '../request.js';
import { parseLicensePolicy } from '../../licenses/policy.js';
import { getLicensePolicy, licensesView, setLicensePolicy } from '../store/index.js';

export function registerLicenseRoutes(app: Hono<AppEnv>): void {
  app.get('/api/licenses', (c) => {
    const projectId = queryString(c, 'project', 100);
    if (projectId !== undefined) {
      const { orgId, project } = requireProjectPerm(c, projectId, 'exposure');
      return c.json<LicensesResponse>(licensesView(deps(c).store, orgId, { projectId: project.id }));
    }
    const { orgId, projectIds } = visibleProjects(c, 'exposure');
    return c.json<LicensesResponse>(licensesView(deps(c).store, orgId, { projectIds }));
  });

  app.get('/api/license-policy', (c) => {
    const { orgId } = visibleProjects(c, 'exposure', 'settings');
    return c.json<LicensePolicyResponse>(getLicensePolicy(deps(c).store, orgId));
  });

  app.put('/api/license-policy', async (c) => {
    const { orgId, session } = requireOrgPerm(c, 'manage_projects');
    const body = await readJson(c);
    let policy;
    try {
      policy = parseLicensePolicy(body);
    } catch (e) {
      if (e instanceof ZodError) {
        const first = e.issues[0];
        throw badRequest(first ? `${first.path.join('.') || 'policy'}: ${first.message}` : 'Invalid licence policy', e.issues.map((i) => i.path.join('.')).filter(Boolean));
      }
      throw e;
    }
    return c.json<LicensePolicyResponse>(setLicensePolicy(deps(c).store, orgId, policy, { id: session.user.id, name: session.user.name }));
  });

  app.delete('/api/license-policy', (c) => {
    const { orgId, session } = requireOrgPerm(c, 'manage_projects');
    return c.json<LicensePolicyResponse>(setLicensePolicy(deps(c).store, orgId, null, { id: session.user.id, name: session.user.name }));
  });
}
