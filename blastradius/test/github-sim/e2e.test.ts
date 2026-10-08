/**
 * docs/CONNECTORS.md §4, end to end against the GitHub simulator (no internet): the real
 * Blastradius server, over HTTP, configured with the simulator's App credentials and URLs, its
 * scans enriched from the replay server (recorded npm and OSV data, as of 2021-10-23).
 *
 *   connect through the install page → repos and lockfiles listed → watch → first scans equal the
 *   recorded clone scans → a lockfile push re-scans, a README push does not → a push pinning
 *   ua-parser-js@0.7.29 raises an alert from the knowledge pack → a repo added to the install
 *   is scanned → revoking marks access lost, nothing deleted → forged and replayed webhooks are
 *   rejected → an installation id swapped into the callback without a matching code connects nothing.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { serve as nodeServe } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import { createNpmEnricher } from '../../src/enrich/npm/index.js';
import { createOsvEnricher } from '../../src/enrich/osv/index.js';
import { addOsvRecord, emptyPack, finishPack } from '../../src/pack/build.js';
import type { ListAlertsResponse, ListSourceReposResponse, Scan, SourceRepo, StartSourceInstallResponse } from '../../src/server/api-types.js';
import { createServer } from '../../src/server/serve.js';
import { githubConfigFromEnv } from '../../src/server/sources/github.js';
import { latestInventories, listScans, seedDev } from '../../src/server/store/index.js';
import { inventoryHash } from '../sources/equivalence.js';
import { advisory } from '../replay/org.js';
import { DATA_DIR, startReplayServer, type ReplayServer } from '../replay/server.js';
import { recordedRepo } from './repos.js';
import { FORKS, OTHER_ADMIN, OTHER_ORG, SIM_ORG, seedScenario } from './scenario.js';
import { GitHubSim } from './sim.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const AS_OF = new Date('2021-10-23T00:00:00Z');
const UA_ADVISORY = 'GHSA-pjwm-rvh2-c87w';
const WATCHED = ['a11y-map', 'registry-static', 'Pentominos2', 'project-qwerty', 'vs-code-obsidian', 'mocha'];

const sim = new GitHubSim();
let replay: ReplayServer;
let srv: ReturnType<typeof createServer>;
let http: { close: () => void } | null = null;
let base = '';
let cookie = '';
let orgId = '';
let sourceId = '';
let installationId = 0;
const tmp = mkdtempSync(join(tmpdir(), 'br-sim-e2e-'));
const logs: string[] = [];

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { Cookie: `br_session=${cookie}`, ...(method !== 'GET' ? { 'X-Requested-With': 'blastradius' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await srv.deps.sources.idle();
    await srv.jobs.idle();
  }
}

async function repos(): Promise<SourceRepo[]> {
  const res = await call('GET', `/api/sources/${sourceId}/repos`);
  expect(res.status).toBe(200);
  return ((await res.json()) as ListSourceReposResponse).items;
}

const byName = (list: SourceRepo[], name: string) => list.find((r) => r.fullName === `${SIM_ORG}/${name}`)!;

/** What a browser does with the simulator's install page: pick the account, the repos, submit. */
async function installThroughPage(installUrl: string, account: string, repoNames: string[] | 'all'): Promise<URL> {
  const pick = await (await fetch(installUrl)).text();
  const href = new RegExp(`data-account="${account}" href="([^"]+)"`).exec(pick)![1]!.replace(/&amp;/g, '&');
  const page = await (await fetch(new URL(href, sim.urls.web))).text();
  expect(page).toContain(`Install ${sim.appMeta.name} on ${account}: all repos / selected`);
  const form = new URLSearchParams();
  const state = /name="state" value="([^"]+)"/.exec(page)?.[1];
  if (state) form.set('state', state);
  form.set('target_id', /name="target_id" value="(\d+)"/.exec(page)![1]!);
  form.set('repository_selection', repoNames === 'all' ? 'all' : 'selected');
  if (repoNames !== 'all') {
    for (const n of repoNames) form.append('repository_ids', new RegExp(`value="(\\d+)"[^>]*> ${account}/${n}<`).exec(page)![1]!);
  }
  const res = await fetch(`${sim.urls.web}/apps/${sim.appMeta.slug}/installations`, { method: 'POST', body: form, redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

/** Follow GitHub's redirect into Blastradius' callback; returns where Blastradius sends the browser. */
async function callback(url: URL): Promise<URLSearchParams> {
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const loc = res.headers.get('location')!;
  expect(loc.startsWith('/sources?')).toBe(true);
  return new URLSearchParams(loc.split('?')[1]);
}

beforeAll(async () => {
  replay = await startReplayServer({ clock: AS_OF });
  // A knowledge pack holding the recorded ua-parser-js advisory (CWE-506, embedded malware).
  const pack = emptyPack('2021-10-23T00:00:00.000Z');
  addOsvRecord(pack.malware, advisory(UA_ADVISORY) as never);
  const packPath = join(tmp, 'pack.json.gz');
  writeFileSync(packPath, gzipSync(Buffer.from(JSON.stringify(finishPack(pack, [])))));

  await sim.start();
  await seedScenario(sim);
  const github = githubConfigFromEnv({ ...sim.env() });
  expect(github).toMatchObject({ apiUrl: sim.urls.api, webUrl: sim.urls.web });
  srv = createServer({
    devMode: true,
    webDir: null,
    github,
    asOf: AS_OF,
    alerts: { packPath, log: (m) => logs.push(m) },
    scanOptions: {
      cacheDir: false,
      http: new HttpClient({ offline: false, cacheDir: false, minIntervalMs: 0, hostIntervals: {}, maxRetries: 0 }),
      enrichers: () => [createOsvEnricher({ baseUrl: replay.osvUrl }), createNpmEnricher({ registry: replay.registryUrl })],
    },
    log: (m) => logs.push(m),
  });
  await seedDev(srv.store, { devMode: true });
  const server = await new Promise<ReturnType<typeof nodeServe>>((resolve) => {
    const s = nodeServe({ fetch: srv.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  http = server;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The App's settings on "GitHub": webhook and callback URLs point at this Blastradius.
  sim.hookUrl = `${base}/api/hooks/github`;
  sim.callbackUrl = `${base}/api/sources/github/callback`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'blastradius' }, body: JSON.stringify({ email: 'admin@local', password: 'blastradius-dev' }) });
  expect(login.status).toBe(200);
  cookie = /br_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1]!;
  orgId = ((await (await call('GET', '/api/me')).json()) as { org: { id: string } }).org.id;
});

afterAll(async () => {
  srv?.jobs.stop();
  await srv?.deps.sources.idle();
  http?.close();
  await sim.close();
  await replay?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('§4 proof points against the GitHub simulator', () => {
  it('connects through the install page; repos and their lockfiles are listed before any scan', async () => {
    const start = await call('POST', '/api/sources', { host: 'github', autoWatch: false });
    expect(start.status).toBe(201);
    const { installUrl, source } = (await start.json()) as StartSourceInstallResponse;
    expect(installUrl.startsWith(`${sim.urls.web}/apps/${sim.appMeta.slug}/installations/new?state=`)).toBe(true);
    sourceId = source.id;
    const back = await installThroughPage(installUrl, SIM_ORG, WATCHED);
    expect(`${back.origin}${back.pathname}`).toBe(`${base}/api/sources/github/callback`);
    installationId = Number(back.searchParams.get('installation_id'));
    const outcome = await callback(back);
    expect(Object.fromEntries(outcome)).toEqual({ install: 'connected', source: sourceId });
    await settle();
    const src = await (await call('GET', `/api/sources/${sourceId}`)).json();
    expect(src).toMatchObject({ status: 'connected', account: SIM_ORG, installationId: String(installationId), repositorySelection: 'selected' });
    const rs = await repos();
    expect(rs.map((r) => r.fullName).sort()).toEqual(WATCHED.map((n) => `${SIM_ORG}/${n}`).sort());
    for (const r of rs) {
      expect(r).toMatchObject({ status: 'not_watched', watching: false, projectId: null, lastScanId: null });
      expect(r.lockfiles).toContain('package-lock.json');
    }
    // mocha's workspace lockfiles and workflows are listed too: 29 inventory files of its real tree.
    expect(byName(rs, 'mocha').filesRead.length).toBe(Object.keys(recordedRepo('mochajs/mocha').files).length);
    expect(sim.state().tokens).toMatchObject({ live: 0 });
    expect(sim.tokensRevoked).toBe(sim.tokensMinted);
    expect(sim.userTokensRevoked).toBe(1);
  });

  it('install-ID tampering: a callback whose installation id the OAuth code does not cover connects nothing', async () => {
    const other = await sim.install(OTHER_ORG, 'all', [], OTHER_ADMIN);
    const start = (await (await call('POST', '/api/sources', { host: 'github' })).json()) as StartSourceInstallResponse;
    // A real trip through the install page (acme-sim, already installed: setup_action=update) ...
    const back = await installThroughPage(start.installUrl, SIM_ORG, WATCHED);
    expect(back.searchParams.get('setup_action')).toBe('update');
    // ... with other-org's installation id swapped in: the code is sim-admin's, who cannot see it.
    back.searchParams.set('installation_id', String(other.installation.id));
    const tampered = await callback(back);
    expect(tampered.get('install')).toBe('failed');
    expect(tampered.get('reason')).toMatch(/did not confirm/);
    // Without any code, and with a code already spent, nothing connects either.
    const start2 = (await (await call('POST', '/api/sources', { host: 'github' })).json()) as StartSourceInstallResponse;
    const state = new URL(start2.installUrl).searchParams.get('state')!;
    const noCode = await callback(new URL(`${base}/api/sources/github/callback?installation_id=${other.installation.id}&setup_action=install&state=${encodeURIComponent(state)}`));
    expect(noCode.get('install')).toBe('failed');
    const list = (await (await call('GET', '/api/sources')).json()) as { items: { status: string; installationId: string | null }[] };
    expect(list.items.filter((s) => s.status === 'connected').map((s) => s.installationId)).toEqual([String(installationId)]);
  });

  it('watching scans each repo, fetch-only, and the inventory equals the recorded clone scan', async () => {
    for (const r of await repos()) expect((await call('PATCH', `/api/sources/${sourceId}/repos/${r.id}`, { watching: true })).status).toBe(200);
    await settle();
    const rs = await repos();
    for (const name of WATCHED) {
      const r = byName(rs, name);
      const rec = recordedRepo(FORKS[name]!);
      expect(r, name).toMatchObject({ watching: true, status: 'watching', lastCommit: rec.commit });
      const scan = (await (await call('GET', `/api/scans/${r.lastScanId}`)).json()) as Scan;
      expect(scan, name).toMatchObject({ status: 'succeeded', commit: rec.commit, target: `${sim.urls.web}/${SIM_ORG}/${name}` });
      const [inv] = latestInventories(srv.store, orgId, [r.projectId!]);
      expect({ assets: inv!.inventory.assets.length, components: inv!.inventory.components.length, edges: inv!.inventory.edges.length }, name).toEqual({
        assets: rec.cloneScan.assets,
        components: rec.cloneScan.components,
        edges: rec.cloneScan.edges,
      });
      expect(inventoryHash(inv!.inventory), name).toBe(rec.cloneScan.sha256);
      // Only the inventory files were read, and they are the replay org's recorded files.
      expect(r.filesRead).toEqual(Object.keys(rec.files).sort());
      if (name !== 'mocha') {
        for (const f of ['package.json', 'package-lock.json']) expect(rec.files[f], `${name}/${f}`).toBe(readFileSync(join(DATA_DIR, 'org', FORKS[name]!.replace('/', '__'), f), 'utf8'));
      }
    }
  });

  it('first scans raise the knowledge-pack alert for the repo that already pins ua-parser-js@0.7.29', async () => {
    const alerts = ((await (await call('GET', '/api/alerts')).json()) as ListAlertsResponse).items;
    expect(alerts.map((a) => `${a.projectName} ${a.purl} ${a.advisoryId}`)).toEqual([`${SIM_ORG}/Pentominos2 pkg:npm/ua-parser-js@0.7.29 ${UA_ADVISORY}`]);
  });

  it('a push that only touches README.md is skipped; a lockfile push re-scans and raises an alert', async () => {
    const r = byName(await repos(), 'a11y-map');
    const scansBefore = listScans(srv.store, orgId, r.projectId!).total;
    const readme = await sim.push(`${SIM_ORG}/a11y-map`, { files: { 'README.md': '# a11y-map (fork)\n' } });
    expect(readme.deliveries.map((d) => [d.status, JSON.parse(d.response).outcome])).toEqual([[202, 'skipped_no_inventory_change']]);
    await settle();
    expect(listScans(srv.store, orgId, r.projectId!).total).toBe(scansBefore);

    const t0 = performance.now();
    const bump = await sim.push(`${SIM_ORG}/a11y-map`, { bump: 'ua-parser-js@0.7.29' });
    expect(bump.modified.sort()).toEqual(['package-lock.json', 'package.json']);
    expect(bump.deliveries.map((d) => [d.status, JSON.parse(d.response).outcome])).toEqual([[202, 'queued']]);
    await settle();
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(120_000);
    const scans = listScans(srv.store, orgId, r.projectId!);
    expect(scans.total).toBe(scansBefore + 1);
    expect(scans.items[0]).toMatchObject({ status: 'succeeded', commit: bump.commit });
    expect(byName(await repos(), 'a11y-map')).toMatchObject({ lastCommit: bump.commit, lastDeliveryOutcome: 'queued', status: 'watching' });
    const [inv] = latestInventories(srv.store, orgId, [r.projectId!]);
    expect(inv!.inventory.components.some((c) => c.purl === 'pkg:npm/ua-parser-js@0.7.29')).toBe(true);
    const alerts = ((await (await call('GET', '/api/alerts')).json()) as ListAlertsResponse).items;
    expect(alerts.find((a) => a.projectName === `${SIM_ORG}/a11y-map`)).toMatchObject({ purl: 'pkg:npm/ua-parser-js@0.7.29', advisoryId: UA_ADVISORY, production: true });
    // The scan's findings flag it too (recorded advisory, as of the replay clock).
    const findings = (await (await call('GET', `/api/findings?project=${r.projectId}`)).json()) as { items: { purl: string; level: string }[] };
    expect(findings.items.find((f) => f.purl === 'pkg:npm/ua-parser-js@0.7.29')?.level).toBe('critical');
  });

  it('a repo added to the installation appears and, with auto-watch on, is scanned', async () => {
    expect((await call('PATCH', `/api/sources/${sourceId}`, { autoWatch: true })).status).toBe(200);
    const d = await sim.addRepoToInstallation(installationId, `${SIM_ORG}/logops`);
    expect(d && [d.status, JSON.parse(d.response).outcome]).toEqual([202, 'repos_added:1,removed:0']);
    await settle();
    const r = byName(await repos(), 'logops');
    expect(r).toMatchObject({ watching: true, status: 'watching', lastCommit: recordedRepo('telefonicaid/logops').commit });
    const [inv] = latestInventories(srv.store, orgId, [r.projectId!]);
    expect(inventoryHash(inv!.inventory)).toBe(recordedRepo('telefonicaid/logops').cloneScan.sha256);
  });

  it('forged, unsigned and replayed webhooks are rejected', async () => {
    const before = srv.deps.sources.rejectedDeliveries;
    const forged = await sim.forge({ repo: `${SIM_ORG}/a11y-map` });
    expect(forged.status).toBe(401);
    const unsigned = await sim.forge({ repo: `${SIM_ORG}/a11y-map`, unsigned: true });
    expect(unsigned.status).toBe(401);
    expect(srv.deps.sources.rejectedDeliveries).toBe(before + 2);
    // GitHub's own delivery, sent again byte for byte: deduplicated by its delivery id.
    const last = sim.deliveries.filter((x) => x.signed === 'valid' && x.event === 'push').pop()!;
    const again = await sim.replay(last.id);
    expect(again.status).toBe(200);
    expect(JSON.parse(again.response)).toMatchObject({ duplicate: true });
  });

  it('revoking the installation marks the source and repos access lost; nothing is deleted', async () => {
    const before = await repos();
    const projects = before.map((r) => r.projectId).filter(Boolean);
    const d = await sim.revoke(installationId);
    expect([d.status, JSON.parse(d.response).outcome]).toEqual([202, 'access_lost']);
    const src = (await (await call('GET', `/api/sources/${sourceId}`)).json()) as { status: string; health: string };
    expect(src).toMatchObject({ status: 'access_lost' });
    // Asking GitHub again confirms it (the installation is gone: 404).
    const check = (await (await call('POST', `/api/sources/${sourceId}/check`)).json()) as { status: string; health: string };
    expect(check.status).toBe('access_lost');
    expect(check.health).toMatch(/removed or cannot be found/);
    const after = await repos();
    expect(after.length).toBe(before.length);
    for (const r of after) expect(r.status).toBe('access_lost');
    for (const p of projects) {
      expect((await call('GET', `/api/projects/${p}`)).status).toBe(200);
      expect(listScans(srv.store, orgId, p!).items.some((s) => s.status === 'succeeded')).toBe(true);
    }
    expect(((await (await call('GET', '/api/alerts')).json()) as ListAlertsResponse).items.length).toBe(2);
    // A push after the uninstall is not even delivered: GitHub only sends events to installed Apps.
    const late = await sim.push(`${SIM_ORG}/a11y-map`, { files: { 'package.json': '{}\n' } });
    expect(late.deliveries).toEqual([]);
  });
});
