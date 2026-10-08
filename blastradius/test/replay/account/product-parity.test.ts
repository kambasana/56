/**
 * G1, product parity with the account-level proof (docs/ACCOUNT-PROOF.md H1): the product's own
 * account index and "account compromised" API, fed the recorded registry data offline, must name
 * what the proof named for chalk/debug (account qix) at the debug advisory time:
 *   - all 19 bad packages among the packages qix could publish;
 *   - over the two recorded orgs (acme + exposure-2025), 204 package-level exposures where the
 *     advisories existing then named 21, at precision 1.0, and all 21 locked bad versions.
 *
 * The registry is replayed from test/replay/account/data: each recorded package timeline is served
 * back in the packument shape npm serves (time, versions[v]._npmUser.name, versions[v].maintainers;
 * deleted versions only in `time`), and each recorded account listing as /-/user/<name>/package.
 * The HttpClient is offline and its transport throws, so no request leaves the process.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../../../src/core/http.js';
import { isValidNpmName, packumentUrl } from '../../../src/enrich/npm/registry.js';
import { userPackagesUrl } from '../../../src/accounts/registry.js';
import { scan } from '../../../src/pipeline.js';
import { createServer } from '../../../src/server/serve.js';
import { AccountIndexer } from '../../../src/server/accounts.js';
import { completeScan, createProject, enqueueScan, markScanRunning, seedDev } from '../../../src/server/store/index.js';
import { makeResult } from '../../../src/server/store/testing.js';
import type { AccountExposureResponse, MarkCompromisedResponse } from '../../../src/server/api-types-accounts.js';
import type { IncidentDetail } from '../../../src/server/api-types-incidents.js';
import { AccountIndex, accountExposure as proofExposure, type PackageTimeline } from '../../../src/watch/account.js';
import type { StoredInventory } from '../../../src/watch/match.js';
import { orgInventories } from '../org.js';
import { decodeTimelines, type EncodedTimelines } from './timelines.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const load = <T>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8')) as T;

interface Adv { id: string; published: string; name: string; versions: string[]; group: string[] }

/** A recorded timeline in the packument shape (only the recorded fields). */
function packumentOf(tl: PackageTimeline): Record<string, unknown> {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  for (const e of tl.versions) {
    time[e.v] = e.t;
    if (e.gone) continue;
    versions[e.v] = { name: tl.name, version: e.v, ...(e.u ? { _npmUser: { name: e.u } } : {}), ...(e.m ? { maintainers: e.m.map((name) => ({ name })) } : {}) };
  }
  return { name: tl.name, versions, time };
}

const timelines = decodeTimelines(load<EncodedTimelines>('timelines.json'));
const advisories = load<Adv[]>('advisories.json');
const accounts = load<Record<string, { packages: string[] }>>('accounts.json');

const fixtures: Record<string, unknown> = {};
// A few recorded names are not valid npm names (the registry has odd legacy ones); the product never asks for them.
for (const tl of timelines) if (isValidNpmName(tl.name)) fixtures[packumentUrl(tl.name)] = tl.missing ? { status: 404, response: { error: 'Not found' } } : packumentOf(tl);
for (const [name, a] of Object.entries(accounts)) fixtures[userPackagesUrl(name)] = Object.fromEntries(a.packages.map((p) => [p, 'write']));

const http = new HttpClient({
  offline: true,
  fixtures,
  cacheDir: false,
  minIntervalMs: 0,
  transport: async (req) => {
    throw new Error(`network access attempted in test: ${req.url}`);
  },
});

// The pre-registered chalk/debug bad set (PREREGISTRATION.md, as in proof-account.ts): versions named
// by a chalk-week advisory, published on 2025-09-08, of a package qix maintained that day.
const proofIndex = new AccountIndex(timelines);
const qixAt = Date.parse('2025-09-08T12:00:00Z');
const bad = new Map<string, Set<string>>();
for (const a of advisories.filter((x) => x.group.includes('chalk-week')))
  for (const v of a.versions) {
    const t = proofIndex.timeline(a.name)?.versions.find((e) => e.v === v)?.t;
    if (t?.startsWith('2025-09-08') && proofIndex.maintainersAt(a.name, qixAt)?.includes('qix')) (bad.get(a.name) ?? bad.set(a.name, new Set()).get(a.name)!).add(v);
  }
const firstAdvisory = (n: string) => Math.min(...advisories.filter((a) => a.name === n && a.group.includes('chalk-week')).map((a) => Date.parse(a.published)));
const T0 = Math.min(...[...bad.keys()].map(firstAdvisory));
const T0_ISO = new Date(T0).toISOString();

