/**
 * Tier 0.5 gates (docs/WHO-BEHIND-PLAN.md §11, "Tier 0.5") on recorded real data: lockfile slices
 * of parse-server, jitsi-meet and superset at the pinned commits (test/tier05/targets.ts) with the
 * OSV, deps.dev and npm answers recorded for them (test/tier05/record.ts), replayed offline.
 * Each block is one item of the independent verification of Tier 0.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isFactOf, makeFact, npmPurl, type Fact, type Finding, type ScanResult, type StabilityReport } from '../../src/core/types.js';
import { isNonRepositoryUrl, nonRegistryTarball, productNameOf } from '../../src/core/repo-url.js';
import { componentScopes, isProductionScope, productionSet } from '../../src/core/scope.js';
import { normalizeRepoUrl, repoOf } from '../../src/enrich/depsdev/index.js';
import { parseRepoUrl } from '../../src/enrich/npm/repo.js';
import { deriveMaintainerChanges, packumentFacts, versionHistory } from '../../src/enrich/npm/packument.js';
import { slimPackument } from '../../src/enrich/npm/registry.js';
import { markSiblingMaintainers } from '../../src/enrich/npm/siblings.js';
import type { Packument } from '../../src/enrich/npm/types.js';
import { isPostureReason, scoreIntrinsic } from '../../src/scoring/index.js';
import { renderHtml } from '../../src/report/html.js';
import { resolveEntities } from '../../src/entities/resolve.js';
import { renderCycloneDx, renderSpdx } from '../../src/report/sbom.js';
import { toSarif } from '../../src/report/sarif.js';
import { formatSummary } from '../../src/summary.js';
import { HttpClient } from '../../src/core/http.js';
import { createServer, seedDevData, serve, DEV_PROJECT_NAME } from '../../src/server/serve.js';
import { completeScan, createProject, enqueueScan, listOrgsForUser, listProjects, markScanRunning } from '../../src/server/store/index.js';
import type { PackageBehindResponse } from '../../src/server/api-types-incidents.js';
import type { OrgHomeResponse, OverviewResponse } from '../../src/server/api-types.js';
import { loadFixture, replay, FIX05, type Tier05Fixture } from './replay.js';
import { TIER05_NOW } from './targets.js';

type Replay = Awaited<ReturnType<typeof replay>>;
const runs: Record<string, Replay> = {};
const dirs: string[] = [];
beforeAll(async () => {
  for (const id of ['parse-server', 'jitsi-meet', 'superset']) {
    runs[id] = await replay(id);
    dirs.push(path.dirname(runs[id]!.dir));
  }
}, 240_000);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const finding = (r: Replay, purl: string) => r.result.findings.find((f) => f.purl === purl);
const factsOf = <K extends Fact['kind']>(r: Replay, purl: string, kind: K) => r.facts.filter(isFactOf(kind)).filter((f) => f.subject === purl);
/** Reasons that are signals (not posture, not context) with a value. */
const signals = (f: Finding) => f.reasons.filter((r) => r.value > 0 && !isPostureReason(r));
/** The recorded (slimmed) packument of `name` from a fixture. */
function packument(fx: Tier05Fixture, name: string): Packument {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  const e = fx.http.find((x) => x.request.url === url || x.request.url === `https://registry.npmjs.org/${name}`);
  if (!e) throw new Error(`no recorded packument for ${name}`);
  return e.response as Packument;
}

describe('fixtures', () => {
  it('are the pinned commits of the teardown scans', () => {
    expect(runs['parse-server']!.fx.commit).toBe('23d7bbca9a6c9bdebdb12d166544375a83ef47fc');
    expect(runs['jitsi-meet']!.fx.commit).toBe('36d4c1c7945016ecc588338ac0dff82cd060bbbf');
    expect(runs['superset']!.fx.commit).toBe('42bbfa49079eff910ead01b7880b94d09c5ca520');
  });
});

