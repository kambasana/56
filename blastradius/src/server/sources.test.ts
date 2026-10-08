/**
 * GitHub App connector through the API, against a fake GitHub (throwaway key, injected fetch):
 * install with a signed single-use state, discovery into projects, fetch-only scans, webhook
 * signatures and replay, push-path filtering, install add/remove, access lost, RBAC.
 * No network: scans use recorded fixtures for the e2e fixture repo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../core/http.js';
import type { ListAuditResponse, ListSourceReposResponse, ListSourcesResponse, Scan, SourceRepo, StartSourceInstallResponse } from './api-types.js';
import { createServer, E2E_REPO_DIR, FIXTURE_AS_OF, FIXTURES_DIR } from './serve.js';
import { FakeGitHub } from './sources/testing.js';
import { createOrg, createUser, listScans, seedDev, userAccess } from './store/index.js';

vi.setConfig({ testTimeout: 60_000 });

type Srv = ReturnType<typeof createServer>;

const reason = (location: string) => new URLSearchParams(location.split('?')[1]).get('reason') ?? '';

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

const E2E_FILES = {
  'package.json': readFileSync(join(E2E_REPO_DIR, 'package.json'), 'utf8'),
  'package-lock.json': readFileSync(join(E2E_REPO_DIR, 'package-lock.json'), 'utf8'),
  'README.md': '# api',
  'src/index.js': 'module.exports = 1;\n',
};

const gh = new FakeGitHub();
let srv: Srv;
let bare: Srv;
const cookies: Record<string, string> = {};
const XRW = { 'X-Requested-With': 'blastradius' };

async function call(method: string, path: string, opts: { as?: string; body?: unknown; app?: Srv } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? XRW : {}) };
  if (opts.as) headers.Cookie = `br_session=${cookies[opts.as]}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return (opts.app ?? srv).app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}

async function login(email: string, app: Srv = srv): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { email, password: 'blastradius-dev' }, app });
  expect(res.status).toBe(200);
  return /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

async function hook(event: string, payload: unknown, opts: { secret?: string | null; id?: string; app?: Srv } = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  return (opts.app ?? srv).app.request('/api/hooks/github', { method: 'POST', headers: gh.deliveryHeaders(event, body, opts), body });
}

async function settle(app: Srv = srv): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await app.deps.sources.idle();
    await app.jobs.idle();
  }
}

async function repos(sourceId: string): Promise<SourceRepo[]> {
  const res = await call('GET', `/api/sources/${sourceId}/repos`, { as: 'admin' });
  expect(res.status).toBe(200);
  return ((await res.json()) as ListSourceReposResponse).items;
}

const byName = (list: SourceRepo[], name: string) => list.find((r) => r.fullName === name)!;

function pushPayload(repo: string, paths: string[], extra: Record<string, unknown> = {}) {
  const r = gh.repos.get(repo)!;
  return {
    ref: `refs/heads/${r.defaultBranch}`,
    after: r.refs.get(r.defaultBranch),
    repository: { id: r.id, full_name: repo, default_branch: r.defaultBranch },
    installation: { id: 77 },
    commits: [{ added: [], removed: [], modified: paths }],
    ...extra,
  };
}

/** Start an install as `who` and come back through the callback; returns the callback redirect. */
async function install(who: string, installationId: number, codeFor: number[] | null): Promise<{ location: string; start: StartSourceInstallResponse }> {
  const res = await call('POST', '/api/sources', { as: who, body: { host: 'github' } });
  expect(res.status).toBe(201);
  const start = (await res.json()) as StartSourceInstallResponse;
  const state = new URL(start.installUrl).searchParams.get('state')!;
  const q = new URLSearchParams({ installation_id: String(installationId), setup_action: 'install', state });
  if (codeFor) q.set('code', gh.issueCode(codeFor));
  const cb = await srv.app.request(`/api/sources/github/callback?${q.toString()}`);
  expect(cb.status).toBe(302);
  return { location: cb.headers.get('location')!, start };
}

let sourceId: string;