let srv: ReturnType<typeof createServer>;
let cookie = '';
/** Project id → recorded repo id, and the inventories exactly as the proof used them. */
const repoOf = new Map<string, string>();
let proofInvs: StoredInventory[] = [];

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await srv.app.request(path, {
    method,
    headers: { cookie, 'x-requested-with': 'test', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  // The two recorded orgs, as in proof-account.ts: acme (test/replay/data/org) and the exposure-2025
  // repos (controls are not part of the exposure comparison).
  const manifest = load<{ items: { kind: string; repo?: string; role?: string }[] }>('manifest.json');
  const invs: StoredInventory[] = await orgInventories();
  for (const d of readdirSync(join(DATA, 'org')).sort()) {
    const repo = d.replace('__', '/');
    if (manifest.items.find((i) => i.kind === 'repo' && i.repo === repo)?.role === 'control') continue;
    const res = await scan({ target: join(DATA, 'org', d), formats: [], offline: true, cacheDir: false, enrichers: () => [] });
    invs.push({ projectId: repo, projectName: repo, inventory: res.inventory });
  }
  proofInvs = invs;

  srv = createServer({ devMode: true, webDir: null, localRoots: [], accounts: { http, ttlMs: 365 * 24 * 3_600_000 }, log: () => {} });
  const seed = await seedDev(srv.store, { devMode: true });
  const admin = seed.users.find((u) => u.role === 'org_admin')!;
  for (const inv of invs) {
    const p = createProject(srv.store, seed.org.id, { name: inv.projectId.replace('/', ' · '), tier: 'Standard', target: `/replay/${inv.projectId}`, owner: `owner of ${inv.projectId}` }, admin.id);
    repoOf.set(p.id, inv.projectId);
    const sc = enqueueScan(srv.store, seed.org.id, p.id, { requestedBy: admin.id, offline: true });
    markScanRunning(srv.store, sc.id);
    completeScan(srv.store, sc.id, { result: makeResult([], `/replay/${inv.projectId}`), inventory: inv.inventory });
  }
  // What the server does after each scan, for every project at once.
  for (const p of repoOf.keys()) srv.deps.accounts.afterScan(p);
  await srv.deps.accounts.idle();
  const login = await srv.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'test' },
    body: JSON.stringify({ email: 'appsec@local', password: seed.password }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  expect(login.status).toBe(200);
}, 600_000);

afterAll(() => srv?.jobs.stop());

describe('G1: the product names what the account-level proof named (qix, chalk/debug)', () => {
  let r: AccountExposureResponse;

  beforeAll(async () => {
    // Siblings: the account's own listing and its packages' histories, as the Account page fetches them.
    await srv.deps.accounts.refreshAccount('qix');
    const res = await call<AccountExposureResponse>('GET', `/api/accounts/npm/qix/exposure?asOf=${encodeURIComponent(T0_ISO)}`);
    expect(res.status).toBe(200);
    r = res.body;
  }, 120_000);

  it('asks at the debug advisory time', () => {
    expect(T0_ISO).toBe('2025-09-08T14:26:51.000Z');
    expect(bad.size).toBe(19);
    expect(r.historical).toBe(true);
    expect(r.asOf).toBe(T0_ISO);
    expect(r.projectsSearched).toBe(proofInvs.length);
  });

  it("with today's npm listing of qix, names 18 of the 19 bad packages (chalk-template changed owner later)", () => {
    const named = new Set(r.packages.map((p) => p.name));
    expect([...bad.keys()].filter((n) => !named.has(n))).toEqual(['chalk-template']);
    expect(accounts.qix!.packages).not.toContain('chalk-template');
    expect(r.packages.every((p) => p.links.some((l) => l.relation === 'version_maintainer' && l.confidence === 'high'))).toBe(true);
  });

  it('with the listing npm would have answered at T0, names all 19 bad packages', async () => {
    // The recorded listing is today's. What /-/user/qix/package answered at T0 is reconstructed from
    // recorded data only: today's list plus every recorded package whose maintainers at T0 include qix
    // (the proof's own candidate rule). The product fetches it through the same indexer path.
    const atT0 = [...new Set([...accounts.qix!.packages, ...proofIndex.packagesOf('qix', T0)])];
    const httpT0 = new HttpClient({ offline: true, fixtures: { ...fixtures, [userPackagesUrl('qix')]: Object.fromEntries(atT0.map((p) => [p, 'write'])) }, cacheDir: false, minIntervalMs: 0, transport: async (req) => {
      throw new Error(`network access attempted in test: ${req.url}`);
    } });
    await new AccountIndexer(srv.store, { http: httpT0, ttlMs: 0 }).refreshAccount('qix');
    const res = await call<AccountExposureResponse>('GET', `/api/accounts/npm/qix/exposure?asOf=${encodeURIComponent(T0_ISO)}`);
    const named = new Set(res.body.packages.map((p) => p.name));
    expect([...bad.keys()].filter((n) => !named.has(n))).toEqual([]);
    expect(res.body.counts.packages).toBe(proofIndex.packagesOf('qix', T0).length);
    expect(res.body.counts.exposures).toBe(204);
  });

  it('names 204 exposures in the two orgs where the advisories then named 21, at precision 1.0', () => {
    const advisedAtT0 = new Set([...bad.keys()].filter((n) => firstAdvisory(n) <= T0));
    const exBad = r.exposures.filter((e) => bad.has(e.name));
    expect(r.counts.exposures).toBe(204);
    expect(exBad).toHaveLength(204);
    expect(exBad.length / r.exposures.length).toBe(1);
    expect(r.exposures.filter((e) => advisedAtT0.has(e.name))).toHaveLength(21);
    console.log(`G1 qix@${T0_ISO}: exposures ${r.counts.exposures} (bad ${exBad.length}, named by advisories at T0 ${r.exposures.filter((e) => advisedAtT0.has(e.name)).length}), precision ${exBad.length / r.exposures.length}, projects ${r.counts.projects} (${r.counts.production} production), packages it could publish ${r.counts.packages}, inventory packages indexed ${r.index.packagesIndexed}, without data ${r.index.packagesWithoutData}`);
  });

  it('is the same set of (project, package version) the proof query named', () => {
    const proof = proofExposure(proofInvs, proofIndex, 'qix', T0).hits.map((h) => `${h.projectId} ${h.purl}`).sort();
    const product = r.exposures.map((e) => `${repoOf.get(e.projectId)} ${e.purl}`).sort();
    expect(product).toEqual(proof);
    // Production / dev agrees with the proof's reach too.
    const prodProof = new Map(proofExposure(proofInvs, proofIndex, 'qix', T0).hits.map((h) => [`${h.projectId} ${h.purl}`, h.production] as const));
    expect(r.exposures.filter((e) => prodProof.get(`${repoOf.get(e.projectId)} ${e.purl}`) !== e.production)).toEqual([]);
  });

  it('names all 21 locked bad versions, with who brought each in and the owner', () => {
    const hits = r.exposures.filter((e) => bad.get(e.name)?.has(e.version));
    expect(new Set(hits.map((h) => `${h.projectId} ${h.name}@${h.version}`)).size).toBe(21);
    for (const e of r.exposures) {
      expect(e.owner).toMatch(/^owner of /);
      expect(e.direct || e.broughtInBy.length > 0).toBe(true);
    }
  });

  it('with since (the attack day) also lists the versions qix published, and flags the locked ones', async () => {
    const since = '2025-09-08T00:00:00.000Z';
    const res = await call<AccountExposureResponse>('GET', `/api/accounts/npm/qix/exposure?asOf=${encodeURIComponent(T0_ISO)}&since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
    const w = res.body;
    expect(w.counts.exposures).toBe(204);
    for (const p of w.publishedSince) expect(bad.get(p.name)?.has(p.version)).toBe(true);
    const flagged = w.exposures.filter((e) => e.reasons.includes('published_since'));
    for (const e of flagged) expect(bad.get(e.name)?.has(e.version)).toBe(true);
    expect(flagged.every((e) => e.publishedBy?.account === 'qix')).toBe(true);
  });

  it('"Mark as compromised" opens an incident listing every exposure it names now', async () => {
    const res = await call<MarkCompromisedResponse>('POST', '/api/accounts/npm/qix/compromise', { since: '2025-09-08T00:00:00Z' });
    expect(res.status).toBe(201);
    expect(res.body.incidentId).toBe('ACCOUNT-npm-qix');
    const inc = await call<IncidentDetail>('GET', '/api/incidents/ACCOUNT-npm-qix');
    expect(inc.status).toBe(200);
    expect(inc.body.hits).toHaveLength(res.body.exposure.counts.exposures);
    expect(inc.body.account).toEqual({ registry: 'npm', name: 'qix', since: '2025-09-08T00:00:00.000Z' });
    expect(inc.body.timeline.some((e) => e.kind === 'account')).toBe(true);
    // Marking again updates the same incident and adds nothing new.
    const again = await call<MarkCompromisedResponse>('POST', '/api/accounts/npm/qix/compromise', { since: '2025-09-08T00:00:00Z' });
    expect([again.status, again.body.created, again.body.added]).toEqual([200, false, 0]);
  });
});