describe('1 · provenance is compared stable to stable on one release line', () => {
  it('react-native-screens 4.23.0 (jitsi) is not flagged: its stable predecessor 4.22.0 had no provenance, only nightlies did', () => {
    const r = runs['jitsi-meet']!;
    const purl = npmPurl('react-native-screens', '4.23.0');
    const prov = factsOf(r, purl, 'provenance'); // npm and deps.dev
    expect(prov.length).toBeGreaterThan(0);
    for (const f of prov) {
      expect(f.value.hasProvenance).toBe(false);
      expect(f.value.droppedSince).toBeUndefined();
    }
    expect(finding(r, purl)?.reasons.some((x) => x.factor === 'provenance_dropped') ?? false).toBe(false);
    // Before: "the previous release (4.23.0-nightly-20260205-271111791) had" provenance.
    expect(JSON.stringify(r.result)).not.toMatch(/nightly-20260205/);
  });

  it('@typescript-eslint/* 7.18.0 (parse-server) and 8.19.1 (jitsi) are not flagged: no stable 7.x / 8.x release had provenance, only canaries', () => {
    for (const [id, v] of [
      ['parse-server', '7.18.0'],
      ['jitsi-meet', '8.19.1'],
    ] as const) {
      const r = runs[id]!;
      const purls = r.inventory.components.filter((c) => c.name.startsWith('@typescript-eslint/') && c.version === v).map((c) => c.purl);
      expect(purls.length, id).toBeGreaterThan(0);
      for (const purl of purls) {
        for (const f of factsOf(r, purl, 'provenance')) expect(f.value.droppedSince, purl).toBeUndefined();
      }
    }
    for (const r of Object.values(runs)) for (const f of [...r.result.findings, ...(r.result.health ?? [])]) expect(f.reasons.some((x) => x.factor === 'provenance_dropped'), f.purl).toBe(false);
  });

  it('a real drop still counts: nx 21.5.0 (published with a stolen token) lost the provenance 21.4.1 had (recorded replay data)', () => {
    const nx = slimPackument(JSON.parse(readFileSync(fileURLToPath(new URL('../replay/data/registry/nx.json', import.meta.url)), 'utf8')) as Record<string, unknown>);
    const at = new Date(Date.parse(String((nx.time as Record<string, string>)['21.5.0'])) + 3_600_000);
    const prov = packumentFacts(nx, 'nx', '21.5.0', { now: at }).filter(isFactOf('provenance'))[0]!;
    expect(prov.value.hasProvenance).toBe(false);
    expect(prov.value.droppedSince).toMatch(/^21\.4\./);
  });

  it('a stable-to-stable drop years ago is context: jose 4.15.5 (2024 backport) lost 4.15.4\'s provenance; scored in full only while fresh', () => {
    const { packument: jose } = JSON.parse(gunzipSync(readFileSync(path.join(FIX05, 'jose-packument.json.gz'))).toString('utf8')) as { packument: Packument };
    const comp = { purl: npmPurl('jose', '4.15.5'), ecosystem: 'npm' as const, name: 'jose', version: '4.15.5' };
    const facts = packumentFacts(jose, 'jose', '4.15.5', { now: TIER05_NOW });
    expect(facts.filter(isFactOf('provenance'))[0]!.value.droppedSince).toBe('4.15.4');
    const now = scoreIntrinsic(comp, facts, { now: TIER05_NOW }).reasons.find((x) => x.factor === 'provenance_dropped')!;
    expect(now.value).toBe(0);
    const at = new Date(Date.parse(String((jose.time as Record<string, string>)['4.15.5'])) + 3_600_000);
    const fresh = scoreIntrinsic(comp, packumentFacts(jose, 'jose', '4.15.5', { now: at }), { now: at }).reasons.find((x) => x.factor === 'provenance_dropped')!;
    expect(fresh.value).toBeGreaterThan(0.99);
  });

  it('jitsi: the real advisories (svgo CVSS 8.2, bigint-buffer CVSS 7.5) rank first, above every posture- or provenance-only item', () => {
    const r = runs['jitsi-meet']!;
    const top3 = r.result.findings.slice(0, 3).map((f) => f.purl);
    expect(top3.sort()).toEqual([npmPurl('bigint-buffer', '1.1.5'), npmPurl('svgo', '2.8.3'), npmPurl('svgo', '3.3.4')].sort());
    for (const p of top3) expect(finding(r, p)!.reasons[0]!.factor).toBe('vuln');
    const lastCve = Math.max(...top3.map((p) => r.result.findings.findIndex((f) => f.purl === p)));
    r.result.findings.forEach((f, i) => {
      const weak = signals(f).every((x) => x.factor === 'provenance_dropped');
      if (weak) expect(i, f.purl).toBeGreaterThan(lastCve);
    });
  });
});