beforeAll(async () => {
  gh.addRepo('acme/api', E2E_FILES);
  gh.addRepo('acme/docs', { 'README.md': '# docs' });
  gh.addRepo('acme/yarn-app', { 'package.json': JSON.stringify({ name: 'yarn-app', dependencies: { ms: '2.1.3' } }), 'yarn.lock': '# yarn\n' });
  gh.addRepo('acme/later', E2E_FILES);
  gh.addRepo('other/secret', E2E_FILES);
  gh.addInstallation(77, 'acme', ['acme/api', 'acme/docs', 'acme/yarn-app']);
  gh.addInstallation(88, 'other', ['other/secret']);
  const common = { devMode: true, webDir: null, asOf: FIXTURE_AS_OF, scanOptions: { http: offlineHttp(), cacheDir: false as const }, log: () => {} };
  srv = createServer({ ...common, github: gh.config });
  bare = createServer({ ...common, github: null });
  await seedDev(srv.store, { devMode: true });
  await seedDev(bare.store, { devMode: true });
  for (const u of ['admin', 'appsec', 'developer', 'auditor']) cookies[u] = await login(`${u}@local`);
  cookies.bareAdmin = await login('admin@local', bare);
}, 60_000);

afterAll(() => {
  srv.jobs.stop();
  bare.jobs.stop();
});

describe('not configured', () => {
  it('lists nothing, refuses installs and hides the webhook', async () => {
    const list = (await (await call('GET', '/api/sources', { as: 'bareAdmin', app: bare })).json()) as ListSourcesResponse;
    expect(list).toEqual({ configured: { github: false }, items: [], webhooks: { rejected: 0 } });
    expect((await call('POST', '/api/sources', { as: 'bareAdmin', app: bare, body: { host: 'github' } })).status).toBe(400);
    expect((await hook('ping', { zen: 'x' }, { app: bare })).status).toBe(404);
  });
});

describe('RBAC', () => {
  it('needs a session and manage_projects for every source route', async () => {
    expect((await call('GET', '/api/sources')).status).toBe(401);
    const store = srv.store;
    const orgId = (await (await call('GET', '/api/me', { as: 'auditor' })).json() as { org: { id: string } }).org.id;
    for (const who of ['developer', 'auditor']) {
      const uid = (await (await call('GET', '/api/me', { as: who })).json() as { user: { id: string } }).user.id;
      expect(userAccess(store, orgId, uid).permissions).not.toContain('manage_projects');
      expect((await call('GET', '/api/sources', { as: who })).status).toBe(403);
      expect((await call('POST', '/api/sources', { as: who, body: { host: 'github' } })).status).toBe(403);
      expect((await call('GET', '/api/sources/src_abc/repos', { as: who })).status).toBe(403);
      expect((await call('PATCH', '/api/sources/src_abc/repos/srp_x', { as: who, body: { watching: false } })).status).toBe(403);
    }
    // Mutations still need the CSRF header like every other route.
    const noXrw = await srv.app.request('/api/sources', { method: 'POST', headers: { Cookie: `br_session=${cookies.admin}`, 'Content-Type': 'application/json' }, body: '{"host":"github"}' });
    expect(noXrw.status).toBe(403);
  });
});

