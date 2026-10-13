/**
 * Org-wide triage (docs/WEB-API.md): the findings list across projects, grouping by package,
 * owners, bulk changes with RBAC, accepted risk with a reason and expiry, and the Overview numbers.
 * Scans are stored directly from synthetic results: no scanning, no network.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  BulkUpdateFindingsResponse,
  FindingDetail,
  FindingRow,
  ListAssigneesResponse,
  ListAuditResponse,
  ListOrgFindingsResponse,
  ListPackageFindingsResponse,
  OverviewResponse,
} from './api-types.js';
import { createServer } from './serve.js';
import { completeScan, createBinding, createProject, enqueueScan, failScan, recordAlerts, seedDev, type Store } from './store/index.js';
import { makeInventory, makeResult, type FindingSpec } from './store/testing.js';
import type { Asset } from '../core/types.js';

type App = ReturnType<typeof createServer>;
const XRW = { 'X-Requested-With': 'blastradius' };

let srv: App;
let store: Store;
let orgId = '';
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

async function call(method: string, path: string, opts: { as?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? XRW : {}) };
  if (opts.as) headers.Cookie = `br_session=${tokens[opts.as]}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return srv.app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}
const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;

const PROD: Asset[] = [{ id: 'repo:app', kind: 'repo', name: 'app', environment: 'prod', criticality: 5, sourceFile: 'package.json' }];
const DEV: Asset[] = [{ id: 'repo:app', kind: 'repo', name: 'app', environment: 'dev', criticality: 3, sourceFile: 'package.json' }];

function scan(projectId: string, specs: FindingSpec[], assets: Asset[]) {
  const q = enqueueScan(store, orgId, projectId, { requestedBy: users.admin! });
  completeScan(store, q.id, { result: makeResult(specs), inventory: makeInventory(assets) });
}

beforeAll(async () => {
  srv = createServer({ devMode: true, webDir: null, offline: true, log: () => {} });
  store = srv.store;
  const seed = await seedDev(store, { devMode: true, password: 'blastradius-dev' });
  orgId = seed.org.id;
  for (const u of seed.users) users[u.role === 'org_admin' ? 'admin' : u.role] = u.id;
  const admin = users.admin!;
  const api = createProject(store, orgId, { name: 'api', tier: 'Small', target: '/srv/api' }, admin);
  const web = createProject(store, orgId, { name: 'web', tier: 'Small', target: '/srv/web' }, admin);
  const broken = createProject(store, orgId, { name: 'broken', tier: 'Small', target: '/srv/broken' }, admin);
  ids.api = api.id;
  ids.web = web.id;
  ids.broken = broken.id;
  scan(api.id, [
    { name: 'event-stream', version: '3.3.6', score: 95, factors: ['malware'] },
    { name: 'minimist', version: '1.2.5', score: 70, factors: ['vuln'] },
  ], PROD);
  scan(web.id, [
    { name: 'minimist', version: '1.2.5', score: 70, factors: ['vuln'] },
    { name: 'left-pad', version: '1.3.0', score: 30, factors: ['abandoned'] },
  ], DEV);
  failScan(store, enqueueScan(store, orgId, broken.id, { requestedBy: admin }).id, 'GitHub returned 404 for package-lock.json');
  // The Developer triages only in "web" (their project-scope grant).
  createBinding(store, orgId, { roleId: 'developer', subject: { kind: 'user', userId: users.developer! }, scope: { kind: 'project', projectId: web.id } }, admin);
  for (const role of ['admin', 'appsec', 'developer', 'auditor']) {
    const res = await call('POST', '/api/auth/login', { body: { email: `${role}@local`, password: 'blastradius-dev' } });
    expect(res.status).toBe(200);
    tokens[role] = /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  }
});

async function orgList(q = '', as = 'appsec'): Promise<ListOrgFindingsResponse> {
  const res = await call('GET', `/api/findings${q ? `?${q}` : ''}`, { as });
  expect(res.status, q).toBe(200);
  return (await res.json()) as ListOrgFindingsResponse;
}

describe('GET /api/findings without a project', () => {
  it('lists every visible project, worst first, with project, spread and introducer', async () => {
    const all = await orgList();
    expect(all.total).toBe(4);
    expect(all.scannedProjects).toBe(2);
    expect(all.items[0]).toMatchObject({ name: 'event-stream', projectName: 'api', status: 'new', owner: null, introducedBy: { direct: true, via: [] } });
    const mini = all.items.filter((r) => r.name === 'minimist');
    expect(mini).toHaveLength(2);
    expect(mini.every((r) => r.spread.projects === 2 && r.spread.prodProjects === 1)).toBe(true);
  });

  it('filters by projects, env, level, status, owner, since and text (OR within, AND across)', async () => {
    expect((await orgList(`projects=${ids.web}`)).items.map((r) => r.name).sort()).toEqual(['left-pad', 'minimist']);
    expect((await orgList('env=prod')).items.every((r) => r.projectName === 'api')).toBe(true);
    expect((await orgList('env=dev')).items.every((r) => r.projectName === 'web')).toBe(true);
    expect((await orgList('level=critical,medium')).items.map((r) => r.name).sort()).toEqual(['event-stream', 'left-pad']);
    expect((await orgList('level=high&env=prod')).items.map((r) => r.name)).toEqual(['minimist']);
    expect((await orgList('owner=none')).total).toBe(4);
    expect((await orgList('since=2999-01-01T00:00:00Z')).total).toBe(0);
    expect((await orgList('q=left')).items.map((r) => r.name)).toEqual(['left-pad']);
    expect((await orgList('sort=name')).items.map((r) => r.name)[0]).toBe('event-stream');
    expect((await orgList('limit=1')).nextCursor).not.toBeNull();
    for (const bad of ['sort=bogus', 'env=staging', 'level=bogus', 'status=bogus', 'since=yesterday', 'owner=a%20b', 'projects=..%2F']) {
      expect((await call('GET', `/api/findings?${bad}`, { as: 'appsec' })).status, bad).toBe(400);
    }
  });

  it('ignores projects the caller cannot see', async () => {
    // The Auditor reads every project; a made-up id simply matches nothing.
    expect((await orgList('projects=prj_nope', 'auditor')).total).toBe(0);
  });

  it('groups by package with per-project findings, production first', async () => {
    const res = await json<ListPackageFindingsResponse>(call('GET', '/api/findings/packages', { as: 'appsec' }));
    expect(res.total).toBe(3);
    const mini = res.items.find((g) => g.name === 'minimist')!;
    expect(mini).toMatchObject({ projects: 2, prodProjects: 1, level: 'high' });
    expect(mini.findings.map((f) => [f.projectName, f.production])).toEqual([
      ['api', true],
      ['web', false],
    ]);
    const prodOnly = await json<ListPackageFindingsResponse>(call('GET', '/api/findings/packages?env=prod', { as: 'appsec' }));
    expect(prodOnly.items.find((g) => g.name === 'minimist')!.findings).toHaveLength(1);
  });
});

describe('owners and statuses', () => {
  let rows: FindingRow[] = [];
  beforeAll(async () => {
    rows = (await orgList()).items;
  });
  const row = (name: string, project: string) => rows.find((r) => r.name === name && (r as { projectName?: string }).projectName === project)!;

  it('lists assignees for anyone who reads findings', async () => {
    const res = await json<ListAssigneesResponse>(call('GET', '/api/assignees', { as: 'auditor' }));
    expect(res.items.map((p) => p.name)).toEqual(expect.arrayContaining(['Dev Admin', 'Dev AppSec', 'Dev Developer']));
  });

  it('assigns an owner with PATCH (review), and filters by owner', async () => {
    const f = row('minimist', 'api');
    const res = await call('PATCH', `/api/findings/${f.id}`, { as: 'appsec', body: { ownerId: users.developer } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as FindingRow).owner).toEqual({ id: users.developer, name: 'Dev Developer' });
    expect((await orgList(`owner=${users.developer}`)).items.map((r) => r.id)).toEqual([f.id]);
    expect((await orgList(`owner=none,${users.developer}`)).total).toBe(4);
    expect((await call('PATCH', `/api/findings/${f.id}`, { as: 'appsec', body: { ownerId: 'usr_nobody' } })).status).toBe(400);
    expect((await call('PATCH', `/api/findings/${f.id}`, { as: 'appsec', body: {} })).status).toBe(400);
    expect((await call('PATCH', `/api/findings/${f.id}`, { as: 'auditor', body: { ownerId: null } })).status).toBe(403);
    // The Developer may not triage in "api".
    expect((await call('PATCH', `/api/findings/${f.id}`, { as: 'developer', body: { status: 'fixing' } })).status).toBe(403);
    const audit = await json<ListAuditResponse>(call('GET', '/api/audit', { as: 'admin' }));
    expect(audit.items.some((e) => e.action === 'finding.owner' && e.target === f.id)).toBe(true);
  });

  it('moves through fixing and resolved', async () => {
    const f = row('left-pad', 'web');
    for (const status of ['reviewed', 'fixing', 'resolved'] as const) {
      const res = await call('PATCH', `/api/findings/${f.id}`, { as: 'developer', body: { status } });
      expect(res.status, status).toBe(200);
    }
    const detail = await json<FindingDetail>(call('GET', `/api/findings/${f.id}`, { as: 'appsec' }));
    expect(detail.status).toBe('resolved');
    expect(detail.statusHistory.map((h) => h.to)).toEqual(['resolved', 'fixing', 'reviewed']);
    expect(detail.statusHistory[0]!.byName).toBe('Dev Developer');
    expect(detail).toMatchObject({ projectName: 'web', spread: { projects: 1, prodProjects: 0 }, introducedBy: { direct: true }, alerts: [] });
  });

  it('bulk: all or nothing, 404 before 403, accepted risk needs a reason and an expiry', async () => {
    const all = (await orgList()).items;
    const api = all.filter((r) => r.projectName === 'api').map((r) => r.id);
    const web = all.filter((r) => r.projectName === 'web').map((r) => r.id);
    expect((await call('POST', '/api/findings/bulk', { as: 'appsec', body: { ids: [...api, 'fnd_missing'], status: 'reviewed' } })).status).toBe(404);
    // The Developer can triage web but not api: nothing changes.
    expect((await call('POST', '/api/findings/bulk', { as: 'developer', body: { ids: [...web, ...api], status: 'fixing' } })).status).toBe(403);
    expect((await orgList('status=fixing')).total).toBe(0);
    expect((await call('POST', '/api/findings/bulk', { as: 'appsec', body: { ids: api } })).status).toBe(400);
    expect((await call('POST', '/api/findings/bulk', { as: 'appsec', body: { ids: [], status: 'reviewed' } })).status).toBe(400);
    const ok = await json<BulkUpdateFindingsResponse>(call('POST', '/api/findings/bulk', { as: 'appsec', body: { ids: api, status: 'reviewed', ownerId: users.appsec } }));
    expect(ok.updated).toBe(2);
    expect(ok.items.every((r) => r.status === 'reviewed' && r.owner?.id === users.appsec)).toBe(true);

    const risk = { ids: api, status: 'accepted_risk' };
    expect((await call('POST', '/api/findings/bulk', { as: 'appsec', body: risk })).status).toBe(400);
    expect((await call('POST', '/api/findings/bulk', { as: 'appsec', body: { ...risk, note: 'sandboxed', expiresAt: '2000-01-01' } })).status).toBe(400);
    expect((await call('POST', '/api/findings/bulk', { as: 'developer', body: { ids: web, status: 'accepted_risk', note: 'x', expiresAt: '2999-01-01' } })).status).toBe(403);
    const accepted = await json<BulkUpdateFindingsResponse>(call('POST', '/api/findings/bulk', { as: 'appsec', body: { ...risk, note: 'sandboxed', expiresAt: '2999-01-01' } }));
    expect(accepted.items.every((r) => r.status === 'accepted_risk' && r.riskExpiresAt === '2999-01-01T00:00:00.000Z')).toBe(true);
    const detail = await json<FindingDetail>(call('GET', `/api/findings/${api[0]}`, { as: 'appsec' }));
    expect(detail.statusHistory[0]!.note).toBe('sandboxed (until 2999-01-01)');
    // Reassigning an accepted risk needs only review; changing its status needs accept_risk.
    expect((await call('POST', '/api/findings/bulk', { as: 'admin', body: { ids: api, ownerId: null } })).status).toBe(200);
  });
});

describe('GET /api/overview', () => {
  it('counts what needs attention from the latest scans, honestly', async () => {
    recordAlerts(store, orgId, [
      { projectId: ids.api!, projectName: 'api', scanId: null, purl: 'pkg:npm/minimist@1.2.5', advisoryId: 'GHSA-test', advisoryPublished: null, production: true, reachText: 'used by app (production)' } as never,
      { projectId: ids.web!, projectName: 'web', scanId: null, purl: 'pkg:npm/minimist@1.2.5', advisoryId: 'GHSA-test', advisoryPublished: null, production: false, reachText: 'used by app' } as never,
    ]);
    const o = await json<OverviewResponse>(call('GET', '/api/overview', { as: 'appsec' }));
    expect(o.projects).toBe(3);
    expect(o.scannedProjects).toBe(2);
    expect(o.attention.sourcesToCheck).toEqual([{ projectId: ids.broken, projectName: 'broken', problem: 'failed', detail: 'GitHub returned 404 for package-lock.json' }]);
    // Open = new, reviewed or fixing: the api rows were accepted, left-pad resolved, so only web's minimist is open.
    expect(o.bySeverity.find((b) => b.level === 'high')).toMatchObject({ open: 1, newInRange: 1 });
    expect(o.attention).toMatchObject({ criticalOpen: 0, highUnassigned: 1, newThisWeek: 1, newThisWeekProjects: 1 });
    expect(o.topPackages[0]).toMatchObject({ name: 'minimist', version: '1.2.5', projects: 1, prodProjects: 0 });
    expect(o.incident).toMatchObject({ advisoryId: 'GHSA-test', name: 'minimist', version: '1.2.5', projects: 2, production: 1 });
    const prod = await json<OverviewResponse>(call('GET', `/api/overview?env=prod&range=all&projects=${ids.api}`, { as: 'appsec' }));
    expect(prod.since).toBeNull();
    expect(prod.bySeverity.every((b) => b.newInRange === null && b.open === 0)).toBe(true);
    expect((await call('GET', '/api/overview?range=1y', { as: 'appsec' })).status).toBe(400);
  });
});