describe('2 · maintainer changes: real diffs, the stability exemptions, and context unless backed by another signal', () => {
  it('mongodb-connection-string-url 7.0.2: never "removed devtoolsbot, added dariakp" (the trusted-publishing release stored 3 of 8 maintainers)', () => {
    const r = runs['parse-server']!;
    const changes = factsOf(r, npmPurl('mongodb-connection-string-url', '7.0.2'), 'maintainer_change');
    const text = JSON.stringify(changes.map((c) => c.value));
    expect(text).not.toMatch(/devtoolsbot|dariakp/);
    // Every remaining change agrees with the packument's current maintainers.
    const current = new Set((packument(r.fx, 'mongodb-connection-string-url').maintainers as { name: string }[]).map((m) => m.name));
    for (const c of changes) {
      for (const a of c.value.added) expect(current.has(a), a).toBe(true);
      for (const x of c.value.removed) expect(current.has(x), x).toBe(false);
    }
    // The trusted-publishing release's own list is what produced the wrong text.
    const hist = versionHistory(packument(r.fx, 'mongodb-connection-string-url'), TIER05_NOW);
    expect(hist.find((h) => h.version === '7.0.2')!.trustedPublisher).toBe(true);
    const naive = deriveMaintainerChanges(hist.map((h) => ({ ...h, trustedPublisher: false })), '7.0.2');
    expect(JSON.stringify(naive)).toMatch(/dariakp/);
  });

  it('proxy-addr "added ulisesgascon": he maintains forwarded and the other jshttp / expressjs packages, a team event (owner sibling)', () => {
    const r = runs['superset']!;
    const purl = npmPurl('proxy-addr', '2.0.8');
    // The current derivation reads no list from the trusted-publishing release 2.0.8.
    expect(factsOf(r, purl, 'maintainer_change')).toEqual([]);
    // The change Tier 0 derived from that list is still a team event under the stability exemptions.
    const old = makeFact('maintainer_change', purl, { added: ['ulisesgascon'], removed: [], changedAt: '2026-09-15T00:00:00Z', version: '2.0.8' }, { source: 'npm', fetchedAt: TIER05_NOW, evidence: ['https://www.npmjs.com/package/proxy-addr'] });
    const facts = [...r.facts.filter((f) => f.kind !== 'maintainer_change' && f.kind !== 'publisher_change'), old];
    markSiblingMaintainers(facts);
    expect(old.value.sibling?.by).toBe('owner');
    expect(old.value.sibling!.packages).toBeGreaterThanOrEqual(5);
    expect(finding(r, purl)).toBeUndefined();
  });

  it('a maintainer change alone is context: fast-uri "removed simoneb" and ws "removed 3rdeden, einaros, v1" are not findings', () => {
    for (const [id, purl, text] of [
      ['superset', npmPurl('fast-uri', '3.1.8'), 'removed simoneb'],
      ['parse-server', npmPurl('ws', '8.21.3'), 'removed 3rdeden, einaros, v1'],
    ] as const) {
      const r = runs[id]!;
      expect(finding(r, purl), purl).toBeUndefined();
      const h = r.result.health!.find((x) => x.purl === purl)!;
      const mc = h.reasons.find((x) => x.factor === 'maintainer_change')!;
      expect(mc.detail).toContain(text);
      expect(mc.context).toBe(true);
    }
  });

  it('no finding in the three replays has a maintainer change as its top reason or as its only signal', () => {
    for (const r of Object.values(runs)) {
      for (const f of r.result.findings) {
        expect(f.reasons[0]?.factor, f.purl).not.toBe('maintainer_change');
        const s = signals(f);
        expect(s.length === 1 && s[0]!.factor === 'maintainer_change', f.purl).toBe(false);
      }
    }
    expect(runs['superset']!.result.findings[0]!.purl).toBe(npmPurl('xlsx', '0.20.3'));
  });

  it('a new publisher who already maintains the scope is not a new person: madccc on @rc-component/* (superset)', () => {
    const r = runs['superset']!;
    const steps = r.inventory.components.find((c) => c.name === '@rc-component/steps')!;
    const pc = factsOf(r, steps.purl, 'publisher_change')[0]!;
    expect(pc.value.newPublisher).toBe('madccc');
    expect(pc.value.sibling?.by).toBe('scope');
    for (const f of r.result.findings) expect(f.reasons.some((x) => x.factor === 'publisher_change'), f.purl).toBe(false);
  });
});