describe('install', () => {
  it('refuses a callback without proof the user can see the installation', async () => {
    const noCode = await install('admin', 77, null);
    expect(noCode.location).toMatch(/^\/sources\?install=failed/);
    // Someone else's installation id with a code for a user who cannot see it.
    const forged = await install('admin', 88, [77]);
    expect(forged.location).toMatch(/install=failed/);
    expect(reason(forged.location)).toMatch(/did not confirm/);
  });

  it('connects with a signed, single-use state and discovers the repos', async () => {
    const { location, start } = await install('admin', 77, [77]);
    expect(start.installUrl).toMatch(/^https:\/\/github\.com\/apps\/blastradius-test\/installations\/new\?state=src_/);
    expect(start.source.status).toBe('pending');
    expect(location).toBe(`/sources?install=connected&source=${start.source.id}`);
    sourceId = start.source.id;

    // The same state cannot be used twice, and a tampered one is refused.
    const state = new URL(start.installUrl).searchParams.get('state')!;
    const again = await srv.app.request(`/api/sources/github/callback?installation_id=77&state=${encodeURIComponent(state)}&code=${gh.issueCode([77])}`);
    expect(again.headers.get('location')).toMatch(/install=failed/);
    const tampered = await srv.app.request(`/api/sources/github/callback?installation_id=77&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}&code=${gh.issueCode([77])}`);
    expect(tampered.headers.get('location')).toMatch(/install=failed/);

    await settle();
    const list = (await (await call('GET', '/api/sources', { as: 'admin' })).json()) as ListSourcesResponse;
    const src = list.items.find((s) => s.id === sourceId)!;
    expect(src).toMatchObject({ host: 'github', account: 'acme', installationId: '77', status: 'connected', health: null, repositorySelection: 'selected' });
    expect(JSON.stringify(list)).not.toMatch(/ghs_|PRIVATE KEY|state_hash/);

    const rs = await repos(sourceId);
    expect(rs.map((r) => r.fullName)).toEqual(['acme/api', 'acme/docs', 'acme/yarn-app']);
    const api = byName(rs, 'acme/api');
    expect(api).toMatchObject({ status: 'watching', watching: true, lockfiles: ['package-lock.json'], filesRead: ['package-lock.json', 'package.json'], defaultBranch: 'main' });
    expect(api.projectId).toMatch(/^prj_/);
    expect(api.lastScanId).toMatch(/^scan_/);
    expect(byName(rs, 'acme/docs')).toMatchObject({ status: 'no_lockfile', projectId: null, lockfiles: [] });
    expect(byName(rs, 'acme/yarn-app')).toMatchObject({ status: 'unsupported', lockfiles: ['yarn.lock'], filesRead: ['package.json'] });

    // The repo is a project like any other: its fetch-only scan succeeded at the listed commit.
    const scan = (await (await call('GET', `/api/scans/${api.lastScanId}`, { as: 'admin' })).json()) as Scan;
    expect(scan).toMatchObject({ status: 'succeeded', target: 'https://github.com/acme/api', commit: gh.repos.get('acme/api')!.refs.get('main') });
    expect(scan.summary!.inventory.components).toBeGreaterThan(0);
    const findings = await call('GET', `/api/findings?project=${api.projectId}`, { as: 'admin' });
    expect(findings.status).toBe(200);
    // Tokens were minted per operation and every one was revoked.
    expect(gh.tokensMinted).toBeGreaterThan(3);
    expect(gh.tokensRevoked).toBe(gh.tokensMinted);

    const audit = (await (await call('GET', '/api/audit?limit=200', { as: 'admin' })).json()) as ListAuditResponse;
    const actions = audit.items.map((a) => a.action);
    for (const a of ['source.install_start', 'source.connect', 'source_repo.add', 'project.create']) expect(actions).toContain(a);
  });

  it('does not let another org claim a connected installation', async () => {
    const store = srv.store;
    const other = createOrg(store, { name: 'Other Co', slug: 'other-co' }, null);
    const user = await createUser(store, { email: 'boss@other.test', name: 'Boss', password: 'a-long-password-for-tests' });
    store.db.prepare(`INSERT INTO role_binding (id, org_id, role_id, subject_kind, subject_ref, scope_kind, project_id, created_at, created_by) VALUES ('rb_other', ?, 'org_admin', 'user', ?, 'org', NULL, ?, 'test')`).run(other.id, user.id, new Date().toISOString());
    const res = await call('POST', '/api/auth/login', { body: { email: 'boss@other.test', password: 'a-long-password-for-tests' } });
    cookies.boss = /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
    const { location } = await install('boss', 77, [77]);
    expect(location).toMatch(/install=failed/);
    expect(reason(location)).toMatch(/another organisation/);
    // And cannot see the first org's source.
    expect((await call('GET', `/api/sources/${sourceId}`, { as: 'boss' })).status).toBe(404);
    expect((await call('GET', `/api/sources/${sourceId}/repos`, { as: 'boss' })).status).toBe(404);
  });
});

