/**
 * Member invites (POST /api/members, POST /api/auth/accept-invite), the members-only rule for
 * POST /api/bindings, /api/me org listing with POST /api/session/org, and scan-list polling
 * with ?updatedSince=.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import type { InviteMemberResponse, ListAuditResponse, ListScansResponse, MeResponse, Org, Scan } from './api-types.js';
import { createServer, E2E_REPO_DIR, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from './serve.js';
import { all, createOrg, createUser, hashToken, openStore, seedDev, type Store } from './store/index.js';

type App = ReturnType<typeof createServer>;
const XRW = { 'X-Requested-With': 'blastradius' };
const ADMIN_PASSWORD = 'a-long-admin-password';

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

function cookieOf(res: Response): string {
  return /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

async function login(app: App, email: string, password: string): Promise<string> {
  const res = await call(app, 'POST', '/api/auth/login', { body: { email, password } });
  expect(res.status, `login ${email}`).toBe(200);
  return cookieOf(res);
}

async function json<T>(res: Promise<Response> | Response): Promise<T> {
  return (await (await res).json()) as T;
}

/** Real time plus an adjustable offset, so tests can jump past the invite expiry. */
function shiftingClock(): { now: () => Date; advance: (ms: number) => void } {
  let offset = 0;
  return { now: () => new Date(Date.now() + offset), advance: (ms) => void (offset += ms) };
}