describe('3 · optional and peer dependencies are installed in production', () => {
  it('parse-server uuid@9.0.1 (CVSS 7.5) under firebase-admin, an optional dependency: production, ranked with runtime findings', () => {
    const r = runs['parse-server']!;
    const purl = npmPurl('uuid', '9.0.1');
    const f = finding(r, purl)!;
    expect(f.scope).toBe('optional');
    expect(isProductionScope(f.scope)).toBe(true);
    expect(productionSet(r.inventory).has(purl)).toBe(true);
    expect(f.gate?.rule).toBe('runtime');
    expect(f.gate?.detail).toMatch(/^Optional dependency \(platform-dependent; npm installs optional dependencies by default\) \(brought in by @parse\/push-adapter\): ranked with production findings/);
    const idx = r.result.findings.indexOf(f);
    const firstDev = r.result.findings.findIndex((x) => x.scope === 'dev');
    expect(idx).toBeLessThan(firstDev);
    expect(idx).toBe(1); // after proxy-addr (critical), before every other runtime finding of a lower score
    expect(formatSummary(r.result, { top: 3 })).toMatch(/uuid@9\.0\.1 {2}\[optional \(platform-dependent\)\]/);
    const sarif = toSarif(r.result, { assets: r.inventory.assets }) as { runs: { results: { properties: { purl: string; production?: boolean } }[] }[] };
    expect(sarif.runs[0]!.results.find((x) => x.properties.purl === purl)!.properties.production).toBe(true);
  });

  it('dev and CI stay out: no dev-scope component is production', () => {
    for (const r of Object.values(runs)) {
      const scopes = componentScopes(r.inventory);
      const prod = productionSet(r.inventory);
      for (const [purl, s] of scopes) if (s === 'dev' || s === 'ci') expect(prod.has(purl), purl).toBe(false);
    }
  });
});

describe('4 · HTML: families are one decision row in the Stability section', () => {
  const st = JSON.parse(gunzipSync(readFileSync(path.join(FIX05, 'parse-server-stability.json.gz'))).toString('utf8')) as { target: string; stability: StabilityReport };
  it('the 9 ldapjs packages of the real parse-server scan are one "ldapjs" row', () => {
    expect(st.stability.packages).toHaveLength(9);
    const html = renderHtml({ schemaVersion: '1', target: st.target, generatedAt: TIER05_NOW.toISOString(), inventory: { assets: 1, components: 9, edges: 0 } as never, findings: [], stability: st.stability } as ScanResult);
    const section = html.slice(html.indexOf('<h2 id="stability">'));
    expect(section).toMatch(/Decisions in production \(1 row covering 9 Fragile or moved packages\)/);
    expect(section.match(/<tr><td><code>/g)).toHaveLength(1);
    expect(section).toContain('<code>ldapjs</code>');
    expect(section).toContain('9 packages: ldapjs@');
    expect(section).toContain('Replace or upgrade ldapjs (direct dependency)');
    expect(section).not.toContain('<code>@ldapjs/asn1</code>');
  });
});

