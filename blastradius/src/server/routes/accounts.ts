/**
 * Accounts (docs/WEB-API.md "Accounts", docs/ACCOUNT-PROOF.md): who can publish what your projects
 * depend on, "account X is compromised", and publishing-account concentration. RBAC as incidents:
 * reads follow the caller's visible projects (findings or exposure); marking an account compromised
 * opens an org-wide incident and needs `review`, like setting an incident's status.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { isAccountName } from '../../accounts/registry.js';
import { accountDetail, accountExposure, accountIncidentRef, compromiseHits, concentration } from '../accounts.js';
import { ACCOUNT_REGISTRIES, type AccountDetail, type AccountExposureResponse, type AccountRegistry, type ConcentrationResponse, type MarkCompromisedResponse } from '../api-types-accounts.js';
import { deps, requireOrgPerm, visibleProjects, type AppEnv, type Ctx } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { parseBody, queryInt, queryString } from '../request.js';
import { markAccountCompromised, resolveAccountIncidentId } from '../store/index.js';
import type { IncidentContext } from '../incidents.js';

const Iso = z.iso.datetime({ offset: true });
const CompromiseBody = z.strictObject({ since: Iso.optional() });

function accountParams(c: Ctx): { registry: AccountRegistry; name: string } {
  const registry = c.req.param('registry') ?? '';
  const name = c.req.param('name') ?? '';
  if (!(ACCOUNT_REGISTRIES as readonly string[]).includes(registry) || !isAccountName(name)) throw notFound('No such account');
  return { registry: registry as AccountRegistry, name };
}

function isoQuery(c: Ctx, key: string): string | undefined {
  const v = queryString(c, key, 40);
  if (v === undefined) return undefined;
  if (!Iso.safeParse(v).success) throw badRequest(`${key} must be an ISO date-time, e.g. 2025-09-08T13:00:00Z`, [key]);
  return new Date(v).toISOString();
}

function ctxFor(c: Ctx): IncidentContext & { userId: string; userName: string } {
  const { orgId, projectIds, session } = visibleProjects(c, 'findings', 'exposure');
  return { store: deps(c).store, orgId, projectIds, userId: session.user.id, userName: session.user.name };
}

/** Narrow to ?projects=a,b (only projects the caller may see). */
function scoped(c: Ctx, ctx: IncidentContext): IncidentContext {
  const raw = queryString(c, 'projects', 2000);
  if (!raw) return ctx;
  const want = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return { ...ctx, projectIds: ctx.projectIds ? want.filter((id) => ctx.projectIds!.includes(id)) : want };
}

export function registerAccountRoutes(app: Hono<AppEnv>): void {
  app.get('/api/accounts/concentration', (c) => {
    const ctx = scoped(c, ctxFor(c));
    const limit = queryInt(c, 'limit', 1, 50);
    return c.json<ConcentrationResponse>(concentration(ctx, limit !== undefined ? { limit } : {}));
  });

  app.get('/api/accounts/:registry/:name', (c) => {
    const { registry, name } = accountParams(c);
    const ctx = ctxFor(c);
    // Stored data only; a missing or old listing is refreshed in the background, at most once per
    // account per interval (AccountIndexer.refreshAccountSoon), never on this request.
    if (registry === 'npm') deps(c).accounts.refreshAccountSoon(name);
    return c.json<AccountDetail>(accountDetail(ctx, registry, name));
  });

  app.get('/api/accounts/:registry/:name/exposure', (c) => {
    const { registry, name } = accountParams(c);
    const ctx = scoped(c, ctxFor(c));
    const since = isoQuery(c, 'since');
    const asOf = isoQuery(c, 'asOf');
    if (since && asOf && since > asOf) throw badRequest('since must not be after asOf', ['since']);
    return c.json<AccountExposureResponse>(accountExposure(ctx, registry, name, { ...(since ? { since } : {}), ...(asOf ? { asOf } : {}) }));
  });

  app.post('/api/accounts/:registry/:name/compromise', async (c) => {
    const { registry, name } = accountParams(c);
    ctxFor(c);
    const { orgId, session } = requireOrgPerm(c, 'review');
    const body = await parseBody(c, CompromiseBody);
    const since = body.since ? new Date(body.since).toISOString() : undefined;
    const { store, accounts, watcher } = deps(c);
    // Stored data. Only an account never fetched waits, for its one listing request; packuments and
    // stale data refresh in the background.
    if (registry === 'npm') await accounts.ensureListing(name);
    // The incident is org-wide: every project, whatever the caller's project grants. Dependency
    // graphs are built once, here.
    const ctx: IncidentContext = { store, orgId, projectIds: null };
    const exposure = accountExposure(ctx, registry, name, since ? { since } : {});
    if (exposure.counts.exposures === 0 && !exposure.incident) return c.json<MarkCompromisedResponse>({ incidentId: null, created: false, added: 0, raised: 0, exposure });
    const incidentId = resolveAccountIncidentId(store, orgId, registry, name);
    const recorded = await watcher.recordAll(orgId, compromiseHits(ctx, incidentId, exposure));
    const marked = markAccountCompromised(
      store,
      orgId,
      { registry, account: name, since: since ?? null, exposures: exposure.counts.exposures, projects: exposure.counts.projects, production: exposure.counts.production, packages: exposure.counts.packages },
      { id: session.user.id, name: session.user.name },
    );
    return c.json<MarkCompromisedResponse>(
      { incidentId: marked.incidentId, created: marked.created, added: recorded.created.length, raised: recorded.raised.length, exposure: { ...exposure, incident: accountIncidentRef(ctx, registry, name) } },
      marked.created ? 201 : 200,
    );
  });
}
