/**
 * Tier 0 web checks through the API on recorded real data (teardown problems 6 and 7, and the
 * account pivot): parse-server at the pinned commit 23d7bbca, its real scan result and inventory,
 * live npm packuments and OSV answers recorded by test/entities/record-server.ts. No network.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IndexedPackage } from '../../src/accounts/registry.js';
import { HttpClient } from '../../src/core/http.js';
import type { Inventory, ScanResult } from '../../src/core/types.js';
import { renderHtml } from '../../src/report/html.js';
import type { AccountDetail, AccountExposureResponse } from '../../src/server/api-types-accounts.js';
import type { PackageBehindResponse } from '../../src/server/api-types-incidents.js';
import { createServer, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from '../../src/server/serve.js';
import { completeScan, createProject, enqueueScan, listOrgsForUser, markScanRunning, upsertRegistryAdvisories, upsertRegistryPackage, type MalwareAdvisory } from '../../src/server/store/index.js';

interface Fixture {
  commit: string;
  result: ScanResult;
  inventory: Inventory;
  registry: IndexedPackage[];
  advisories: { name: string; malware: MalwareAdvisory[] }[];
}
const fx = JSON.parse(gunzipSync(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'entities', 'parse-server-server.json.gz'))).toString('utf8')) as Fixture;

type App = ReturnType<typeof createServer>;
let srv: App;
const cookies: Record<string, string> = {};

async function call(method: string, url: string, opts: { as?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? { 'X-Requested-With': 'blastradius' } : {}) };
  if (opts.as) headers.Cookie = `br_session=${cookies[opts.as]}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return srv.app.request(url, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}
const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;
const behind = (name: string, as = 'auditor') => json<PackageBehindResponse>(call('GET', `/api/packages/behind?name=${encodeURIComponent(name)}`, { as }));

beforeAll(async () => {
  srv = createServer({
    devMode: true,
    localRoots: [],
    offline: true,
    fixturesDir: FIXTURES_DIR,
    asOf: FIXTURE_AS_OF,
    webDir: null,
    scanOptions: {
      http: new HttpClient({ offline: true, fixturesDir: FIXTURES_DIR, cacheDir: false, minIntervalMs: 0, transport: async (req) => { throw new Error(`network access attempted in test: ${req.url}`); } }),
      cacheDir: false,
    },
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
  // The real parse-server scan, stored as a web scan would store it.
  const store = srv.deps.store;
  const admin = (store.db.prepare("SELECT id FROM app_user WHERE email = 'admin@local'").get() as { id: string }).id;
  const orgId = listOrgsForUser(store, admin)[0]!.id;
  const p = createProject(store, orgId, { name: 'parse-server', tier: 'Standard', target: 'https://github.com/parse-community/parse-server' }, admin);
  const scan = enqueueScan(store, orgId, p.id, { requestedBy: admin });
  markScanRunning(store, scan.id);
  completeScan(store, scan.id, { result: fx.result, inventory: fx.inventory, commit: fx.commit });
  for (const r of fx.registry) upsertRegistryPackage(store, r);
  for (const a of fx.advisories) upsertRegistryAdvisories(store, a.name, { malware: a.malware });
}, 120_000);

afterAll(() => srv.jobs.stop());

describe('fixture', () => {
  it('is the real parse-server scan at the pinned commit', () => {
    expect(fx.commit).toBe('23d7bbca9a6c9bdebdb12d166544375a83ef47fc');
    expect(fx.inventory.components.length).toBeGreaterThan(1000);
    expect(fx.result.health!.length).toBeGreaterThan(1000);
  });
});

describe('GET /api/packages/behind reads the health graph (problem 6)', () => {
  it('debug: qix, tootallnate and debug-js with evidence, the same as the CLI JSON', async () => {
    const b = await behind('debug');
    const pairs = b.links.filter((l) => l.from === 'pkg:npm/debug').map((l) => `${l.relation} ${l.entityId}`);
    expect(pairs).toEqual(expect.arrayContaining(['maintains account:npm/qix', 'maintains account:npm/tootallnate', 'owns owner:github/debug-js']));
    for (const l of b.links) expect(l.evidence.length).toBeGreaterThan(0);
    // The CLI JSON's health entry for debug has the same links.
    const cli = fx.result.health!.find((h) => h.purl.startsWith('pkg:npm/debug@'))!.behind!.map((e) => `${e.relation} ${e.entityId}`);
    for (const p of cli) expect(pairs).toContain(p);
    expect(b.publishRights?.map((a) => a.account)).toEqual(['qix', 'tootallnate']);
    expect(b.lockedVersions.length).toBeGreaterThan(0);
    for (const v of b.lockedVersions) expect(v.publisher?.account).toMatch(/^(qix|tootallnate)$/);
  });

  it('chalk and express are not empty; links are machine-derived until a person reviews them', async () => {
    for (const name of ['chalk', 'express']) {
      const b = await behind(name);
      expect(b.links.length).toBeGreaterThan(0);
      expect(b.links.every((l) => !l.reviewed && l.method === 'deterministic')).toBe(true);
      expect(b.review).toEqual({ machineDerived: b.links.length, reviewed: 0, rejected: 0 });
    }
    const chalk = await behind('chalk');
    expect(JSON.stringify(chalk)).not.toMatch(/casino|funder:|"funds"/);
    expect(chalk.links.some((l) => l.entityId.startsWith('org:'))).toBe(false);
  });

  it('a review decision is the only way a link becomes reviewed (needs Triage)', async () => {
    const link = { package: 'debug', from: 'pkg:npm/debug', relation: 'maintains', to: 'account:npm/qix' };
    expect((await call('POST', '/api/packages/behind/review', { as: 'auditor', body: { ...link, decision: 'accept' } })).status).toBe(403);
    const after = await json<PackageBehindResponse>(call('POST', '/api/packages/behind/review', { as: 'appsec', body: { ...link, decision: 'accept', note: 'npm profile checked' } }));
    const qix = after.links.find((l) => l.entityId === 'account:npm/qix')!;
    expect(qix.reviewed).toBe(true);
    expect(qix.review).toMatchObject({ by: expect.any(String), note: 'npm profile checked' });
    expect(after.review.reviewed).toBe(1);
    const rejected = await json<PackageBehindResponse>(call('POST', '/api/packages/behind/review', { as: 'appsec', body: { ...link, to: 'account:npm/tootallnate', decision: 'reject' } }));
    expect(rejected.links.some((l) => l.entityId === 'account:npm/tootallnate')).toBe(false);
    expect(rejected.review.rejected).toBe(1);
    const cleared = await json<PackageBehindResponse>(call('POST', '/api/packages/behind/review', { as: 'appsec', body: { ...link, decision: 'clear' } }));
    expect(cleared.links.find((l) => l.entityId === 'account:npm/qix')!.reviewed).toBe(false);
    await call('POST', '/api/packages/behind/review', { as: 'appsec', body: { ...link, to: 'account:npm/tootallnate', decision: 'clear' } });
    expect((await call('POST', '/api/packages/behind/review', { as: 'appsec', body: { ...link, from: 'javascript:alert(1)', decision: 'accept' } })).status).toBe(400);
  });
});

describe('account pivot: /api/accounts/npm/qix', () => {
  it('links the KB incident and OSV MAL entries, and flags the bad versions in place', async () => {
    const d = await json<AccountDetail>(call('GET', '/api/accounts/npm/qix', { as: 'auditor' }));
    const kb = d.knownBad.find((k) => k.id === 'INC-2025-0002')!;
    expect(kb.source).toBe('kb');
    expect(kb.packages).toEqual(expect.arrayContaining([{ name: 'color-convert', versions: ['3.1.1'] }, { name: 'debug', versions: ['4.4.2'] }]));
    // OSV MAL records for the same versions fold into the KB entry as aliases.
    expect(kb.aliases).toEqual(expect.arrayContaining(['MAL-2025-46971']));
    const flagged = d.recentPublishes.filter((p) => p.knownBad.length > 0).map((p) => `${p.name}@${p.version}`);
    expect(flagged).toEqual(expect.arrayContaining(['color-convert@3.1.1']));
    expect(d.recentPublishes.find((p) => p.name === 'color-convert' && p.version === '3.1.1')!.knownBad[0]!.id).toBe('INC-2025-0002');
    // A good version is never flagged.
    expect(d.recentPublishes.find((p) => p.name === 'debug' && p.version === '4.4.3')?.knownBad ?? []).toEqual([]);
    expect(d.packages.find((p) => p.name === 'color-convert')!.knownBad.map((k) => k.id)).toContain('INC-2025-0002');
  });

  it('reconciles the counts: one unit (package names), and the share counts what the list shows', async () => {
    const d = await json<AccountDetail>(call('GET', '/api/accounts/npm/qix', { as: 'auditor' }));
    expect(d.counts.canPublish).toBe(d.packages.length);
    expect(d.counts.canPublishInProduction).toBe(d.packages.filter((p) => p.production).length);
    expect(d.concentration.packages).toBe(d.counts.canPublishInProduction);
    expect(d.concentration.packages).toBeLessThanOrEqual(d.counts.canPublishInYourProjects);
    const x = await json<AccountExposureResponse>(call('GET', '/api/accounts/npm/qix/exposure', { as: 'auditor' }));
    expect(x.counts.packagesInYourProjects).toBe(d.counts.canPublishInYourProjects);
    expect(x.knownBad.map((k) => k.id)).toContain('INC-2025-0002');
  });
});

describe('HTML report (real result)', () => {
  const html = renderHtml(fx.result);
  it('has Who is behind and Stability sections, machine-derived links labelled as such', () => {
    expect(html).toContain('<h2 id="who-is-behind">Who is behind</h2>');
    expect(html).toContain('<h2 id="stability">Stability</h2>');
    expect(html).toMatch(/Accounts that can publish the most production packages/);
    expect(html).toContain('machine-derived (deterministic)');
    expect(html).not.toMatch(/casinoacademia/);
    // GitHub answered 403 while recording: every owner is "type unknown", none is an organisation.
    expect(html).toMatch(/<td>type unknown<\/td>/);
    expect(html).not.toMatch(/<td>organisation<\/td>/);
    expect(html).toMatch(/<code>npm\/ljharb<\/code><\/td><td class="num">37</);
    expect(html).toContain('Fragile in production');
  });

  it('shows the NOT ANALYSED banner only when the result lists unanalysed manifests', () => {
    expect(html).not.toContain('NOT ANALYSED');
    const flagged = renderHtml({ ...fx.result, notAnalysed: [{ file: 'requirements.txt', ecosystem: 'pypi', reason: 'Python is not analysed', packages: 12 }] } as ScanResult);
    expect(flagged).toContain('NOT ANALYSED: 1 manifest(s), about 12 package(s).');
    const viaCoverage = renderHtml({ ...fx.result, coverage: { notAnalysed: [{ file: 'uv.lock', ecosystem: 'pypi', reason: 'not supported' }] } } as ScanResult);
    expect(viaCoverage).toContain('<code>uv.lock</code>');
  });
});