describe('5 · serve --dev seeds no demo project; --dev-seed badges it "demo" and leaves it out of totals', () => {
  it('--dev: users only, no payments-platform project and no scan', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'br-dev-'));
    const logs: string[] = [];
    const s = await serve({ devMode: true, port: 0, dbPath: path.join(dir, 'db.sqlite'), webDir: null, localRoots: [], log: (m) => logs.push(m), alerts: { packPath: undefined, webhookUrl: undefined } });
    try {
      const { openStore } = await import('../../src/server/store/index.js');
      const store = openStore({ path: path.join(dir, 'db.sqlite') });
      const admin = (store.db.prepare("SELECT id FROM app_user WHERE email = 'admin@local'").get() as { id: string }).id;
      expect(listProjects(store, listOrgsForUser(store, admin)[0]!.id)).toEqual([]);
      store.db.close();
      expect(logs.join('\n')).not.toMatch(/fixture scan|payments-platform/);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--dev-seed: the demo project is badged and not counted once a real project exists', async () => {
    const srv = createServer({ devMode: true, localRoots: [], offline: true, webDir: null, scanOptions: { cacheDir: false }, alerts: { packPath: undefined, webhookUrl: undefined }, log: () => {} });
    const seed = await seedDevData(srv.deps);
    await srv.jobs.waitFor(seed.scanId!);
    await srv.deps.accounts.idle();
    const login = await srv.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'blastradius' }, body: JSON.stringify({ email: 'admin@local', password: 'blastradius-dev' }) });
    const cookie = `br_session=${/br_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]}`;
    const get = async <T>(u: string) => (await (await srv.app.request(u, { headers: { Cookie: cookie } })).json()) as T;
    const alone = await get<OrgHomeResponse>('/api/home');
    expect(alone.projects.find((p) => p.name === DEV_PROJECT_NAME)!.demo).toBe(true);
    expect(alone.totals.projects).toBe(0);
    expect(alone.totals.demoProjects).toBe(1);
    expect((await get<OverviewResponse>('/api/overview')).demo).toEqual({ projects: 1, excluded: false });
    // A real project (the recorded parse-server replay) next to it: the overview counts only that one.
    const r = runs['parse-server']!;
    const store = srv.deps.store;
    const orgId = alone.projects[0]!.orgId;
    const p = createProject(store, orgId, { name: 'parse-server', tier: 'Standard', target: 'https://github.com/parse-community/parse-server' }, seed.users.length ? (store.db.prepare("SELECT id FROM app_user WHERE email = 'admin@local'").get() as { id: string }).id : '');
    const sc = enqueueScan(store, orgId, p.id, { requestedBy: (store.db.prepare("SELECT id FROM app_user WHERE email = 'admin@local'").get() as { id: string }).id });
    markScanRunning(store, sc.id);
    completeScan(store, sc.id, { result: r.result, inventory: r.inventory, commit: r.fx.commit });
    const home = await get<OrgHomeResponse>('/api/home');
    expect(home.totals.projects).toBe(1);
    expect(home.totals.counts).toEqual(home.projects.find((x) => x.name === 'parse-server')!.counts);
    const ov = await get<OverviewResponse>('/api/overview');
    expect(ov.demo).toEqual({ projects: 1, excluded: true });
    expect(ov.projects).toBe(1);
    srv.jobs.stop();
  }, 60_000);
});