describe('invites outside dev mode', () => {
  const clock = shiftingClock();
  const logs: string[] = [];
  let store: Store;
  let srv: App;
  let org: Org;
  let admin: string;

  beforeAll(async () => {
    store = openStore({ now: clock.now });
    srv = createServer({ store, devMode: false, webDir: null, log: (m) => void logs.push(m), loginIpRateLimit: 1000 });
    const u = createUser(store, { email: 'owner@corp', name: 'Owner', password: ADMIN_PASSWORD });
    org = createOrg(store, { name: 'Corp' }, u.id);
    admin = await login(srv, 'owner@corp', ADMIN_PASSWORD);
  });

  afterAll(() => srv.jobs.stop());

  const invite = (email: string, roleId = 'developer', token = admin) =>
    call(srv, 'POST', '/api/members', { token, body: { email, name: 'Invitee', bindings: [{ roleId, scope: { kind: 'org' } }] } });

  it('creates a pending invite with a hashed single-use token; accepting creates the account', async () => {
    const res = await invite('new@corp');
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteMemberResponse;
    expect(body.oneTimePassword).toBeUndefined();
    expect(body.member).toBeUndefined();
    expect(body).not.toHaveProperty('created');
    const { token, expiresAt } = body.invite!;
    expect(body.invite).toMatchObject({ email: 'new@corp', name: 'Invitee' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600_000);

    // Stored hashed; the plain token is nowhere in the database, the audit log or the logs.
    const rows = all<{ token_hash: string }>(store, 'SELECT token_hash FROM invite');
    expect(rows.map((r) => r.token_hash)).toContain(hashToken(token));
    const dump = JSON.stringify(all(store, 'SELECT * FROM audit_log')) + JSON.stringify(rows) + logs.join('\n');
    expect(dump).not.toContain(token);

    // Nothing exists or is granted before accepting.
    expect(all(store, 'SELECT id FROM app_user WHERE email = ?', 'new@corp')).toHaveLength(0);
    expect((await call(srv, 'POST', '/api/auth/login', { body: { email: 'new@corp', password: 'anything-at-all' } })).status).toBe(401);
    // Too short a password is refused without spending the invite.
    expect((await call(srv, 'POST', '/api/auth/accept-invite', { body: { token, password: 'short' } })).status).toBe(400);

    const accepted = await call(srv, 'POST', '/api/auth/accept-invite', { body: { token, password: 'a-brand-new-password' } });
    expect(accepted.status).toBe(200);
    const me = (await accepted.json()) as MeResponse;
    expect(me.user).toMatchObject({ email: 'new@corp', name: 'Invitee' });
    expect(me.org?.id).toBe(org.id);
    expect(me.roles.map((r) => r.id)).toEqual(['developer']);
    const session = cookieOf(accepted);
    expect((await call(srv, 'GET', '/api/me', { token: session })).status).toBe(200);
    await login(srv, 'new@corp', 'a-brand-new-password');

    // Single use.
    const again = await call(srv, 'POST', '/api/auth/accept-invite', { body: { token, password: 'another-new-password' } });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { message: string } }).error.message).toMatch(/invalid, expired or already used/);

    const audit = await json<ListAuditResponse>(call(srv, 'GET', '/api/audit?limit=500', { token: admin }));
    const actions = audit.items.map((a) => a.action);
    for (const a of ['user.create', 'binding.create', 'invite.create', 'member.invite', 'invite.accept']) expect(actions, a).toContain(a);
    const inv = audit.items.find((a) => a.action === 'member.invite')!;
    expect(inv.detail).toMatchObject({ email: 'new@corp', credential: 'invite' });
  });

  it('rejects unknown and expired invite tokens, and re-inviting re-sends an expired invite', async () => {
    expect((await call(srv, 'POST', '/api/auth/accept-invite', { body: { token: 'nope', password: 'a-brand-new-password' } })).status).toBe(400);
    const first = await json<InviteMemberResponse>(invite('late@corp'));
    clock.advance(7 * 24 * 3600_000 + 1000);
    try {
      expect((await call(srv, 'POST', '/api/auth/accept-invite', { body: { token: first.invite!.token, password: 'a-brand-new-password' } })).status).toBe(400);
      // The admin can simply invite again: a fresh token, and the old one stays dead.
      const admin2 = await login(srv, 'owner@corp', ADMIN_PASSWORD);
      const second = await call(srv, 'POST', '/api/members', { token: admin2, body: { email: 'late@corp', name: 'Late', bindings: [{ roleId: 'developer', scope: { kind: 'org' } }] } });
      expect(second.status).toBe(201);
      const fresh = ((await second.json()) as InviteMemberResponse).invite!;
      expect(fresh.token).not.toBe(first.invite!.token);
      const ok = await call(srv, 'POST', '/api/auth/accept-invite', { body: { token: fresh.token, password: 'a-brand-new-password' } });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as MeResponse).user.name).toBe('Late');
    } finally {
      clock.advance(-(7 * 24 * 3600_000 + 1000));
    }
    // Back to the present: the admin's session is still valid.
    expect((await call(srv, 'GET', '/api/me', { token: admin })).status).toBe(200);
  });

  it('a new invite replaces an unaccepted earlier one for the same email', async () => {
    const a = await json<InviteMemberResponse>(invite('twice@corp'));
    const b = await json<InviteMemberResponse>(invite('twice@corp', 'auditor'));
    expect((await call(srv, 'POST', '/api/auth/accept-invite', { body: { token: a.invite!.token, password: 'a-brand-new-password' } })).status).toBe(400);
    const ok = await call(srv, 'POST', '/api/auth/accept-invite', { body: { token: b.invite!.token, password: 'a-brand-new-password' } });
    expect(((await ok.json()) as MeResponse).roles.map((r) => r.id)).toEqual(['auditor']);
  });

  it('answers the same for existing accounts, and grants nothing until they accept with their own password', async () => {
    const other = createUser(store, { email: 'elsewhere@corp', name: 'Elsewhere Secret Name', password: 'elsewhere-password' });
    const elsewhere = createOrg(store, { name: 'Elsewhere Inc' }, other.id);
    const res = await invite('Elsewhere@Corp', 'auditor');
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteMemberResponse;
    const fresh = await json<InviteMemberResponse>(invite('nobody-yet@corp', 'auditor'));
    // Same shape as an invite for an email with no account; the stored name never leaks.
    expect(Object.keys(body).sort()).toEqual(Object.keys(fresh).sort());
    expect(Object.keys(body.invite!).sort()).toEqual(Object.keys(fresh.invite!).sort());
    expect(body.invite).toMatchObject({ email: 'elsewhere@corp', name: 'Invitee' });
    expect(JSON.stringify(body)).not.toContain('Elsewhere Secret Name');
    expect(JSON.stringify(body)).not.toContain(other.id);
    // Not attached to the org yet: no member row, no org in their switcher.
    const members = await json<{ items: { id: string }[] }>(call(srv, 'GET', '/api/members', { token: admin }));
    expect(members.items.map((m) => m.id)).not.toContain(other.id);
    const theirs = await login(srv, 'elsewhere@corp', 'elsewhere-password');
    expect((await json<MeResponse>(call(srv, 'GET', '/api/me', { token: theirs }))).orgs.map((o) => o.id)).toEqual([elsewhere.id]);

    // The token alone cannot take the account over: a new password is refused...
    const token = body.invite!.token;
    const wrong = await call(srv, 'POST', '/api/auth/accept-invite', { body: { token, password: 'attacker-chosen-password' } });
    expect(wrong.status).toBe(400);
    await login(srv, 'elsewhere@corp', 'elsewhere-password');
    // ...the account's own password accepts, keeps the password and name, and adds the binding.
    const ok = await call(srv, 'POST', '/api/auth/accept-invite', { body: { token, password: 'elsewhere-password' } });
    expect(ok.status).toBe(200);
    const me = (await ok.json()) as MeResponse;
    expect(me.user).toMatchObject({ id: other.id, name: 'Elsewhere Secret Name' });
    expect(me.org?.id).toBe(org.id);
    expect(me.roles.map((r) => r.id)).toEqual(['auditor']);
    expect(me.orgs.map((o) => o.id).sort()).toEqual([org.id, elsewhere.id].sort());
    await login(srv, 'elsewhere@corp', 'elsewhere-password');
    // Now a member: inviting again is a conflict.
    expect((await invite('elsewhere@corp', 'appsec')).status).toBe(409);
  });

  it('validates the body and needs manage_members', async () => {
    expect((await invite('bad-role@corp', 'no_such_role')).status).toBe(400);
    expect((await call(srv, 'POST', '/api/members', { token: admin, body: { email: 'x@corp', name: 'X', bindings: [] } })).status).toBe(400);
    expect((await call(srv, 'POST', '/api/members', { token: admin, body: { email: 'not-an-email', name: 'X', bindings: [{ roleId: 'developer', scope: { kind: 'org' } }] } })).status).toBe(400);
    const dev = await invite('dev2@corp', 'developer');
    const token = (await dev.json()) as InviteMemberResponse;
    const accepted = await call(srv, 'POST', '/api/auth/accept-invite', { body: { token: token.invite!.token, password: 'developer-password' } });
    const devSession = cookieOf(accepted);
    expect((await invite('blocked@corp', 'developer', devSession)).status).toBe(403);
    expect((await call(srv, 'POST', '/api/members', { body: { email: 'x@corp', name: 'X', bindings: [{ roleId: 'developer', scope: { kind: 'org' } }] } })).status).toBe(401);
  });

  it('POST /api/bindings only binds members, with one answer for unknown users and non-members', async () => {
    const outsider = createUser(store, { email: 'outsider@corp', name: 'Outsider', password: 'outsider-password' });
    const bind = (userId: string) => call(srv, 'POST', '/api/bindings', { token: admin, body: { roleId: 'auditor', subject: { kind: 'user', userId }, scope: { kind: 'org' } } });
    const a = await bind(outsider.id);
    const b = await bind('usr_doesnotexist');
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(await a.json()).toEqual(await b.json());
    // Members can get more bindings; groups are unaffected.
    const pending = await json<InviteMemberResponse>(invite('member2@corp', 'developer'));
    const joined = await json<MeResponse>(call(srv, 'POST', '/api/auth/accept-invite', { body: { token: pending.invite!.token, password: 'member2-password' } }));
    expect((await bind(joined.user.id)).status).toBe(201);
    expect((await call(srv, 'POST', '/api/bindings', { token: admin, body: { roleId: 'auditor', subject: { kind: 'group', group: 'auditors' }, scope: { kind: 'org' } } })).status).toBe(201);
  });
});

