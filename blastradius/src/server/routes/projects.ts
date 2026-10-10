/** /api/orgs, /api/home, /api/projects, /api/me/projects, /api/projects/:id/scans, /api/scans/:id */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  SIZE_TIERS,
  type CreateOrgResponse,
  type CreateProjectResponse,
  type CreateScanResponse,
  type GetProjectResponse,
  type GetScanResponse,
  type ListOrgsResponse,
  type SwitchOrgResponse,
  type ListProjectsResponse,
  type ListMyProjectsResponse,
  type ListScansResponse,
  type OkResponse,
  type OrgHomeResponse,
  type ProjectHealthResponse,
  type UpdateProjectResponse,
} from '../api-types.js';
import { ORG_ADMIN_ROLE_ID } from '../permissions.js';
import { nameAndVersion } from '../../report/json.js';
import { buildMe, deps, memberProjects, requireOrg, requireProjectPerm, requireSession, requireOrgPerm, visibleProjects, type AppEnv } from '../context.js';
import { ApiHttpError, badRequest, forbidden, notFound } from '../errors.js';
import { idParam, pageQuery, parseBody, queryString } from '../request.js';
import { checkGitRef, checkTarget } from '../targets.js';
import {
  countOrgs,
  decodeCursor,
  encodeCursor,
  createOrg,
  createProject,
  deleteProject,
  enqueueScan,
  getProjectRow,
  getScan,
  getScanResult,
  latestSucceededScanId,
  listOrgsForUser,
  listProjectRows,
  listProjects,
  listScans,
  orgHome,
  rolesForUser,
  setSessionOrg,
  updateProject,
  writeAudit,
} from '../store/index.js';

const SwitchOrgBody = z.strictObject({ orgId: z.string().min(1).max(100) });

const CreateOrgBody = z.strictObject({
  name: z.string().min(1).max(120),
  slug: z.string().max(40).optional(),
});

const TierOverrides = z.record(z.string(), z.unknown());

const CreateProjectBody = z.strictObject({
  name: z.string().min(1).max(120),
  tier: z.enum(SIZE_TIERS),
  target: z.string().min(1).max(2048),
  owner: z.string().max(200).nullable().optional(),
  tierOverrides: TierOverrides.optional(),
});

const UpdateProjectBody = CreateProjectBody.partial();

const CreateScanBody = z.strictObject({
  offline: z.boolean().optional(),
  ref: z.string().min(1).max(200).optional(),
});