describe('6 · GET /api/packages/behind says pending while the account index runs', () => {
  it('pending: true (not a bare null) until the recorded agent-base packument is indexed', async () => {
    const r = runs['parse-server']!;
    const doc = packument(r.fx, 'agent-base');
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const http = new HttpClient({
      offline: false,
      cacheDir: false,
      minIntervalMs: 0,
      maxRetries: 0,
      transport: async (req) => {
        await gate;
        if (req.url === 'https://registry.npmjs.org/agent-base') return { status: 200, body: JSON.stringify(doc) };
        return { status: 404, body: "{}" };
      },
    });
    const srv = createServer({ devMode: true, localRoots: [], offline: false, webDir: null, scanOptions: { cacheDir: false }, accounts: { http }, alerts: { packPath: undefined, webhookUrl: undefined }, log: () => {} });
    const seedOut = await (await import('../../src/server/serve.js')).seedDevUsers(srv.deps);
    const store = srv.deps.store;
    const admin = (store.db.prepare("SELECT id FROM app_user WHERE email = 'admin@local'").get() as { id: string }).id;
    const p = createProject(store, seedOut.orgId, { name: 'parse-server', tier: 'Standard', target: 'https://github.com/parse-community/parse-server' }, admin);
    const sc = enqueueScan(store, seedOut.orgId, p.id, { requestedBy: admin });
    markScanRunning(store, sc.id);
    completeScan(store, sc.id, { result: r.result, inventory: r.inventory, commit: r.fx.commit });
    const login = await srv.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'blastradius' }, body: JSON.stringify({ email: 'auditor@local', password: 'blastradius-dev' }) });
    const cookie = `br_session=${/br_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]}`;
    const behind = async () => (await (await srv.app.request('/api/packages/behind?name=agent-base', { headers: { Cookie: cookie } })).json()) as PackageBehindResponse;

    expect((await behind()).pending).toBeUndefined(); // index idle, nothing queued: not pending
    srv.deps.accounts.afterScan(p.id);
    expect(srv.deps.accounts.busy).toBe(true);
    const during = await behind();
    expect(during.pending).toBe(true);
    expect(during.publishRights).toBeNull();
    release();
    await srv.deps.accounts.idle();
    expect(srv.deps.accounts.busy).toBe(false);
    const after = await behind();
    expect(after.pending).toBeUndefined();
    expect(after.publishRights!.map((x) => x.account)).toEqual((doc.maintainers as { name: string }[]).map((m) => m.name).sort());
    srv.jobs.stop();
  }, 60_000);
});

describe('7 · owner evidence points to the current repository (the latest release\'s repository.url)', () => {
  it('agent-base: TooTallNate/proxy-agents, not the archived node-agent-base', () => {
    for (const id of ['parse-server', 'jitsi-meet']) {
      const owns = runs[id]!.entities.links.filter((l) => l.relation === 'owns' && l.to === 'pkg:npm/agent-base');
      expect(owns, id).toHaveLength(1);
      expect(owns[0]!.from).toBe('owner:github/tootallnate');
      expect(owns[0]!.evidence[0]!.toLowerCase()).toBe('https://github.com/tootallnate/proxy-agents');
      expect(owns[0]!.evidence.join(' ')).not.toMatch(/node-agent-base/i);
    }
  });
});