describe('invites in dev mode', () => {
  const logs: string[] = [];
  let srv: App;
  let admin: string;

  beforeAll(async () => {
    srv = createServer({ devMode: true, webDir: null, localRoots: [E2E_REPO_DIR], log: (m) => void logs.push(m), loginIpRateLimit: 1000 });
    await seedDev(srv.store, { devMode: true });
    admin = await login(srv, 'admin@local', 'blastradius-dev');
  });

  afterAll(() => srv.jobs.stop());

  it('returns a one-time password once and never logs or audits it', async () => {
    const res = await call(srv, 'POST', '/api/members', {
      token: admin,
      body: { email: 'pat@local', name: 'Pat', bindings: [{ roleId: 'appsec', scope: { kind: 'org' } }] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InviteMemberResponse;
    expect(body.member).toMatchObject({ email: 'pat@local', name: 'Pat' });
    expect(body.invite).toBeUndefined();
    const otp = body.oneTimePassword!;
    expect(otp.length).toBeGreaterThanOrEqual(32);
    const me = await json<MeResponse>(call(srv, 'POST', '/api/auth/login', { body: { email: 'pat@local', password: otp } }));
    expect(me.roles.map((r) => r.id)).toEqual(['appsec']);
    expect(logs.join('\n')).not.toContain(otp);
    const audit = await json<ListAuditResponse>(call(srv, 'GET', '/api/audit?limit=500', { token: admin }));
    expect(JSON.stringify(audit)).not.toContain(otp);
    expect(audit.items.find((a) => a.action === 'member.invite')?.detail).toMatchObject({ credential: 'one_time_password' });
    // Invited users are not seeded dev users: they are not in the switcher.
    expect(me.devUsers?.some((u) => u.email === 'pat@local')).toBe(false);
  });
});

describe('/api/me orgs and POST /api/session/org', () => {
  let store: Store;
  let srv: App;
  let token: string;
  let first: Org;
  let second: Org;

  beforeAll(async () => {
    store = openStore();
    srv = createServer({ store, devMode: false, webDir: null, log: () => {}, loginIpRateLimit: 1000 });
    const u = createUser(store, { email: 'multi@corp', name: 'Multi', password: ADMIN_PASSWORD });
    first = createOrg(store, { name: 'First' }, u.id);
    second = createOrg(store, { name: 'Second' }, u.id);
    const stranger = createUser(store, { email: 'stranger@corp', name: 'Stranger', password: ADMIN_PASSWORD });
    createOrg(store, { name: 'Third' }, stranger.id);
    token = await login(srv, 'multi@corp', ADMIN_PASSWORD);
  });

  afterAll(() => srv.jobs.stop());

  it('lists every org the user belongs to, and only those', async () => {
    const me = await json<MeResponse>(call(srv, 'GET', '/api/me', { token }));
    expect(me.orgs).toEqual([
      { id: first.id, name: 'First' },
      { id: second.id, name: 'Second' },
    ]);
    expect(me.org?.id).toBe(first.id);
  });

  it('switches orgs, audits real switches only, and validates input', async () => {
    const res = await call(srv, 'POST', '/api/session/org', { token, body: { orgId: second.id } });
    expect(res.status).toBe(200);
    const me = (await res.json()) as MeResponse;
    expect(me.org?.id).toBe(second.id);
    expect(me.orgs).toHaveLength(2);
    expect((await json<MeResponse>(call(srv, 'GET', '/api/me', { token }))).org?.id).toBe(second.id);
    // Same org again: fine, but not audited twice.
    expect((await call(srv, 'POST', '/api/session/org', { token, body: { orgId: second.id } })).status).toBe(200);
    const audit = await json<ListAuditResponse>(call(srv, 'GET', '/api/audit?limit=500', { token }));
    expect(audit.items.filter((a) => a.action === 'session.switch_org')).toHaveLength(1);

    expect((await call(srv, 'POST', '/api/session/org', { token, body: { orgId: 'org_nope' } })).status).toBe(404);
    expect((await call(srv, 'POST', '/api/session/org', { token, body: {} })).status).toBe(400);
    expect((await call(srv, 'POST', '/api/session/org', { token, body: { orgId: second.id, extra: 1 } })).status).toBe(400);
    expect((await call(srv, 'POST', '/api/session/org', { body: { orgId: second.id } })).status).toBe(401);
    expect((await json<MeResponse>(call(srv, 'GET', '/api/me', { token }))).org?.id).toBe(second.id);
  });
});

describe('scan list polling with ?updatedSince=', () => {
  let srv: App;
  let token: string;
  let projectId: string;

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
    token = await login(srv, 'admin@local', 'blastradius-dev');
  }, 60_000);

  afterAll(() => srv.jobs.stop());

  const list = (q: string) => json<ListScansResponse>(call(srv, 'GET', `/api/projects/${projectId}/scans${q}`, { token }));

  it('returns only scans changed since the last poll, with serverTime and updatedAt', async () => {
    const full = await list('');
    expect(full.items).toHaveLength(1);
    const seeded = full.items[0]!;
    expect(seeded.updatedAt).toBe(seeded.finishedAt);
    expect(Date.parse(full.serverTime)).toBeGreaterThanOrEqual(Date.parse(seeded.updatedAt!));

    await new Promise((r) => setTimeout(r, 5));
    const quiet = await list(`?updatedSince=${encodeURIComponent(full.serverTime)}`);
    expect(quiet).toMatchObject({ items: [], total: 0, nextCursor: null });

    const queued = await json<Scan>(call(srv, 'POST', `/api/projects/${projectId}/scans`, { token, body: {} }));
    const afterQueue = await list(`?updatedSince=${encodeURIComponent(quiet.serverTime)}`);
    expect(afterQueue.items.map((s) => s.id)).toEqual([queued.id]);

    await srv.jobs.waitFor(queued.id);
    const afterFinish = await list(`?updatedSince=${encodeURIComponent(afterQueue.serverTime)}`);
    expect(afterFinish.items.map((s) => s.id)).toEqual([queued.id]);
    expect(afterFinish.items[0]!.status).toBe('succeeded');
    expect(afterFinish.items[0]!.updatedAt).toBe(afterFinish.items[0]!.finishedAt);

    // The older page is still reachable with a plain cursor, and updatedSince pages too.
    const page1 = await list('?limit=1');
    expect(page1.total).toBe(2);
    const page2 = await list(`?limit=1&cursor=${page1.nextCursor}`);
    expect(page2.items[0]!.id).toBe(seeded.id);
    const since = await list(`?limit=1&updatedSince=${encodeURIComponent(seeded.createdAt)}`);
    expect(since.total).toBe(2);
    const sinceNext = await list(`?limit=1&updatedSince=${encodeURIComponent(seeded.createdAt)}&cursor=${since.nextCursor}`);
    expect(sinceNext.items[0]!.id).toBe(seeded.id);
  }, 60_000);

  it('rejects a malformed updatedSince', async () => {
    for (const bad of ['yesterday', '2026-13-45T00:00:00Z', '12345']) {
      const res = await call(srv, 'GET', `/api/projects/${projectId}/scans?updatedSince=${encodeURIComponent(bad)}`, { token });
      expect(res.status, bad).toBe(400);
    }
  });
});