describe('webhooks', () => {
  it('rejects unsigned and badly signed deliveries and counts them', async () => {
    const before = srv.deps.sources.rejectedDeliveries;
    expect((await hook('push', pushPayload('acme/api', ['package-lock.json']), { secret: null })).status).toBe(401);
    expect((await hook('push', pushPayload('acme/api', ['package-lock.json']), { secret: 'not-the-webhook-secret' })).status).toBe(401);
    // Body changed after signing.
    const body = JSON.stringify(pushPayload('acme/api', ['README.md']));
    const headers = gh.deliveryHeaders('push', body);
    const res = await srv.app.request('/api/hooks/github', { method: 'POST', headers, body: body.replace('README.md', 'package.json') });
    expect(res.status).toBe(401);
    expect(srv.deps.sources.rejectedDeliveries).toBe(before + 3);
    const list = (await (await call('GET', '/api/sources', { as: 'admin' })).json()) as ListSourcesResponse;
    expect(list.webhooks.rejected).toBe(before + 3);
  });

  it('accepts a valid delivery once: a replayed delivery id is not processed again', async () => {
    const id = crypto.randomUUID();
    const first = await hook('ping', { zen: 'hello', hook_id: 1 }, { id });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, duplicate: false, outcome: 'pong' });
    const replay = await hook('ping', { zen: 'hello', hook_id: 1 }, { id });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true });
  });

  it('re-scans only when a push touches a manifest, lockfile or workflow on the default branch', async () => {
    const api = byName(await repos(sourceId), 'acme/api');
    const scansBefore = listScans(srv.store, (await (await call('GET', '/api/me', { as: 'admin' })).json() as { org: { id: string } }).org.id, api.projectId!).total;

    const skip = await hook('push', pushPayload('acme/api', ['README.md', 'src/index.js']));
    expect(await skip.json()).toMatchObject({ outcome: 'skipped_no_inventory_change' });
    const otherBranch = await hook('push', { ...pushPayload('acme/api', ['package-lock.json']), ref: 'refs/heads/feature' });
    expect(await otherBranch.json()).toMatchObject({ outcome: 'skipped_not_default_branch' });

    // A real change: new commit with an updated lockfile.
    const newSha = gh.commit('acme/api', { ...E2E_FILES, 'README.md': '# api v2' });
    const id = crypto.randomUUID();
    const scanRes = await hook('push', pushPayload('acme/api', ['package-lock.json', 'README.md']), { id });
    expect(await scanRes.json()).toMatchObject({ outcome: 'queued' });
    // GitHub redelivering the same push does not queue another scan.
    expect(await (await hook('push', pushPayload('acme/api', ['package-lock.json']), { id })).json()).toMatchObject({ duplicate: true });
    await settle();
    const orgId = ((await (await call('GET', '/api/me', { as: 'admin' })).json()) as { org: { id: string } }).org.id;
    const scans = listScans(srv.store, orgId, api.projectId!);
    expect(scans.total).toBe(scansBefore + 1);
    expect(scans.items[0]).toMatchObject({ status: 'succeeded', commit: newSha });
    const after = byName(await repos(sourceId), 'acme/api');
    expect(after).toMatchObject({ status: 'watching', lastCommit: newSha, lastDeliveryOutcome: 'queued' });
    // A workflow-only change also re-scans.
    expect(await (await hook('push', pushPayload('acme/api', ['.github/workflows/ci.yml']))).json()).toMatchObject({ outcome: 'queued' });
    await settle();
  });

  it('ignores deliveries for installations nobody connected', async () => {
    const res = await hook('push', { ...pushPayload('other/secret', ['package-lock.json']), installation: { id: 88 } });
    expect(await res.json()).toMatchObject({ outcome: 'unknown_installation' });
  });
});

describe('installation changes', () => {
  it('discovers and scans a repo added to the installation, and keeps history of a removed one', async () => {
    gh.installations.get(77)!.repos.add('acme/later');
    gh.installations.get(77)!.repos.delete('acme/docs');
    const later = gh.repos.get('acme/later')!;
    const docs = gh.repos.get('acme/docs')!;
    const res = await hook('installation_repositories', {
      action: 'added',
      installation: { id: 77 },
      repository_selection: 'selected',
      repositories_added: [{ id: later.id, full_name: 'acme/later', private: true }],
      repositories_removed: [{ id: docs.id, full_name: 'acme/docs' }],
    });
    expect(await res.json()).toMatchObject({ outcome: 'repos_added:1,removed:1' });
    await settle();
    const rs = await repos(sourceId);
    expect(byName(rs, 'acme/later')).toMatchObject({ status: 'watching', watching: true, lockfiles: ['package-lock.json'] });
    expect(byName(rs, 'acme/later').projectId).toMatch(/^prj_/);
    expect(byName(rs, 'acme/docs')).toMatchObject({ status: 'removed', watching: false });
    const scan = (await (await call('GET', `/api/scans/${byName(rs, 'acme/later').lastScanId}`, { as: 'admin' })).json()) as Scan;
    expect(scan.status).toBe('succeeded');
  });

  it('watching off skips pushes; on again re-inspects', async () => {
    const api = byName(await repos(sourceId), 'acme/api');
    const off = await call('PATCH', `/api/sources/${sourceId}/repos/${api.id}`, { as: 'admin', body: { watching: false } });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ watching: false, status: 'not_watched' });
    expect(await (await hook('push', pushPayload('acme/api', ['package-lock.json']))).json()).toMatchObject({ outcome: 'skipped_not_watched' });
    const on = await call('PATCH', `/api/sources/${sourceId}/repos/${api.id}`, { as: 'admin', body: { watching: true } });
    expect(await on.json()).toMatchObject({ watching: true });
    await settle();
    expect(byName(await repos(sourceId), 'acme/api')).toMatchObject({ status: 'watching', projectId: api.projectId });
    const audit = (await (await call('GET', '/api/audit?limit=300', { as: 'admin' })).json()) as ListAuditResponse;
    expect(audit.items.map((a) => a.action)).toEqual(expect.arrayContaining(['source_repo.unwatch', 'source_repo.watch', 'source_repo.remove']));
  });
});