export function registerProjectRoutes(app: Hono<AppEnv>): void {
  // ---- Orgs -------------------------------------------------------------
  app.get('/api/orgs', (c) => {
    const session = requireSession(c);
    return c.json<ListOrgsResponse>({ items: listOrgsForUser(deps(c).store, session.user.id) });
  });

  app.post('/api/orgs', async (c) => {
    const { store, config } = deps(c);
    const session = requireSession(c);
    const body = await parseBody(c, CreateOrgBody);
    const firstRun = countOrgs(store) === 0;
    const isAnyOrgAdmin = listOrgsForUser(store, session.user.id).some((o) => rolesForUser(store, o.id, session.user.id).some((r) => r.id === ORG_ADMIN_ROLE_ID));
    if (!config.devMode && !firstRun && !isAnyOrgAdmin) throw forbidden('Only an Org admin can create an organisation');
    const org = createOrg(store, { name: body.name, ...(body.slug !== undefined ? { slug: body.slug } : {}) }, session.user.id);
    // Work in the new org straight away (POST /api/session/org switches back).
    setSessionOrg(store, session.token, org.id);
    return c.json<CreateOrgResponse>(org, 201);
  });

  /** Switch the session's working org to another org the user is bound in. */
  app.post('/api/session/org', async (c) => {
    const { store } = deps(c);
    const session = requireSession(c);
    const body = await parseBody(c, SwitchOrgBody);
    if (!listOrgsForUser(store, session.user.id).some((o) => o.id === body.orgId)) throw notFound('Org not found');
    if (body.orgId !== session.orgId) {
      setSessionOrg(store, session.token, body.orgId);
      writeAudit(store, { orgId: body.orgId, actor: session.user.id, action: 'session.switch_org', target: body.orgId, detail: { fromOrgId: session.orgId, toOrgId: body.orgId } });
    }
    return c.json<SwitchOrgResponse>(buildMe(c, { ...session, orgId: body.orgId }));
  });

  // ---- Home and projects ---------------------------------------------------
  app.get('/api/home', (c) => {
    const { orgId, projectIds } = visibleProjects(c, 'home');
    return c.json<OrgHomeResponse>(orgHome(deps(c).store, orgId, projectIds));
  });

  app.get('/api/projects', (c) => {
    const { session, orgId } = requireOrg(c);
    const requested = queryString(c, 'org', 100);
    if (requested !== undefined && requested !== orgId) {
      // Only the working org is served; another org the caller is not in is simply not found.
      const member = listOrgsForUser(deps(c).store, session.user.id).some((o) => o.id === requested);
      if (!member) throw notFound('Org not found');
      throw badRequest('Switch to that organisation first', ['org']);
    }
    const { projectIds } = visibleProjects(c, 'projects', 'home');
    const rows = listProjectRows(deps(c).store, orgId, projectIds);
    const { limit = 50, cursor } = pageQuery(c);
    const offset = cursor ? decodeCursor(cursor) : 0;
    const items = rows.slice(offset, offset + limit);
    const next = offset + items.length < rows.length ? encodeCursor(offset + items.length) : null;
    return c.json<ListProjectsResponse>({ items, total: rows.length, nextCursor: next });
  });

  // Names for the nav / project switcher: any member, only projects they hold a permission in.
  app.get('/api/me/projects', (c) => {
    const { orgId, projectIds } = memberProjects(c);
    const items = listProjects(deps(c).store, orgId, projectIds).map((p) => ({ id: p.id, name: p.name }));
    return c.json<ListMyProjectsResponse>({ items });
  });

  app.post('/api/projects', async (c) => {
    const { session, orgId } = requireOrgPerm(c, 'manage_projects');
    const body = await parseBody(c, CreateProjectBody);
    const target = normalizedTarget(c.get('deps').config.localRoots, body.target);
    const p = createProject(
      deps(c).store,
      orgId,
      {
        name: body.name,
        tier: body.tier,
        target,
        ...(body.owner !== undefined ? { owner: body.owner } : {}),
        ...(body.tierOverrides !== undefined ? { tierOverrides: body.tierOverrides } : {}),
      },
      session.user.id,
    );
    return c.json<CreateProjectResponse>(p, 201);
  });

  app.get('/api/projects/:id', (c) => {
    const id = idParam(c, 'id');
    const { orgId } = requireProjectPerm(c, id, 'projects', 'home');
    const row = getProjectRow(deps(c).store, orgId, id);
    if (!row) throw notFound('Project not found');
    return c.json<GetProjectResponse>(row);
  });

  app.patch('/api/projects/:id', async (c) => {
    const id = idParam(c, 'id');
    const { session, orgId } = requireProjectPerm(c, id, 'manage_projects');
    const body = await parseBody(c, UpdateProjectBody);
    const patch = { ...body };
    if (body.target !== undefined) patch.target = normalizedTarget(deps(c).config.localRoots, body.target);
    const p = updateProject(deps(c).store, orgId, id, patch, session.user.id);
    return c.json<UpdateProjectResponse>(p);
  });

  app.delete('/api/projects/:id', (c) => {
    const id = idParam(c, 'id');
    const { session, orgId } = requireProjectPerm(c, id, 'manage_projects');
    deleteProject(deps(c).store, orgId, id, session.user.id);
    return c.json<OkResponse>({ ok: true });
  });

  // Upkeep-only signals of the newest succeeded scan (noise rule: these are not findings).
  app.get('/api/projects/:id/health', (c) => {
    const id = idParam(c, 'id');
    const { orgId } = requireProjectPerm(c, id, 'findings');
    const store = deps(c).store;
    const scanId = latestSucceededScanId(store, orgId, id);
    const stored = scanId ? getScanResult(store, orgId, scanId) : null;
    const items = (stored?.result.health ?? []).map((h) => ({
      purl: h.purl,
      ...nameAndVersion(h.purl),
      score: h.score,
      signals: h.reasons.filter((r) => r.value > 0).map((r) => ({ factor: r.factor, detail: r.detail })),
    }));
    return c.json<ProjectHealthResponse>({ scanId, items });
  });

  // ---- Scans ----------------------------------------------------------------
  app.get('/api/projects/:id/scans', (c) => {
    const id = idParam(c, 'id');
    const { orgId } = requireProjectPerm(c, id, 'scans');
    const updatedSince = queryString(c, 'updatedSince', 40);
    return c.json<ListScansResponse>(listScans(deps(c).store, orgId, id, { ...pageQuery(c), ...(updatedSince !== undefined ? { updatedSince } : {}) }));
  });

  app.post('/api/projects/:id/scans', async (c) => {
    const id = idParam(c, 'id');
    const { session, orgId, project } = requireProjectPerm(c, id, 'manage_projects');
    const body = await parseBody(c, CreateScanBody);
    const { store, jobs, config, scanLimiter } = deps(c);
    const ref = body.ref !== undefined ? checkGitRef(body.ref) : undefined;
    // Re-check the stored target against today's rules before queueing.
    const target = checkTarget(project.target, config.localRoots);
    // Fixture-repo projects under --dev-seed always replay recorded responses (see jobs.ts).
    const replay = target.kind === 'local' && jobs.replayFor(target.path) !== undefined;
    const offline = config.offline || body.offline === true || replay;
    if (target.kind === 'git' && offline) throw badRequest('Offline scans need a local target', ['offline']);
    if (target.kind === 'local' && ref !== undefined) throw badRequest('ref applies to git targets only', ['ref']);
    if (!scanLimiter.hit(session.user.id)) throw new ApiHttpError('rate_limited', 'Too many scans requested. Try again later.');
    const scan = enqueueScan(store, orgId, id, { requestedBy: session.user.id, offline });
    jobs.setOverrides(scan.id, {
      ...(ref !== undefined ? { ref } : {}),
      ...(offline && config.fixturesDir ? { fixturesDir: config.fixturesDir } : {}),
    });
    jobs.kick();
    return c.json<CreateScanResponse>(scan, 202);
  });

  app.get('/api/scans/:id', (c) => {
    const id = idParam(c, 'id');
    const { orgId } = requireOrg(c);
    const scan = getScan(deps(c).store, orgId, id);
    if (!scan) throw notFound('Scan not found');
    requireProjectPerm(c, scan.projectId, 'scans');
    return c.json<GetScanResponse>(scan);
  });
}

function normalizedTarget(roots: readonly string[], input: string): string {
  const t = checkTarget(input, roots);
  return t.kind === 'git' ? t.url : t.path;
}
