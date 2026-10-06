/**
 * Hardening regressions from the Phase 4a review: streamed body cap, login rate limiting under
 * concurrency, dev users outside dev mode, "grant only what you hold", accept_risk reversal,
 * org switching, audit of session changes, and the dev-seed reference date.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../core/http.js';
import type { FindingDetail, InvestigateNodeResponse, ListAuditResponse, ListFindingsResponse, MeResponse, Org, Scan } from './api-types.js';
import { ConcurrencyGate } from './ratelimit.js';
import { MAX_BODY_BYTES } from './request.js';
import type { Ctx, ServerConfig } from './context.js';
import { accountLimitKey, clientAddress, cookieSecure } from './routes/auth.js';
import { createServer, DEV_FIXTURE_REPLAY, E2E_REPO_DIR, FIXTURE_AS_OF, FIXTURES_DIR, isLoopbackBindHost, seedDevData, serve, serveScanDates } from './serve.js';
import { createBinding, createRole, createUser, getScanResult, openStore, seedDev, type Store } from './store/index.js';

type App = ReturnType<typeof createServer>;
const XRW = { 'X-Requested-With': 'blastradius' };
const PASSWORD = 'blastradius-dev';

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

async function call(app: App, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? XRW : {}) };
  if (opts.token) headers.Cookie = `br_session=${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}

async function login(app: App, email: string, password = PASSWORD): Promise<string> {
  const res = await call(app, 'POST', '/api/auth/login', { body: { email, password } });
  expect(res.status, `login ${email}`).toBe(200);
  return /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

describe('request body cap', () => {
  it('stops reading a chunked body without Content-Length once it passes the cap', async () => {
    const app = createServer({ devMode: false, webDir: null, log: () => {} });
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled += chunk.byteLength;
        if (pulled > 50 * 1024 * 1024) ctrl.close();
        else ctrl.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    // Node's Request needs duplex: 'half' for a stream body.
    const init = { method: 'POST', headers: { ...XRW, 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit;
    const res = await app.app.request('/api/auth/login', init);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Request body too large');
    expect(pulled).toBeLessThan(MAX_BODY_BYTES + 4 * chunk.byteLength);
    expect(cancelled).toBe(true);
  });

  it('counts bytes, not UTF-16 units, and refuses non-JSON content types', async () => {
    const app = createServer({ devMode: false, webDir: null, log: () => {} });
    // 100k three-byte characters: 300 KB on the wire, 100k code units.
    const big = JSON.stringify({ email: 'a@b', password: '€'.repeat(100_000) });
    const res = await app.app.request('/api/auth/login', { method: 'POST', headers: { ...XRW, 'Content-Type': 'application/json' }, body: big });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Request body too large');
    const form = await app.app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...XRW, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ email: 'a@b', password: 'x' }),
    });
    expect(form.status).toBe(400);
    expect(((await form.json()) as { error: { message: string } }).error.message).toMatch(/Content-Type/);
  });
});

describe('login rate limiting', () => {
  it('counts attempts before verifying, so a parallel burst cannot bypass the limit', async () => {
    const app = createServer({ devMode: true, webDir: null, log: () => {}, loginIpRateLimit: 1000 });
    await seedDev(app.store, { devMode: true, password: PASSWORD });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => call(app, 'POST', '/api/auth/login', { body: { email: 'admin@local', password: 'wrong' } }).then((r) => r.status)),
    );
    expect(results.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(20);
  });

  it('limits password spraying across many emails per client address', async () => {
    const app = createServer({ devMode: true, webDir: null, log: () => {}, loginIpRateLimit: 5 });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await call(app, 'POST', '/api/auth/login', { body: { email: `user${i}@x`, password: 'x' } })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  it('a successful sign-in does not use up the address budget', async () => {
    const app = createServer({ devMode: true, webDir: null, log: () => {}, loginIpRateLimit: 3 });
    await seedDev(app.store, { devMode: true, password: PASSWORD });
    for (let i = 0; i < 6; i++) await login(app, 'admin@local');
  });

  it('ConcurrencyGate caps parallel work and refuses beyond the queue', async () => {
    const gate = new ConcurrencyGate(2, 1);
    const a = await gate.acquire();
    const b = await gate.acquire();
    let thirdRan = false;
    const third = gate.acquire().then((r) => {
      thirdRan = true;
      return r;
    });
    expect(await gate.acquire()).toBeNull(); // queue full
    await Promise.resolve();
    expect(thirdRan).toBe(false);
    a!();
    const c = await third;
    expect(thirdRan).toBe(true);
    b!();
    c!();
    expect(await gate.acquire()).not.toBeNull();
  });
});

/** A request as if from socket peer `peer` (app.request() has no socket otherwise). */
async function callFrom(app: App, peer: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.app.request(
    path,
    { method: 'POST', headers: { ...XRW, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
    { incoming: { socket: { remoteAddress: peer } } },
  );
}

describe('per-account limit keyed by client address + email', () => {
  it('refuses a blocked address with 429 before touching the per-account limiter', async () => {
    const app = createServer({ devMode: true, webDir: null, log: () => {}, loginIpRateLimit: 2 });
    const hit = vi.spyOn(app.deps.loginLimiter, 'hit');
    const attempt = () => callFrom(app, '203.0.113.9', '/api/auth/login', { email: 'a@x', password: 'x' }).then((r) => r.status);
    expect([await attempt(), await attempt()]).toEqual([401, 401]);
    expect(hit).toHaveBeenCalledTimes(2);
    expect(hit).toHaveBeenLastCalledWith(accountLimitKey('203.0.113.9', 'a@x'));
    expect(await attempt()).toBe(429);
    expect(hit).toHaveBeenCalledTimes(2);
    // Same for accept-invite: the address check comes first.
    expect((await callFrom(app, '203.0.113.9', '/api/auth/accept-invite', { token: 'nope', password: 'x' })).status).toBe(429);
    expect(hit).toHaveBeenCalledTimes(2);
  });

  it('one address exhausting an account does not lock it for another address; success resets the key', async () => {
    const app = createServer({ devMode: true, webDir: null, log: () => {}, loginIpRateLimit: 1000 });
    await seedDev(app.store, { devMode: true, password: PASSWORD });
    const attempt = (peer: string, password: string) => callFrom(app, peer, '/api/auth/login', { email: 'Admin@Local', password }).then((r) => r.status);
    for (let i = 0; i < 10; i++) expect(await attempt('198.51.100.1', 'wrong')).toBe(401);
    expect(await attempt('198.51.100.1', PASSWORD)).toBe(429);
    expect(await attempt('198.51.100.2', PASSWORD)).toBe(200);
    // 9 failures + a success from one address: the composite key is reset, 10 more failures are 401s.
    for (let i = 0; i < 9; i++) expect(await attempt('198.51.100.3', 'wrong')).toBe(401);
    expect(await attempt('198.51.100.3', PASSWORD)).toBe(200);
    for (let i = 0; i < 10; i++) expect(await attempt('198.51.100.3', 'wrong')).toBe(401);
    expect(accountLimitKey('198.51.100.3', ' Admin@Local ')).toBe(accountLimitKey('198.51.100.3', 'admin@local'));
    expect(accountLimitKey('198.51.100.3', 'admin@local')).not.toBe(accountLimitKey('198.51.100.4', 'admin@local'));
  });
});

describe('trusted proxies', () => {
  function ctx(peer: string | null, headers: Record<string, string>, config: Partial<ServerConfig> = {}): Ctx {
    return {
      env: peer ? { incoming: { socket: { remoteAddress: peer } } } : undefined,
      req: { url: 'http://localhost:8000/api/auth/login', header: (n: string) => headers[n.toLowerCase()] },
      get: (k: string) => (k === 'deps' ? { config } : undefined),
    } as unknown as Ctx;
  }

  it('uses the socket address unless the peer is a trusted proxy', () => {
    expect(clientAddress(ctx(null, {}))).toBe('local');
    expect(clientAddress(ctx('::ffff:192.0.2.7', {}))).toBe('192.0.2.7');
    expect(clientAddress(ctx('192.0.2.7', { 'x-forwarded-for': '1.2.3.4' }))).toBe('192.0.2.7');
    expect(clientAddress(ctx('192.0.2.7', { 'x-forwarded-for': '1.2.3.4' }, { trustProxy: ['10.0.0.1'] }))).toBe('192.0.2.7');
  });

  it('takes the right-most X-Forwarded-For hop that is not a trusted proxy', () => {
    const trustProxy = ['10.0.0.1', '10.0.0.2'];
    expect(clientAddress(ctx('10.0.0.1', { 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 10.0.0.2' }, { trustProxy }))).toBe('1.2.3.4');
    expect(clientAddress(ctx('::ffff:10.0.0.1', { 'x-forwarded-for': '::ffff:1.2.3.4' }, { trustProxy }))).toBe('1.2.3.4');
    expect(clientAddress(ctx('10.0.0.1', {}, { trustProxy }))).toBe('10.0.0.1');
    expect(clientAddress(ctx('10.0.0.1', { 'x-forwarded-for': '10.0.0.2' }, { trustProxy }))).toBe('10.0.0.1');
    expect(clientAddress(ctx('10.0.0.1', { 'x-forwarded-for': '1.2.3.4' }, { trustProxy: ['::ffff:10.0.0.1'] }))).toBe('1.2.3.4');
  });

  it('honours X-Forwarded-Proto for the Secure cookie only from a trusted proxy', () => {
    const https = { 'x-forwarded-proto': 'https', host: 'localhost:8000' };
    expect(cookieSecure(ctx('127.0.0.1', https))).toBe(false);
    expect(cookieSecure(ctx('127.0.0.1', https, { trustProxy: ['127.0.0.1'] }))).toBe(true);
    expect(cookieSecure(ctx('127.0.0.1', { host: 'localhost:8000' }, { trustProxy: ['127.0.0.1'] }))).toBe(false);
    expect(cookieSecure(ctx('127.0.0.1', { host: 'br.example.com' }))).toBe(true);
    expect(cookieSecure(ctx('127.0.0.1', https, { secureCookies: 'never', trustProxy: ['127.0.0.1'] }))).toBe(false);
    expect(cookieSecure(ctx('127.0.0.1', { host: 'localhost' }, { secureCookies: 'always' }))).toBe(true);
  });

  it('gives each forwarded client its own address budget behind a trusted proxy', async () => {
    const app = createServer({ devMode: true, webDir: null, log: () => {}, loginIpRateLimit: 2, trustProxy: ['10.0.0.1'] });
    const attempt = (xff: string, peer = '10.0.0.1') =>
      callFrom(app, peer, '/api/auth/login', { email: `u${Math.random()}@x`, password: 'x' }, { 'X-Forwarded-For': xff }).then((r) => r.status);
    expect([await attempt('1.1.1.1'), await attempt('1.1.1.1'), await attempt('1.1.1.1')]).toEqual([401, 401, 429]);
    expect(await attempt('2.2.2.2')).toBe(401);
    // An untrusted peer cannot pick its address with the header.
    expect([await attempt('3.3.3.3', '192.0.2.50'), await attempt('4.4.4.4', '192.0.2.50'), await attempt('5.5.5.5', '192.0.2.50')]).toEqual([401, 401, 429]);
  });
});

describe('dev mode binds to loopback only', () => {
  it('classifies loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1']) expect(isLoopbackBindHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '10.0.0.1', '128.0.0.1', '127.0.0.256', 'example.com', 'localhost.example.com']) expect(isLoopbackBindHost(h), h).toBe(false);
  });

  it('refuses to start dev mode on a non-loopback host, and still serves dev mode on loopback', async () => {
    const log = () => {};
    await expect(serve({ devMode: true, host: '0.0.0.0', port: 0, webDir: null, log })).rejects.toThrow(/dev mode.*loopback.*0\.0\.0\.0/);
    await expect(serve({ devSeed: true, host: '192.0.2.1', port: 0, webDir: null, log })).rejects.toThrow(/loopback/);
    const ok = await serve({ devMode: true, host: '127.0.0.1', port: 0, webDir: null, log });
    await ok.close();
  });

  it('does not restrict the host outside dev mode', async () => {
    const s = await serve({ host: '0.0.0.0', port: 0, webDir: null, log: () => {} });
    await s.close();
  });
});

describe('dev users outside dev mode', () => {
  it('refuses the seeded dev password once the server runs without --dev', async () => {
    const store: Store = openStore({ path: ':memory:' });
    await seedDev(store, { devMode: true, password: PASSWORD });
    const dev = createServer({ store, devMode: true, webDir: null, log: () => {} });
    await login(dev, 'admin@local');
    const prod = createServer({ store, devMode: false, webDir: null, log: () => {} });
    const res = await call(prod, 'POST', '/api/auth/login', { body: { email: 'admin@local', password: PASSWORD } });
    expect(res.status).toBe(401);
    // A real (non-dev) user still signs in.
    createUser(store, { email: 'real@corp', name: 'Real', password: 'a-long-real-password' });
    await login(prod, 'real@corp', 'a-long-real-password');
  });
});

describe('server-side checks with the seeded fixture scan', () => {
  let srv: App;
  let orgId: string;
  let projectId: string;
  let adminId: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    srv = createServer({
      devMode: true,
      localRoots: [E2E_REPO_DIR],
      offline: true,
      fixturesDir: FIXTURES_DIR,
      asOf: FIXTURE_AS_OF,
      webDir: null,
      scanOptions: { http: offlineHttp(), cacheDir: false },
      log: () => {},
      loginIpRateLimit: 1000,
    });
    const seed = await seedDevData(srv.deps);
    projectId = seed.projectId;
    await srv.jobs.waitFor(seed.scanId!);
    tokens.admin = await login(srv, 'admin@local');
    const me = (await (await call(srv, 'GET', '/api/me', { token: tokens.admin })).json()) as MeResponse;
    orgId = me.org!.id;
    const admin = me.user.id;
    adminId = admin;

    const mm = createRole(srv.store, orgId, { name: 'Member manager', permissions: ['settings', 'manage_members', 'reports'] }, admin);
    const mgr = createUser(srv.store, { email: 'mgr@corp', name: 'Mgr', password: PASSWORD });
    createBinding(srv.store, orgId, { roleId: mm.id, subject: { kind: 'user', userId: mgr.id }, scope: { kind: 'org' } }, admin);
    tokens.mgr = await login(srv, 'mgr@corp');

    const rev = createRole(srv.store, orgId, { name: 'Reviewer', permissions: ['findings', 'review'] }, admin);
    const reviewer = createUser(srv.store, { email: 'rev@corp', name: 'Rev', password: PASSWORD });
    createBinding(srv.store, orgId, { roleId: rev.id, subject: { kind: 'user', userId: reviewer.id }, scope: { kind: 'org' } }, admin);
    tokens.rev = await login(srv, 'rev@corp');
  }, 60_000);

  afterAll(() => srv.jobs.stop());

  it('manage_members cannot grant Org admin or permissions the actor lacks', async () => {
    const target = createUser(srv.store, { email: 'target@corp', name: 'T', password: PASSWORD });
    // A member already (bindings are only for members), via a role mgr may hand out.
    const readers = createRole(srv.store, orgId, { name: 'Report readers', permissions: ['reports'] }, adminId);
    createBinding(srv.store, orgId, { roleId: readers.id, subject: { kind: 'user', userId: target.id }, scope: { kind: 'org' } }, adminId);
    const bind = (roleId: string) =>
      call(srv, 'POST', '/api/bindings', { token: tokens.mgr, body: { roleId, subject: { kind: 'user', userId: target.id }, scope: { kind: 'org' } } });
    expect((await bind('org_admin')).status).toBe(403);
    expect((await bind('appsec')).status).toBe(403); // appsec has pages mgr does not hold
    expect((await bind('auditor')).status).toBe(201); // reports only: mgr holds it
    expect((await call(srv, 'POST', '/api/roles', { token: tokens.mgr, body: { name: 'Escalate', permissions: ['findings', 'accept_risk'] } })).status).toBe(403);
    expect((await call(srv, 'POST', '/api/roles', { token: tokens.mgr, body: { name: 'From admin', template: 'org_admin' } })).status).toBe(403);
    expect((await call(srv, 'PATCH', '/api/roles/auditor', { token: tokens.mgr, body: { permissions: ['reports', 'findings'] } })).status).toBe(403);
    expect((await call(srv, 'POST', '/api/roles', { token: tokens.mgr, body: { name: 'Readers', permissions: ['reports'] } })).status).toBe(201);
    // The same rules hold when inviting: no Org admin, nothing beyond what mgr holds.
    const invite = (email: string, roleId: string) =>
      call(srv, 'POST', '/api/members', { token: tokens.mgr, body: { email, name: 'New', bindings: [{ roleId, scope: { kind: 'org' } }] } });
    expect((await invite('esc1@corp', 'org_admin')).status).toBe(403);
    expect((await invite('esc2@corp', 'appsec')).status).toBe(403);
    expect((await invite('ok@corp', 'auditor')).status).toBe(201);
    // Removing an Org admin binding needs Org admin too.
    const bindings = (await (await call(srv, 'GET', '/api/bindings', { token: tokens.mgr })).json()) as { items: { id: string; roleId: string }[] };
    const adminBinding = bindings.items.find((b) => b.roleId === 'org_admin')!;
    expect((await call(srv, 'DELETE', `/api/bindings/${adminBinding.id}`, { token: tokens.mgr })).status).toBe(403);
    // An Org admin still can.
    expect((await call(srv, 'POST', '/api/roles', { token: tokens.admin, body: { name: 'Escalate', permissions: ['findings', 'accept_risk'] } })).status).toBe(201);
  });

  it('a review-only user cannot undo an accepted risk', async () => {
    const list = (await (await call(srv, 'GET', `/api/findings?project=${projectId}`, { token: tokens.admin })).json()) as ListFindingsResponse;
    const [f, g] = list.items;
    expect((await call(srv, 'PATCH', `/api/findings/${f!.id}`, { token: tokens.admin, body: { status: 'accepted_risk' } })).status).toBe(200);
    expect((await call(srv, 'PATCH', `/api/findings/${f!.id}`, { token: tokens.rev, body: { status: 'reviewed' } })).status).toBe(403);
    expect((await call(srv, 'PATCH', `/api/findings/${f!.id}`, { token: tokens.rev, body: { status: 'new' } })).status).toBe(403);
    expect((await call(srv, 'PATCH', `/api/findings/${g!.id}`, { token: tokens.rev, body: { status: 'reviewed' } })).status).toBe(200);
    expect((await call(srv, 'PATCH', `/api/findings/${g!.id}`, { token: tokens.rev, body: { status: 'accepted_risk' } })).status).toBe(403);
  });

  it('switches the session to a newly created org and back', async () => {
    const token = await login(srv, 'admin@local');
    const created = await call(srv, 'POST', '/api/orgs', { token, body: { name: 'Second Org' } });
    expect(created.status).toBe(201);
    const org = (await created.json()) as Org;
    let me = (await (await call(srv, 'GET', '/api/me', { token })).json()) as MeResponse;
    expect(me.org?.id).toBe(org.id);
    const back = await call(srv, 'POST', '/api/session/org', { token, body: { orgId } });
    expect(back.status).toBe(200);
    expect(((await back.json()) as MeResponse).org?.id).toBe(orgId);
    me = (await (await call(srv, 'GET', '/api/me', { token })).json()) as MeResponse;
    expect(me.org?.id).toBe(orgId);
    // Not a member: 404, and the session stays put.
    expect((await call(srv, 'POST', '/api/session/org', { token: tokens.rev, body: { orgId: org.id } })).status).toBe(404);
    const audit = (await (await call(srv, 'GET', '/api/audit', { token })).json()) as ListAuditResponse;
    expect(audit.items.some((a) => a.action === 'session.switch_org' && a.target === orgId)).toBe(true);
  });

  it('investigate/node lists appearances only in projects the caller may investigate', async () => {
    const created = await call(srv, 'POST', '/api/projects', { token: tokens.admin, body: { name: 'second-app', tier: 'Small', target: E2E_REPO_DIR } });
    expect(created.status).toBe(201);
    const secondId = ((await created.json()) as { id: string }).id;
    const queued = await call(srv, 'POST', `/api/projects/${secondId}/scans`, { token: tokens.admin, body: {} });
    expect(queued.status).toBe(202);
    await srv.jobs.waitFor(((await queued.json()) as Scan).id);

    const list = (await (await call(srv, 'GET', `/api/findings?project=${projectId}`, { token: tokens.admin })).json()) as ListFindingsResponse;
    const detail = (await (await call(srv, 'GET', `/api/findings/${list.items[0]!.id}`, { token: tokens.admin })).json()) as FindingDetail;
    const incident = detail.entityChain.find((l) => l.relation === 'incident')!.entityId;
    const node = async (token: string, project: string) =>
      call(srv, 'GET', `/api/investigate/node?project=${project}&id=${encodeURIComponent(incident)}`, { token });

    const all = (await (await node(tokens.admin!, projectId)).json()) as InvestigateNodeResponse;
    expect(new Set(all.appearances.map((a) => a.projectId))).toEqual(new Set([projectId, secondId]));

    const scoped = createUser(srv.store, { email: 'scoped-investigator@corp', name: 'Scoped', password: PASSWORD });
    createBinding(srv.store, orgId, { roleId: 'developer', subject: { kind: 'user', userId: scoped.id }, scope: { kind: 'project', projectId } }, adminId);
    const token = await login(srv, 'scoped-investigator@corp');
    const mine = await node(token, projectId);
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as InvestigateNodeResponse;
    expect(mineBody.appearances.length).toBeGreaterThan(0);
    expect(mineBody.appearances.every((a) => a.projectId === projectId)).toBe(true);
    expect((await node(token, secondId)).status).toBe(403);
  });

  it('audits dev user switches, logins and logouts', async () => {
    const token = await login(srv, 'admin@local');
    const me = (await (await call(srv, 'GET', '/api/me', { token })).json()) as MeResponse;
    const auditor = me.devUsers!.find((u) => u.email === 'auditor@local')!;
    expect((await call(srv, 'POST', '/api/dev/switch-user', { token, body: { userId: auditor.id } })).status).toBe(200);
    expect((await call(srv, 'POST', '/api/auth/logout', { token })).status).toBe(200);
    const audit = (await (await call(srv, 'GET', '/api/audit?limit=500', { token: tokens.admin })).json()) as ListAuditResponse;
    const sw = audit.items.find((a) => a.action === 'session.switch_user' && a.target === auditor.id);
    expect(sw?.detail).toMatchObject({ fromUserId: me.user.id, toUserId: auditor.id });
    expect(audit.items.some((a) => a.action === 'session.login')).toBe(true);
    expect(audit.items.some((a) => a.action === 'session.logout' && a.actor === auditor.id)).toBe(true);
  });
});

