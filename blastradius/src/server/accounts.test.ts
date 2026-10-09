/**
 * Account index through the API on the offline e2e fixture (payments-platform: event-stream 3.3.6
 * published by right9ctrl, recorded packuments in test/fixtures/npm). No network: the HttpClient is
 * offline and its transport throws.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import { indexFromPackument, parseUserPackages } from '../accounts/registry.js';
import type { Packument } from '../enrich/npm/types.js';
import type { AccountDetail, AccountExposureResponse, ConcentrationResponse, MarkCompromisedResponse } from './api-types-accounts.js';
import type { IncidentDetail, ListIncidentsResponse } from './api-types-incidents.js';
import { AccountIndexer } from './accounts.js';
import { createServer, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from './serve.js';
import { accountListing, linksOfAccount, openStore, registryPackages, setAccountListing, upsertRegistryPackage } from './store/index.js';

type App = ReturnType<typeof createServer>;
let srv: App;
const cookies: Record<string, string> = {};

const offline = () =>
  new HttpClient({
    offline: true,
    fixturesDir: FIXTURES_DIR,
    cacheDir: false,
    minIntervalMs: 0,
    transport: async (req) => {
      throw new Error(`network access attempted in test: ${req.url}`);
    },
  });

async function call(method: string, path: string, opts: { as?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? { 'X-Requested-With': 'blastradius' } : {}) };
  if (opts.as) headers.Cookie = `br_session=${cookies[opts.as]}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return srv.app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}
const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;

beforeAll(async () => {
  srv = createServer({
    devMode: true,
    localRoots: [],
    offline: true,
    fixturesDir: FIXTURES_DIR,
    asOf: FIXTURE_AS_OF,
    webDir: null,
    scanOptions: { http: offline(), cacheDir: false },
    alerts: { packPath: undefined, webhookUrl: undefined },
    log: () => {},
  });
  const seed = await seedDevData(srv.deps);
  await srv.jobs.waitFor(seed.scanId!);
  await srv.deps.accounts.idle();
  for (const u of ['admin', 'appsec', 'developer', 'auditor']) {
    const res = await call('POST', '/api/auth/login', { body: { email: `${u}@local`, password: 'blastradius-dev' } });
    cookies[u] = /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  }
}, 60_000);

afterAll(() => srv.jobs.stop());

describe('registry data', () => {
  it('keeps deleted versions (time only) and the repository owner', () => {
    const p: Packument = {
      'dist-tags': { latest: '1.0.1' },
      maintainers: [{ name: 'a' }, { name: 'b' }],
      repository: { type: 'git', url: 'git+https://github.com/acme/thing.git' },
      time: { created: '2020-01-01T00:00:00Z', '1.0.0': '2020-01-01T00:00:00Z', '1.0.1': '2020-02-01T00:00:00Z', '1.0.2': '2020-03-01T00:00:00Z' },
      versions: { '1.0.0': { _npmUser: { name: 'a' }, maintainers: [{ name: 'a' }] }, '1.0.1': { _npmUser: { name: 'b' }, maintainers: [{ name: 'a' }, { name: 'b' }] } },
    };
    const x = indexFromPackument(p, 'thing');
    expect(x.maintainers).toEqual(['a', 'b']);
    expect(x.repo).toEqual({ host: 'github', owner: 'acme', url: 'https://github.com/acme' });
    expect(x.versions.map((v) => [v.v, v.u ?? null, v.m ?? null, !!v.gone])).toEqual([
      ['1.0.0', 'a', ['a'], false],
      ['1.0.1', 'b', ['a', 'b'], false],
      ['1.0.2', null, null, true],
    ]);
  });

  it('reads only write access from an account listing, and only valid names', () => {
    expect(parseUserPackages({ b: 'write', a: 'write', c: 'read', 'BAD NAME': 'write' })).toEqual(['a', 'b']);
    expect(parseUserPackages(['x'])).toEqual([]);
  });

  it('keeps the last good data when a refresh fails, and rebuilds links on success', () => {
    const s = openStore();
    upsertRegistryPackage(s, { name: 'p', maintainers: ['x'], repo: null, versions: [{ v: '1.0.0', t: '2020-01-01T00:00:00Z', u: 'x', m: ['x'] }] });
    upsertRegistryPackage(s, { name: 'p', status: 'unavailable', detail: 'HTTP 503' });
    expect(registryPackages(s, ['p']).get('p')).toMatchObject({ status: 'ok', maintainers: ['x'], detail: 'Last refresh failed: HTTP 503' });
    upsertRegistryPackage(s, { name: 'p', maintainers: ['y'], repo: null, versions: [] });
    expect(linksOfAccount(s, 'npm', 'x')).toEqual([]);
    expect(linksOfAccount(s, 'npm', 'y').map((l) => [l.package, l.relation, l.confidence])).toEqual([['p', 'maintainer', 'high']]);
    setAccountListing(s, 'y', { packages: ['p', 'q'] });
    setAccountListing(s, 'y', { unavailable: 'HTTP 429' });
    expect(accountListing(s, 'y')).toMatchObject({ status: 'ok', packages: ['p', 'q'], detail: 'Last refresh failed: HTTP 429' });
    expect(linksOfAccount(s, 'npm', 'y').map((l) => `${l.package}:${l.relation}`)).toEqual(['p:listed', 'p:maintainer', 'q:listed']);
  });

  it('does not re-fetch within the TTL and records an offline miss as unavailable', async () => {
    const s = openStore();
    let requests = 0;
    const http = new HttpClient({ offline: true, cacheDir: false, minIntervalMs: 0, fixtures: { 'https://registry.npmjs.org/known': { name: 'known', maintainers: [{ name: 'm' }], versions: {}, time: {} } }, transport: async () => {
      requests++;
      throw new Error('no network');
    } });
    const ix = new AccountIndexer(s, { http });
    expect(await ix.refreshNames(['known', 'unknown'])).toEqual({ fetched: 1, failed: 1 });
    expect(registryPackages(s, ['unknown']).get('unknown')).toMatchObject({ status: 'unavailable', detail: 'Offline: not in the recorded registry data' });
    expect(await ix.refreshNames(['known', 'unknown'])).toEqual({ fetched: 0, failed: 0 });
    expect(requests).toBe(0);
  });
});

describe('accounts API on the fixture project', () => {
  it('indexes every package of the scanned project, offline, and says which have no data', async () => {
    const d = await json<AccountDetail>(call('GET', '/api/accounts/npm/right9ctrl', { as: 'auditor' }));
    expect(d.known).toBe(true);
    const es = d.packages.find((p) => p.name === 'event-stream')!;
    expect(es).toMatchObject({ projects: 1, production: true });
    expect(es.links.map((l) => [l.relation, l.confidence])).toEqual([['maintainer', 'high']]);
    // flatmap-stream has no recorded packument: counted, never guessed.
    expect(d.index.packagesWithoutData).toBeGreaterThan(0);
    // The account's own listing is not in the fixtures: offline it is unavailable, and said so.
    await srv.deps.accounts.idle();
    const again = await json<AccountDetail>(call('GET', '/api/accounts/npm/right9ctrl', { as: 'auditor' }));
    expect(again.index.listing).toMatchObject({ status: 'unavailable', detail: 'Offline: not in the recorded registry data' });
    // Recent publishes: context only (no alert), newest first.
    expect(again.recentPublishes.slice(0, 2).map((p) => `${p.name}@${p.version}`)).toEqual(['event-stream@4.0.1', 'event-stream@4.0.0']);
    expect(again.recentPublishes.find((p) => p.version === '3.3.6')).toMatchObject({ attribution: 'npmUser', projects: 1 });
  });

  it('answers "account compromised" with the exposed project, version, reach and who published it', async () => {
    const r = await json<AccountExposureResponse>(call('GET', '/api/accounts/npm/right9ctrl/exposure?since=2018-09-01T00:00:00Z', { as: 'developer' }));
    expect(r.counts).toMatchObject({ exposures: 1, projects: 1, production: 1 });
    const e = r.exposures[0]!;
    expect(e).toMatchObject({ projectName: 'payments-platform', name: 'event-stream', version: '3.3.6', production: true, direct: true, reasons: ['can_publish', 'published_since'], confidence: 'high' });
    expect(e.publishedBy).toMatchObject({ account: 'right9ctrl', attribution: 'npmUser' });
    expect(e.owner).toBe('Payments · fixture repo');
    expect(r.publishedSince.map((p) => p.version)).toEqual(['4.0.1', '4.0.0', '3.3.6', '3.3.5']);
    // dominictarr published nothing since; before the handover it could publish event-stream.
    const old = await json<AccountExposureResponse>(call('GET', '/api/accounts/npm/dominictarr/exposure?asOf=2018-01-01T00:00:00Z', { as: 'developer' }));
    expect(old.exposures.map((x) => x.name)).toContain('event-stream');
    expect(old.historical).toBe(true);
  });

  it('validates input and checks the session first', async () => {
    expect((await call('GET', '/api/accounts/npm/right9ctrl')).status).toBe(401);
    expect((await call('GET', '/api/accounts/pypi/x', { as: 'admin' })).status).toBe(404);
    expect((await call('GET', '/api/accounts/npm/right9ctrl/exposure?since=yesterday', { as: 'admin' })).status).toBe(400);
    expect((await call('GET', '/api/accounts/npm/x/exposure?since=2020-01-02T00:00:00Z&asOf=2020-01-01T00:00:00Z', { as: 'admin' })).status).toBe(400);
  });

  it('shows the accounts that can publish the largest share of production dependencies', async () => {
    const c = await json<ConcentrationResponse>(call('GET', '/api/accounts/concentration', { as: 'auditor' }));
    expect(c.org.productionPackages).toBeGreaterThan(0);
    expect(c.org.withData).toBeLessThanOrEqual(c.org.productionPackages);
    const top = c.org.accounts[0]!;
    expect(top.share).toBe(Math.round((top.packages / c.org.withData) * 1000) / 1000);
    expect(c.projects).toHaveLength(1);
    expect(c.projects[0]!.projectName).toBe('payments-platform');
    expect(c.org.accounts.map((a) => a.name)).toContain('right9ctrl');
  });

  it('"Mark as compromised" needs review, then opens an incident listing the exposure', async () => {
    expect((await call('POST', '/api/accounts/npm/right9ctrl/compromise', { as: 'auditor', body: {} })).status).toBe(403);
    // Developer triages only in its own project; an org-wide incident needs org-scope review.
    expect((await call('POST', '/api/accounts/npm/right9ctrl/compromise', { as: 'developer', body: {} })).status).toBe(403);
    expect((await call('POST', '/api/accounts/npm/right9ctrl/compromise', { as: 'appsec', body: { since: 'nope' } })).status).toBe(400);
    const res = await call('POST', '/api/accounts/npm/right9ctrl/compromise', { as: 'appsec', body: { since: '2018-09-01T00:00:00Z' } });
    expect(res.status).toBe(201);
    const m = (await res.json()) as MarkCompromisedResponse;
    expect(m).toMatchObject({ incidentId: 'ACCOUNT-npm-right9ctrl', created: true, added: 1 });
    const list = await json<ListIncidentsResponse>(call('GET', '/api/incidents', { as: 'auditor' }));
    const row = list.items.find((i) => i.id === 'ACCOUNT-npm-right9ctrl')!;
    expect(row).toMatchObject({ level: 'critical', affected: 1, production: 1, account: { registry: 'npm', name: 'right9ctrl', since: '2018-09-01T00:00:00.000Z' } });
    const d = await json<IncidentDetail>(call('GET', '/api/incidents/ACCOUNT-npm-right9ctrl', { as: 'developer' }));
    expect(d.hits.map((h) => `${h.name}@${h.version}`)).toEqual(['event-stream@3.3.6']);
    expect(d.timeline.map((e) => e.kind)).toEqual(['alert', 'account']);
    const detail = await json<AccountDetail>(call('GET', '/api/accounts/npm/right9ctrl', { as: 'auditor' }));
    expect(detail.incident).toMatchObject({ id: 'ACCOUNT-npm-right9ctrl', status: 'investigating', since: '2018-09-01T00:00:00.000Z' });
  });

  it('opens no incident when nothing in your projects is exposed', async () => {
    const res = await call('POST', '/api/accounts/npm/nobody-at-all/compromise', { as: 'admin', body: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as MarkCompromisedResponse).incidentId).toBeNull();
  });
});