describe('7b · a current repository without an owner (not on GitHub) does not break owner resolution', () => {
  it('jitsi re-scan regression: a gitlab / self-hosted repository declared by the latest release', () => {
    const meta = { source: 'npm', fetchedAt: TIER05_NOW, evidence: ['https://www.npmjs.com/package/x'] };
    const facts: Fact[] = [
      makeFact('repo', 'pkg:npm/x', { url: 'https://git.example.org/x', host: 'other', via: 'npm.repository' }, meta),
      makeFact('release_age', 'pkg:npm/x@1.0.0', { version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z', ageDays: 284, latestRepository: { url: 'https://git.example.org/x' } }, meta),
    ];
    expect(resolveEntities(facts).links.filter((l) => l.relation === 'owns')).toEqual([]);
  });
});

describe('8 · a funding URL is never a source repository', () => {
  it('uvicorn 0.52.0: deps.dev lists github.com/sponsors/encode as SOURCE_REPO; the repository is kludex/uvicorn', () => {
    const fx = loadFixture('superset');
    const e = fx.http.find((x) => x.request.url === 'https://api.deps.dev/v3/systems/pypi/packages/uvicorn/versions/0.52.0')!;
    const raw = JSON.stringify(e.response);
    expect(raw).toContain('github.com/sponsors/encode');
    expect(repoOf(e.response as never)?.url).toBe('https://github.com/kludex/uvicorn');
    for (const u of ['https://github.com/sponsors/encode', 'github.com/sponsors/encode', 'https://opencollective.com/express', 'git+https://github.com/sponsors/x.git']) {
      expect(isNonRepositoryUrl(u), u).toBe(true);
      expect(normalizeRepoUrl(u), u).toBeUndefined();
      expect(parseRepoUrl(u), u).toBeUndefined();
    }
    expect(isNonRepositoryUrl('https://github.com/encode/httpx')).toBe(false);
    for (const r of Object.values(runs)) for (const f of r.facts.filter(isFactOf('repo'))) expect(isNonRepositoryUrl(f.value.url), f.value.url).toBe(false);
  });
});

describe('9 · a version installed from outside the npm registry says so', () => {
  it('xlsx 0.20.3 from cdn.sheetjs.com: kept, and marked "advisory ranges may not apply"', () => {
    const r = runs['superset']!;
    const f = finding(r, npmPurl('xlsx', '0.20.3'))!;
    expect(f).toBeDefined();
    expect(f.installedFrom).toEqual({ host: 'cdn.sheetjs.com', url: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz', note: 'installed from cdn.sheetjs.com, not the npm registry: advisory ranges may not apply' });
    expect(f.reasons.find((x) => x.factor === 'vuln')!.detail).toMatch(/\(installed from cdn\.sheetjs\.com, not the npm registry: advisory ranges may not apply\)$/);
    expect(formatSummary(r.result, { top: 3 })).toContain('installed from cdn.sheetjs.com, not the npm registry: advisory ranges may not apply');
    // Registry tarballs (any registry layout) are not marked.
    for (const c of r.inventory.components) if (c.name !== 'xlsx' && c.ecosystem === 'npm') expect(nonRegistryTarball(c.name, c.resolved), c.purl).toBeUndefined();
  });
});

describe('10 · SBOM product name: never an absolute path', () => {
  it('CycloneDX metadata.component and the SPDX root name the repository, or --product-name / --product-version', async () => {
    const r = runs['jitsi-meet']!;
    expect(path.isAbsolute(r.result.target)).toBe(true);
    const cdx = JSON.parse(renderCycloneDx(r.result, r.inventory)) as { metadata: { component: { name: string; version?: string } } };
    expect(cdx.metadata.component.name).toBe('jitsi-meet');
    const spdx = JSON.parse(renderSpdx(r.result, r.inventory)) as { name: string; packages: { SPDXID: string; name: string }[] };
    expect(spdx.packages.find((p) => p.SPDXID === 'SPDXRef-Root')!.name).toBe('jitsi-meet');
    expect(spdx.name).toBe('blastradius jitsi-meet');
    expect(JSON.stringify(cdx.metadata)).not.toContain(r.dir);
    const named = await replay('superset', { product: { name: 'superset-frontend', version: '6.1.0' } });
    dirs.push(path.dirname(named.dir));
    const cdx2 = JSON.parse(renderCycloneDx(named.result, named.inventory)) as { metadata: { component: { name: string; version?: string } } };
    expect(cdx2.metadata.component).toMatchObject({ name: 'superset-frontend', version: '6.1.0' });
    expect(productNameOf('https://github.com/parse-community/parse-server.git')).toBe('parse-server');
  }, 120_000);
});