describe('dev seed reference date', () => {
  it('--dev-seed replays the fixture date for fixture repos only; --as-of applies to every scan', () => {
    expect(serveScanDates({ devSeed: true })).toEqual({ fixtureReplay: DEV_FIXTURE_REPLAY });
    expect(DEV_FIXTURE_REPLAY.asOf).toEqual(FIXTURE_AS_OF);
    const d = new Date('2020-01-01T00:00:00Z');
    expect(serveScanDates({ devSeed: true, asOf: d })).toEqual({ asOf: d, fixtureReplay: DEV_FIXTURE_REPLAY });
    expect(serveScanDates({})).toEqual({});
  });

  it('a fixture-repo rescan uses the fixture date and runs offline; another project scans as of now', async () => {
    const other = mkdtempSync(join(tmpdir(), 'br-replay-'));
    try {
      cpSync(E2E_REPO_DIR, join(other, 'app'), { recursive: true });
      const srv = createServer({
        devMode: true,
        localRoots: [E2E_REPO_DIR, other],
        ...serveScanDates({ devSeed: true }),
        webDir: null,
        scanOptions: { http: offlineHttp(), cacheDir: false },
        log: () => {},
        loginIpRateLimit: 1000,
      });
      const seed = await seedDevData(srv.deps);
      await srv.jobs.waitFor(seed.scanId!);
      const token = await login(srv, 'admin@local');
      const created = await call(srv, 'POST', '/api/projects', { token, body: { name: 'live-app', tier: 'Small', target: join(other, 'app') } });
      expect(created.status).toBe(201);
      const liveId = ((await created.json()) as { id: string }).id;
      const before = Date.now();
      const rescan = async (projectId: string) => {
        const res = await call(srv, 'POST', `/api/projects/${projectId}/scans`, { token, body: {} });
        expect(res.status).toBe(202);
        const scan = (await res.json()) as Scan;
        await srv.jobs.waitFor(scan.id);
        return { scan, result: getScanResult(srv.store, seed.orgId, scan.id)!.result };
      };
      const fixture = await rescan(seed.projectId);
      expect(fixture.scan.offline).toBe(true);
      expect(fixture.result.generatedAt).toBe(FIXTURE_AS_OF.toISOString());
      const live = await rescan(liveId);
      expect(live.scan.offline).toBe(false);
      expect(Date.parse(live.result.generatedAt)).toBeGreaterThanOrEqual(before - 1000);
      srv.jobs.stop();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 60_000);
});
