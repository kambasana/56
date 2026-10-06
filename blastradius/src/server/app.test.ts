/**
 * API route tests through Hono's app.request(): auth, CSRF, RBAC denials, the scan lifecycle on
 * the offline e2e fixture, reports, graphs, and path traversal rejection. No port, no network.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import type {
  ChangesResponse,
  FindingDetail,
  GraphResponse,
  InvestigateNodeResponse,
  InvestigateSearchResponse,
  ListAuditResponse,
  ListFindingsResponse,
  ListReportsResponse,
  MeResponse,
  OrgHomeResponse,
  Project,
  Scan,
} from './api-types.js';
import { createServer, E2E_REPO_DIR, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from './serve.js';
import { createOrg, createProject, createUser, enqueueScan, seedDev, type Store } from './store/index.js';

function offlineHttp(): HttpClient {
  return new HttpClient({
    offline: true,
    fixturesDir: FIXTURES_DIR,
    cacheDir: false,
    minIntervalMs: 0,
    transport: async (req) => {
      throw new Error(`network access attempted in test: ${req.url}`);
    },
  });
}

type App = ReturnType<typeof createServer>;

const tmp = mkdtempSync(join(tmpdir(), 'br-server-'));
const webDir = join(tmp, 'web');
const scanRoot = join(tmp, 'root');
const outside = join(tmp, 'outside');

let srv: App;
let store: Store;
let seededProjectId: string;
const cookies: Record<string, string> = {};

const XRW = { 'X-Requested-With': 'blastradius' };

async function call(
  method: string,
  path: string,
  opts: { as?: string; body?: unknown; headers?: Record<string, string>; app?: App } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? XRW : {}), ...(opts.headers ?? {}) };
  if (opts.as) headers.Cookie = `br_session=${cookies[opts.as]}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return (opts.app ?? srv).app.request(path, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
  });
}

async function login(email: string, app: App = srv): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { email, password: 'blastradius-dev' }, app });
  expect(res.status).toBe(200);
  const set = res.headers.get('set-cookie') ?? '';
  const m = /br_session=([^;]+)/.exec(set);
  expect(m).not.toBeNull();
  return m![1]!;
}

beforeAll(async () => {
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Blastradius</title><div id="root"></div>');
  writeFileSync(join(webDir, 'assets', 'app-abc.js'), 'console.log(1)');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  symlinkSync(join(outside, 'secret.txt'), join(webDir, 'leak.txt'));
  mkdirSync(scanRoot, { recursive: true });
  cpSync(E2E_REPO_DIR, join(scanRoot, 'app'), { recursive: true });
  symlinkSync(outside, join(scanRoot, 'escape'));

  srv = createServer({
    devMode: true,
    localRoots: [scanRoot],
    offline: true,
    fixturesDir: FIXTURES_DIR,
    asOf: FIXTURE_AS_OF,
    webDir,
    scanOptions: { http: offlineHttp(), cacheDir: false },
    log: () => {},
  });
  store = srv.store;
  const seed = await seedDevData(srv.deps);
  seededProjectId = seed.projectId;
  expect(seed.scanId).not.toBeNull();
  await srv.jobs.waitFor(seed.scanId!);
  for (const u of ['admin', 'appsec', 'developer', 'auditor']) cookies[u] = await login(`${u}@local`);
}, 60_000);

afterAll(() => {
  srv.jobs.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('auth and CSRF', () => {
  it('serves health without a session', async () => {
    const res = await call('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('answers 401 without a session', async () => {
    const res = await call('GET', '/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Sign in required' } });
  });

  it('rejects a wrong password with 401 and a missing CSRF header with 403', async () => {
    expect((await call('POST', '/api/auth/login', { body: { email: 'admin@local', password: 'nope' } })).status).toBe(401);
    const noHeader = await srv.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@local', password: 'blastradius-dev' }),
    });
    expect(noHeader.status).toBe(403);
    expect(((await noHeader.json()) as { error: { code: string } }).error.code).toBe('csrf');
  });

  it('rejects a cross-origin mutation', async () => {
    const res = await call('POST', '/api/auth/logout', { as: 'admin', headers: { Origin: 'https://evil.example', Host: 'localhost' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('csrf');
  });

  it('sets an HttpOnly SameSite=Strict cookie, Secure off loopback', async () => {
    const local = await srv.app.request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { ...XRW, 'Content-Type': 'application/json', Host: 'localhost:8000' },
      body: JSON.stringify({ email: 'auditor@local', password: 'blastradius-dev' }),
    });
    const c1 = local.headers.get('set-cookie') ?? '';
    expect(c1).toMatch(/HttpOnly/);
    expect(c1).toMatch(/SameSite=Strict/);
    expect(c1).toMatch(/Path=\//);
    expect(c1).toMatch(/Max-Age=43200/);
    expect(c1).not.toMatch(/Secure/);
    const remote = await srv.app.request('http://br.example.com/api/auth/login', {
      method: 'POST',
      headers: { ...XRW, 'Content-Type': 'application/json', Host: 'br.example.com' },
      body: JSON.stringify({ email: 'auditor@local', password: 'blastradius-dev' }),
    });
    expect(remote.headers.get('set-cookie') ?? '').toMatch(/Secure/);
  });

  it('rate-limits repeated failed logins', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call('POST', '/api/auth/login', { body: { email: 'nobody@local', password: 'x' } })).status;
    expect(last).toBe(429);
  });

  it('returns /api/me with permissions and dev users', async () => {
    const me = (await (await call('GET', '/api/me', { as: 'auditor' })).json()) as MeResponse;
    expect(me.user.email).toBe('auditor@local');
    expect(me.permissions).toEqual(['reports']);
    expect(me.devMode).toBe(true);
    expect(me.devUsers?.map((u) => u.email).sort()).toEqual(['admin@local', 'appsec@local', 'auditor@local', 'developer@local']);
  });

  it('logs out and invalidates the session', async () => {
    const token = await login('developer@local');
    const res = await srv.app.request('/api/auth/logout', { method: 'POST', headers: { ...XRW, Cookie: `br_session=${token}` } });
    expect(res.status).toBe(200);
    expect((await srv.app.request('/api/me', { headers: { Cookie: `br_session=${token}` } })).status).toBe(401);
  });

  it('switches users in dev mode with server-side permissions', async () => {
    const token = await login('admin@local');
    const me = (await call('GET', '/api/me', { headers: { Cookie: `br_session=${token}` } }).then((r) => r.json())) as MeResponse;
    const auditor = me.devUsers!.find((u) => u.email === 'auditor@local')!;
    const sw = await srv.app.request('/api/dev/switch-user', {
      method: 'POST',
      headers: { ...XRW, 'Content-Type': 'application/json', Cookie: `br_session=${token}` },
      body: JSON.stringify({ userId: auditor.id }),
    });
    expect(sw.status).toBe(200);
    expect(((await sw.json()) as MeResponse).user.email).toBe('auditor@local');
    expect((await srv.app.request('/api/home', { headers: { Cookie: `br_session=${token}` } })).status).toBe(403);
  });
});

describe('RBAC', () => {
  it('auditor cannot read findings but can list reports', async () => {
    const res = await call('GET', `/api/findings?project=${seededProjectId}`, { as: 'auditor' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    expect((await call('GET', '/api/reports', { as: 'auditor' })).status).toBe(200);
    expect((await call('GET', '/api/home', { as: 'auditor' })).status).toBe(403);
  });

  it('developer cannot access settings endpoints or run scans', async () => {
    for (const path of ['/api/roles', '/api/bindings', '/api/members', '/api/audit']) {
      expect((await call('GET', path, { as: 'developer' })).status, path).toBe(403);
    }
    expect((await call('PATCH', '/api/roles/appsec', { as: 'developer', body: { permissions: ['settings'] } })).status).toBe(403);
    expect((await call('POST', `/api/projects/${seededProjectId}/scans`, { as: 'developer', body: {} })).status).toBe(403);
    expect((await call('GET', `/api/findings?project=${seededProjectId}`, { as: 'developer' })).status).toBe(200);
  });

  it('developer cannot change a finding status without the review action', async () => {
    const list = (await (await call('GET', `/api/findings?project=${seededProjectId}`, { as: 'developer' })).json()) as ListFindingsResponse;
    const res = await call('PATCH', `/api/findings/${list.items[0]!.id}`, { as: 'developer', body: { status: 'reviewed' } });
    expect(res.status).toBe(403);
  });

  it('project-scope bindings grant access to that project only', async () => {
    const u = createUser(store, { email: 'scoped@local', name: 'Scoped', password: 'blastradius-dev' });
    const res = await call('POST', '/api/bindings', {
      as: 'admin',
      body: { roleId: 'developer', subject: { kind: 'user', userId: u.id }, scope: { kind: 'project', projectId: seededProjectId } },
    });
    expect(res.status).toBe(201);
    cookies.scoped = await login('scoped@local');
    expect((await call('GET', `/api/findings?project=${seededProjectId}`, { as: 'scoped' })).status).toBe(200);
    const projects = (await (await call('GET', '/api/projects', { as: 'scoped' })).json()) as { items: Project[] };
    expect(projects.items.map((p) => p.id)).toEqual([seededProjectId]);
    expect((await call('GET', '/api/roles', { as: 'scoped' })).status).toBe(403);
  });

  it('never confirms another org’s data (404, not 403)', async () => {
    const other = createUser(store, { email: 'other@corp', name: 'Other', password: 'blastradius-dev' });
    const org = createOrg(store, { name: 'Other Corp' }, other.id);
    const p = createProject(store, org.id, { name: 'secret-project', tier: 'Small', target: join(scanRoot, 'app') }, other.id);
    const scan = enqueueScan(store, org.id, p.id, { requestedBy: other.id, offline: true });
    expect((await call('GET', `/api/projects/${p.id}`, { as: 'admin' })).status).toBe(404);
    expect((await call('GET', `/api/findings?project=${p.id}`, { as: 'admin' })).status).toBe(404);
    expect((await call('GET', `/api/scans/${scan.id}`, { as: 'admin' })).status).toBe(404);
    expect((await call('GET', `/api/reports/${scan.id}.json`, { as: 'admin' })).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${p.id}`, { as: 'admin' })).status).toBe(404);
    // Leave no queued scan behind for the runner.
    srv.jobs.kick();
    await srv.jobs.waitFor(scan.id);
  });
});

describe('seeded fixture scan and read endpoints', () => {
  let findings: ListFindingsResponse;

  it('home shows the seeded project with counts', async () => {
    const home = (await (await call('GET', '/api/home', { as: 'appsec' })).json()) as OrgHomeResponse;
    const row = home.projects.find((p) => p.id === seededProjectId)!;
    expect(row.name).toBe('payments-platform');
    expect(row.lastScan?.status).toBe('succeeded');
    expect(row.counts.critical).toBeGreaterThanOrEqual(2);
  });

  it('lists findings with event-stream critical, filtered and sorted', async () => {
    findings = (await (await call('GET', `/api/findings?project=${seededProjectId}&level=critical&sort=-score`, { as: 'appsec' })).json()) as ListFindingsResponse;
    const names = findings.items.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['event-stream', 'flatmap-stream']));
    expect(findings.items.every((f) => f.level === 'critical')).toBe(true);
    expect((await call('GET', `/api/findings?project=${seededProjectId}&sort=bogus`, { as: 'appsec' })).status).toBe(400);
    expect((await call('GET', `/api/findings?project=${seededProjectId}&level=bogus`, { as: 'appsec' })).status).toBe(400);
    expect((await call('GET', '/api/findings', { as: 'appsec' })).status).toBe(400);
  });

  it('returns finding detail, graph and investigate data', async () => {
    const es = findings.items.find((f) => f.name === 'event-stream')!;
    const detail = (await (await call('GET', `/api/findings/${es.id}`, { as: 'appsec' })).json()) as FindingDetail;
    expect(detail.reasons[0]!.factor).toBe('malware');
    expect(detail.assets.length).toBeGreaterThan(0);

    const graph = (await (await call('GET', `/api/graph?finding=${es.id}`, { as: 'appsec' })).json()) as GraphResponse;
    expect(graph.centre).toBe(es.purl);
    expect(graph.nodes.some((n) => n.kind === 'asset')).toBe(true);
    expect(graph.nodes.some((n) => n.kind === 'incident')).toBe(true);
    expect(graph.cap).toBe(60);

    const search = (await (await call('GET', `/api/investigate/search?project=${seededProjectId}&q=flatmap`, { as: 'appsec' })).json()) as InvestigateSearchResponse;
    expect(search.items.some((i) => i.kind === 'component' && i.id.includes('flatmap-stream'))).toBe(true);

    const incident = detail.entityChain.find((l) => l.relation === 'incident')!;
    const node = (await (await call('GET', `/api/investigate/node?project=${seededProjectId}&id=${encodeURIComponent(incident.entityId)}`, { as: 'appsec' })).json()) as InvestigateNodeResponse;
    expect(node.kind).toBe('incident');
    expect(node.appearances.some((a) => a.findingId === es.id)).toBe(true);

    const ng = await call('GET', `/api/graph?project=${seededProjectId}&node=${encodeURIComponent(incident.entityId)}`, { as: 'appsec' });
    expect(ng.status).toBe(200);
    expect((await call('GET', `/api/graph?project=${seededProjectId}&node=pkg%3Anpm%2Fnope`, { as: 'appsec' })).status).toBe(404);
  });

  it('caps graphs at the tier graphNodeCap with group nodes', async () => {
    const es = findings.items.find((f) => f.name === 'event-stream')!;
    expect((await call('PATCH', `/api/projects/${seededProjectId}`, { as: 'admin', body: { tierOverrides: { graphNodeCap: 10 } } })).status).toBe(200);
    const g = (await (await call('GET', `/api/graph?finding=${es.id}`, { as: 'appsec' })).json()) as GraphResponse;
    expect(g.cap).toBe(10);
    expect(g.nodes.length).toBeLessThanOrEqual(10);
    await call('PATCH', `/api/projects/${seededProjectId}`, { as: 'admin', body: { tierOverrides: {} } });
  });

  it('serves exposure, changes and integrations', async () => {
    const ex = await call('GET', `/api/exposure?project=${seededProjectId}`, { as: 'appsec' });
    expect(ex.status).toBe(200);
    expect(((await ex.json()) as { axis: string }).axis).toBe('asset');
    const org = await call('GET', '/api/exposure', { as: 'appsec' });
    expect(((await org.json()) as { axis: string }).axis).toBe('project');
    const ch = (await (await call('GET', `/api/changes?project=${seededProjectId}`, { as: 'appsec' })).json()) as ChangesResponse;
    expect(ch.counts.new_finding).toBeGreaterThan(0);
    const integ = await call('GET', '/api/integrations', { as: 'appsec' });
    expect(integ.status).toBe(200);
    expect(JSON.stringify(await integ.json())).not.toMatch(/gh[pousr]_/);
  });

  it('lists and downloads reports with the right headers', async () => {
    const list = (await (await call('GET', '/api/reports', { as: 'auditor' })).json()) as ListReportsResponse;
    const row = list.items.find((r) => r.project.id === seededProjectId)!;
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    const html = await call('GET', row.downloads.html, { as: 'auditor' });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toMatch(/^text\/html/);
    expect(html.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(html.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    const json = await call('GET', row.downloads.json, { as: 'auditor' });
    expect(json.headers.get('content-type')).toMatch(/^application\/json/);
    const sarif = await call('GET', row.downloads.sarif, { as: 'auditor' });
    expect(((await sarif.json()) as { version: string }).version).toBe('2.1.0');
    expect((await call('GET', `/api/reports/${row.scanId}.exe`, { as: 'auditor' })).status).toBe(404);
    expect((await call('GET', '/api/reports/..%2F..%2Fetc.json', { as: 'auditor' })).status).toBe(404);
    expect((await call('GET', row.downloads.html, { as: 'developer' })).status).toBe(200);
  });
});

describe('scan lifecycle', () => {
  let project: Project;

  it('creates a project on a local path under the scan root', async () => {
    const res = await call('POST', '/api/projects', { as: 'admin', body: { name: 'web-app', tier: 'Small', target: 'app' } });
    expect(res.status).toBe(201);
    project = (await res.json()) as Project;
    expect(project.target).toMatch(/[\\/]app$/);
  });

  it('queues, refuses a second scan with 409, and completes', async () => {
    const first = await call('POST', `/api/projects/${project.id}/scans`, { as: 'admin', body: {} });
    expect(first.status).toBe(202);
    const scan = (await first.json()) as Scan;
    expect(['queued', 'running']).toContain(scan.status);
    const second = await call('POST', `/api/projects/${project.id}/scans`, { as: 'admin', body: {} });
    expect(second.status).toBe(409);
    await srv.jobs.waitFor(scan.id);
    const done = (await (await call('GET', `/api/scans/${scan.id}`, { as: 'admin' })).json()) as Scan;
    expect(done.status).toBe('succeeded');
    expect(done.offline).toBe(true);
    expect(done.summary?.counts.critical).toBeGreaterThanOrEqual(2);
    const list = (await (await call('GET', `/api/projects/${project.id}/scans`, { as: 'developer' })).json()) as { items: Scan[] };
    expect(list.items[0]!.id).toBe(scan.id);
  });

  it('a second scan diffs against the first', async () => {
    const res = await call('POST', `/api/projects/${project.id}/scans`, { as: 'admin', body: {} });
    const scan = (await res.json()) as Scan;
    await srv.jobs.waitFor(scan.id);
    const ch = (await (await call('GET', `/api/changes?project=${project.id}`, { as: 'appsec' })).json()) as ChangesResponse;
    expect(ch.fromScan).not.toBeNull();
    expect(ch.counts.new_finding).toBe(0);
  });

  it('updates a finding status with an audit entry', async () => {
    const list = (await (await call('GET', `/api/findings?project=${project.id}`, { as: 'admin' })).json()) as ListFindingsResponse;
    const f = list.items[0]!;
    const res = await call('PATCH', `/api/findings/${f.id}`, { as: 'admin', body: { status: 'accepted_risk', note: 'compensating control' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('accepted_risk');
    const audit = (await (await call('GET', '/api/audit', { as: 'admin' })).json()) as ListAuditResponse;
    const actions = audit.items.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['finding.status', 'scan.create', 'project.create', 'binding.create']));
  });

  it('validates bodies: malformed JSON, unknown fields, bad tier', async () => {
    expect((await call('POST', '/api/projects', { as: 'admin', body: '{nope' })).status).toBe(400);
    const unknown = await call('POST', '/api/projects', { as: 'admin', body: { name: 'x', tier: 'Small', target: 'app', extra: 1 } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { fields: string[] } }).error.fields).toContain('extra');
    expect((await call('POST', '/api/projects', { as: 'admin', body: { name: 'x', tier: 'Huge', target: 'app' } })).status).toBe(400);
    expect((await call('POST', '/api/projects', { as: 'admin', body: { name: 'web-app', tier: 'Small', target: 'app' } })).status).toBe(409);
  });

  it('deletes a project', async () => {
    const res = await call('POST', '/api/projects', { as: 'admin', body: { name: 'to-delete', tier: 'Small', target: 'app' } });
    const p = (await res.json()) as Project;
    expect((await call('DELETE', `/api/projects/${p.id}`, { as: 'admin' })).status).toBe(200);
    expect((await call('GET', `/api/projects/${p.id}`, { as: 'admin' })).status).toBe(404);
  });
});

describe('path traversal and target safety', () => {
  const bad = ['../../etc', '/etc', 'escape', 'escape/secret.txt', 'app/../../outside', `${scanRoot}/../outside`, 'missing-dir', 'app/package.json'];
  for (const target of bad) {
    it(`rejects local target ${JSON.stringify(target)}`, async () => {
      const res = await call('POST', '/api/projects', { as: 'admin', body: { name: `bad-${Math.random()}`, tier: 'Small', target } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { fields?: string[] } }).error.fields).toEqual(['target']);
    });
  }

  const badGit = [
    'http://github.com/a/b',
    'https://evil.example/a/b',
    'https://user:pw@github.com/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com:8443/a/b',
    'https://github.com/a',
    'https://github.com/../a/b',
    'git@github.com:a/b.git',
    'ssh://github.com/a/b',
    'file:///etc',
  ];
  for (const target of badGit) {
    it(`rejects git target ${JSON.stringify(target)}`, async () => {
      const res = await call('POST', '/api/projects', { as: 'admin', body: { name: `bad-${Math.random()}`, tier: 'Small', target } });
      expect(res.status).toBe(400);
    });
  }

  it('accepts an allow-listed https git URL, normalised', async () => {
    const res = await call('POST', '/api/projects', { as: 'admin', body: { name: 'gh', tier: 'Small', target: 'https://GitHub.com/acme/app.git/' } });
    expect(res.status).toBe(201);
    const p = (await res.json()) as Project;
    expect(p.target).toBe('https://github.com/acme/app.git');
    // This server is offline: git targets cannot be scanned offline.
    expect((await call('POST', `/api/projects/${p.id}/scans`, { as: 'admin', body: {} })).status).toBe(400);
  });

  it('serves the SPA and assets, with fallback and no traversal', async () => {
    const index = await srv.app.request('/projects/x/findings');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/^text\/html/);
    expect(index.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(await index.text()).toContain('id="root"');
    const asset = await srv.app.request('/assets/app-abc.js');
    expect(asset.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(asset.headers.get('cache-control')).toMatch(/immutable/);
    expect((await srv.app.request('/assets/missing.js')).status).toBe(404);
    expect((await srv.app.request('/leak.txt')).status).toBe(404);
    expect((await srv.app.request('/..%2f..%2fpackage.json')).status).toBe(400);
    expect((await srv.app.request('/%2e%2e/%2e%2e/package.json')).status).not.toBe(200);
    expect((await srv.app.request('/assets%5c..%5c..%5cpackage.json')).status).toBe(400);
    expect((await srv.app.request('/.env')).status).toBe(404);
    const dir = await srv.app.request('/assets');
    expect(await dir.text()).not.toContain('app-abc.js');
    expect((await srv.app.request('/api/nope')).status).toBe(404);
    expect((await srv.app.request('/', { method: 'POST' })).status).toBe(405);
  });
});

describe('git targets', () => {
  it('clones with hooks off and scans the checkout', async () => {
    const calls: string[][] = [];
    const gitSrv = createServer({
      devMode: true,
      localRoots: [scanRoot],
      asOf: FIXTURE_AS_OF,
      webDir: null,
      scanOptions: { http: offlineHttp(), cacheDir: false },
      gitRunner: async (args) => {
        calls.push(args);
        cpSync(E2E_REPO_DIR, args[args.length - 1]!, { recursive: true });
      },
      log: () => {},
    });
    await seedDev(gitSrv.store, { devMode: true });
    cookies.gitAdmin = await login('admin@local', gitSrv);
    const res = await call('POST', '/api/projects', { as: 'gitAdmin', app: gitSrv, body: { name: 'remote', tier: 'Small', target: 'https://github.com/acme/remote' } });
    const p = (await res.json()) as Project;
    expect((await call('POST', `/api/projects/${p.id}/scans`, { as: 'gitAdmin', app: gitSrv, body: { ref: '--upload-pack=x' } })).status).toBe(400);
    const scanRes = await call('POST', `/api/projects/${p.id}/scans`, { as: 'gitAdmin', app: gitSrv, body: { ref: 'main' } });
    expect(scanRes.status).toBe(202);
    const scan = (await scanRes.json()) as Scan;
    await gitSrv.jobs.waitFor(scan.id);
    const done = (await (await call('GET', `/api/scans/${scan.id}`, { as: 'gitAdmin', app: gitSrv })).json()) as Scan;
    expect(done.status).toBe('succeeded');
    const args = calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'http.followRedirects=false', '--depth', '1', '--no-recurse-submodules', '--branch', 'main']));
    expect(args.indexOf('--branch')).toBeLessThan(args.indexOf('--'));
    expect(args[args.indexOf('--') + 1]).toBe('https://github.com/acme/remote');
    const report = await call('GET', `/api/reports/${scan.id}.json`, { as: 'gitAdmin', app: gitSrv });
    const body = await report.text();
    expect(body).toContain('https://github.com/acme/remote');
    expect(body).not.toContain('blastradius-scan-');
    gitSrv.jobs.stop();
  }, 60_000);

  it('records a safe error when the clone fails', async () => {
    const failSrv = createServer({
      devMode: true,
      localRoots: [scanRoot],
      webDir: null,
      gitRunner: async () => {
        throw new Error('git clone failed: fatal: repository https://github.com/acme/missing/ not found at /tmp/blastradius-scan-xyz');
      },
      log: () => {},
    });
    await seedDev(failSrv.store, { devMode: true });
    cookies.failAdmin = await login('admin@local', failSrv);
    const res = await call('POST', '/api/projects', { as: 'failAdmin', app: failSrv, body: { name: 'missing', tier: 'Small', target: 'https://github.com/acme/missing' } });
    const p = (await res.json()) as Project;
    const scan = (await (await call('POST', `/api/projects/${p.id}/scans`, { as: 'failAdmin', app: failSrv, body: {} })).json()) as Scan;
    await failSrv.jobs.waitFor(scan.id);
    const done = (await (await call('GET', `/api/scans/${scan.id}`, { as: 'failAdmin', app: failSrv })).json()) as Scan;
    expect(done.status).toBe('failed');
    expect(done.error).toBe('Git clone failed: repository not found or not public');
    failSrv.jobs.stop();
  });
});