describe('access lost', () => {
  it('marks the source and its repos when the install is revoked; nothing is deleted', async () => {
    const before = await repos(sourceId);
    const api = byName(before, 'acme/api');
    gh.installations.get(77)!.revoked = true;
    // A push that needs a scan finds out first.
    gh.commit('acme/api', { ...E2E_FILES, 'package-lock.json': E2E_FILES['package-lock.json'].replace('"lockfileVersion"', '"name2": "x",\n  "lockfileVersion"') });
    expect(await (await hook('push', pushPayload('acme/api', ['package-lock.json']))).json()).toMatchObject({ outcome: 'queued' });
    await settle();
    const src = (await (await call('GET', `/api/sources/${sourceId}`, { as: 'admin' })).json()) as ListSourcesResponse['items'][number];
    expect(src.status).toBe('access_lost');
    expect(src.health).toMatch(/removed or cannot be found/);
    const rs = await repos(sourceId);
    expect(rs.length).toBe(before.length);
    for (const r of rs.filter((x) => x.status !== 'removed')) expect(r.status).toBe('access_lost');
    // The failed scan says why, in safe words; the project and its earlier scans are still there.
    const orgId = ((await (await call('GET', '/api/me', { as: 'admin' })).json()) as { org: { id: string } }).org.id;
    const scans = listScans(srv.store, orgId, api.projectId!);
    expect(scans.items[0]).toMatchObject({ status: 'failed', error: 'Access to the GitHub installation was lost' });
    expect(scans.items.some((s) => s.status === 'succeeded')).toBe(true);
    expect((await call('GET', `/api/projects/${api.projectId}`, { as: 'admin' })).status).toBe(200);
    const audit = (await (await call('GET', '/api/audit?limit=300', { as: 'admin' })).json()) as ListAuditResponse;
    expect(audit.items.map((a) => a.action)).toContain('source.access_lost');
    // Pushes are not acted on while access is lost.
    expect(await (await hook('push', pushPayload('acme/api', ['package-lock.json']))).json()).toMatchObject({ outcome: 'skipped_source_not_connected' });
  });

  it('comes back after a check once GitHub grants access again', async () => {
    gh.installations.get(77)!.revoked = false;
    const res = await call('POST', `/api/sources/${sourceId}/check`, { as: 'admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'connected', health: null });
    await settle();
    expect(byName(await repos(sourceId), 'acme/api').status).toBe('watching');
  });

  it('an uninstall event marks access lost straight away', async () => {
    expect(await (await hook('installation', { action: 'deleted', installation: { id: 77, account: { login: 'acme' } } })).json()).toMatchObject({ outcome: 'access_lost' });
    const src = (await (await call('GET', `/api/sources/${sourceId}`, { as: 'admin' })).json()) as { status: string };
    expect(src.status).toBe('access_lost');
  });

  it('disconnect stops watching and keeps everything', async () => {
    const res = await call('DELETE', `/api/sources/${sourceId}`, { as: 'admin' });
    expect(res.status).toBe(200);
    const src = (await (await call('GET', `/api/sources/${sourceId}`, { as: 'admin' })).json()) as { status: string };
    expect(src.status).toBe('disconnected');
    expect((await repos(sourceId)).every((r) => r.status === 'not_watched' || r.status === 'removed')).toBe(true);
  });
});
