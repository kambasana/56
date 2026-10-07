/**
 * Blastradius hammer test: real repositories at pinned commits, real registries and advisories,
 * the real CLI and the real web API. No mocks, no fixtures, no --offline.
 *
 *   npm run hammer                       # everything (scale scenarios included)
 *   npm run hammer -- --only colors-1.4.2-2022,control-mocha
 *   npm run hammer -- --skip-scale --cli-jobs 3
 *
 * Options:
 *   --only <ids>              comma-separated scenario ids
 *   --skip-scale              skip scale-* and hostile-* scenarios
 *   --skip-probes             skip the robustness/target probes
 *   --cli-jobs <n>            CLI scans run at once (default 2)
 *   --server-concurrency <n>  scans per server at once (1-4, default 2)
 *   --reuse-cache             reuse the engine HTTP cache from earlier runs (default: fresh per run)
 *   --strict                  exit 3 when any assertion is blocked by a missing data source
 *   --keep-servers            leave the API servers running after the run (Ctrl-C to stop)
 *
 * Environment: BLASTRADIUS_HAMMER_DIR (clones, DBs, caches; default ~/.cache/blastradius-hammer).
 * A GitHub token is read from ../secrets/github-token.txt into process.env only; never printed.
 * Writes test/hammer/out/results.json and results.md. Exit 1 on any failed assertion.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ADMIN_EMAIL, ApiClient, createDb, newCreds, Server, waitForScan, type AdminCreds, type ScanRow } from './lib/api.js';
import {
  checkAbsent,
  checkExpectation,
  countsOf,
  diffResults,
  validateHtml,
  validateJson,
  validateSarif,
  warningsBySource,
  differingFactors,
  failureSource,
  type Expectation,
  type JResult,
} from './lib/checks.js';
import { cloneAt, type CloneResult } from './lib/clone.js';
import { CLI, git, GITHUB_RATE, HAMMER_ROOT, hammerDir, Ledger, loadGithubToken, PKG_ROOT, preflight, runProc, scrub, type Preflight, type ProcResult } from './lib/util.js';

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

interface Scenario {
  id: string;
  repo: string;
  commit: string;
  lockfile?: string;
  subdir?: string;
  asOf?: string;
  why: string;
  sources: string[];
  expect: Expectation[];
  expectAbsent?: string[];
  verified?: string;
}

const scenarios = (JSON.parse(readFileSync(path.join(HAMMER_ROOT, 'scenarios.json'), 'utf8')) as { scenarios: Scenario[] }).scenarios;

/** Floors from the manual lockfile sweeps recorded in scenarios.json "verified". */
const MIN_INVENTORY: Record<string, { components?: number; assets?: number }> = {
  'event-stream-runtime-2018': { components: 300 },
  'control-typescript': { components: 200, assets: 13 },
  'control-mocha': { components: 742, assets: 15 },
  'scale-superset-frontend': { components: 2793 },
  'scale-vscode-multi-lockfile': { components: 3048, assets: 61 },
  'hostile-npm-cli-fixtures': { components: 1000 },
  'tj-actions-changed-files-sha-2025': { assets: 11 },
};

/** Warnings that must appear (real malformed / unsupported inputs). */
const MUST_WARN: Record<string, { re: RegExp; what: string }[]> = {
  'hostile-npm-cli-fixtures': [
    { re: /conflict-package-lock\/package-lock\.json: could not parse lockfile/, what: 'merge-conflict lockfile reported as unparseable' },
    // workspace3/packages/a/package-lock.json is also invalid JSON, but npm-shrinkwrap.json in the same
    // directory takes precedence (npm semantics, ingest/index.ts), so only the shrinkwrap is reported.
    { re: /workspace3\/packages\/a\/npm-shrinkwrap\.json: could not parse lockfile/, what: 'workspace3 shrinkwrap reported as unparseable' },
  ],
  'yarn-unsupported-ua-parser-js': [{ re: /yarn\.lock is not supported/, what: "coverage warning 'yarn.lock is not supported'" }],
};

const isScale = (s: Scenario) => s.id.startsWith('scale-') || s.id.startsWith('hostile-');
const budgetSec = (s: Scenario) => (isScale(s) ? 1800 : 600);
const timeoutMs = (s: Scenario) => budgetSec(s) * 2 * 1000;
const RSS_BUDGET_MB = 2048;
/** Scoring factors fed by the GitHub enricher (repo owner/transfer/archived, entity links). */
const GITHUB_FACTORS = new Set(['repo_transfer', 'abandoned', 'entity_incident']);

/** Engine enricher prefix in warnings → host it talks to. */
const ENRICHER_HOST: Record<string, string> = {
  osv: 'api.osv.dev',
  depsdev: 'api.deps.dev',
  github: 'api.github.com',
  npm: 'registry.npmjs.org',
};

// ---------------------------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = opt('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const cliJobs = Math.max(1, Math.min(8, Number(opt('--cli-jobs') ?? 2) || 2));
const serverConcurrency = Math.max(1, Math.min(4, Number(opt('--server-concurrency') ?? 2) || 2));
const skipScale = flag('--skip-scale');
const skipProbes = flag('--skip-probes');
const strict = flag('--strict');
const keepServers = flag('--keep-servers');
const reuseCache = flag('--reuse-cache');

if (only) {
  const unknown = only.filter((id) => !scenarios.some((s) => s.id === id));
  if (unknown.length) {
    process.stderr.write(`unknown scenario id(s): ${unknown.join(', ')}\n`);
    process.exit(2);
  }
}
const selected = scenarios.filter((s) => (only ? only.includes(s.id) : true) && !(skipScale && isScale(s)));

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

const H = hammerDir();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const REPOS = path.join(H, 'repos');
const RUN_DIR = path.join(H, 'runs', runId);
const DB_DIR = path.join(H, 'db');
const CACHE_CLI = reuseCache ? path.join(H, 'http', 'shared-cli') : path.join(RUN_DIR, 'http-cli');
const CACHE_API = reuseCache ? path.join(H, 'http', 'shared-api') : path.join(RUN_DIR, 'http-api');
const OUT = path.join(HAMMER_ROOT, 'out');
for (const d of [REPOS, RUN_DIR, DB_DIR, CACHE_CLI, CACHE_API, OUT]) mkdirSync(d, { recursive: true });

const log = (s: string) => process.stdout.write(`${s}\n`);
const ms = (n: number) => (n >= 60_000 ? `${(n / 60_000).toFixed(1)}m` : `${(n / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------------------------
// Per-scenario state
// ---------------------------------------------------------------------------------------------

interface ApiRun {
  server: string;
  projectId?: string;
  scanId?: string;
  scan?: ScanRow | null;
  ms?: number;
  error?: string;
  result?: JResult;
}

interface ScenarioRun {
  s: Scenario;
  clone?: CloneResult;
  scanDir?: string;
  cli?: { proc: ProcResult; outDir: string; result?: JResult; sarif?: unknown; html?: string; error?: string };
  api?: ApiRun;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it);
    }),
  );
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const startedAt = new Date();
  log(`blastradius hammer — run ${runId}`);
  log(`  hammer dir: ${H}`);
  log(`  scenarios: ${selected.map((s) => s.id).join(', ')}`);
  if (!existsSync(CLI)) {
    log(`dist/cli.js missing: run npm run build first`);
    return 1;
  }

  // 1. Preflight -------------------------------------------------------------------------------
  const tokenSource = loadGithubToken();
  const pre: Preflight = await preflight(tokenSource);
  log('\nSource matrix');
  for (const p of pre.sources) log(`  ${p.state.padEnd(8)} ${p.host.padEnd(28)} ${p.detail.slice(0, 110)} (${p.ms}ms)`);
  log(
    `  token    ${pre.token.source === 'none' ? 'none' : `${pre.token.source} (value withheld)`}; api.github.com core limit ${pre.token.coreLimit ?? '?'} remaining ${pre.token.coreRemaining ?? '?'}${pre.token.authenticated === false ? ' (UNAUTHENTICATED)' : ''}`,
  );
  const blocked = new Set(pre.sources.filter((p) => p.state !== 'ok').map((p) => p.host));
  if (pre.token.authenticated !== true) blocked.add(GITHUB_RATE);
  blockedHosts = blocked;
  const L = new Ledger(blocked);
  L.check('preflight', 'git', 'github.com reachable over git (required for every scenario)', !blocked.has('github.com'), pre.sources[0]!.detail);
  L.check('preflight', 'npm', 'registry.npmjs.org reachable', !blocked.has('registry.npmjs.org'), pre.sources[1]!.detail);

  // Stale per-run caches from earlier runs are removed (clones and DBs are kept).
  try {
    for (const d of readdirSync(path.join(H, 'runs'))) if (d !== runId) rmSync(path.join(H, 'runs', d), { recursive: true, force: true });
  } catch {
    /* none */
  }

  // 2. Clones ----------------------------------------------------------------------------------
  log('\nCloning pinned commits (sparse, blob:none, hooks off)');
  const runs: ScenarioRun[] = selected.map((s) => ({ s }));
  for (const r of runs) {
    const c = await cloneAt(REPOS, r.s.repo, r.s.commit);
    r.clone = c;
    log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${r.s.id.padEnd(36)} ${r.s.repo}@${r.s.commit.slice(0, 10)} ${c.reused ? 'reused' : ms(c.ms)} ${c.error ?? ''}`);
    L.check(r.s.id, 'clone', `clone ${r.s.repo}@${r.s.commit.slice(0, 10)} (HEAD verified)`, c.ok, c.ok ? `${c.dir} HEAD=${c.head}` : c.error ?? 'failed', ['github.com']);
    if (!c.ok) continue;
    r.scanDir = r.s.subdir ? path.join(c.dir, r.s.subdir) : c.dir;
    if (r.s.lockfile) {
      const lf = path.join(c.dir, r.s.lockfile);
      L.check(r.s.id, 'lockfile', `pinned lockfile ${r.s.lockfile} present`, existsSync(lf), existsSync(lf) ? `${statSync(lf).size} bytes` : 'missing');
    }
  }
  const ready = runs.filter((r) => r.scanDir);

  // 3. API servers (one per reference date: the API has no per-scan --as-of) ----------------------
  const creds: AdminCreds = newCreds(path.join(H, 'admin.json'));
  const groups = new Map<string, ScenarioRun[]>();
  for (const r of ready) groups.set(r.s.asOf ?? 'now', [...(groups.get(r.s.asOf ?? 'now') ?? []), r]);
  if (!skipProbes) groups.set('now', groups.get('now') ?? []);
  const servers = new Map<string, { server: Server; api: ApiClient }>();
  log('\nStarting API servers (real admin user via the store; no --dev, no fixtures)');
  for (const key of groups.keys()) {
    const name = key === 'now' ? 'now' : key.slice(0, 10);
    const db = path.join(DB_DIR, `${name}.sqlite`);
    createDb(db, creds);
    const server = new Server(name, db, { ...(key !== 'now' ? { asOf: key } : {}), scanRoot: REPOS, cacheDir: CACHE_API, concurrency: serverConcurrency, logFile: path.join(RUN_DIR, `server-${name}.log`) });
    liveServers.push(server);
    try {
      await server.start();
    } catch (e) {
      L.check(`server:${name}`, 'start', `serve --db ${path.basename(db)}${key !== 'now' ? ` --as-of ${key}` : ''} starts`, false, (e as Error).message);
      continue;
    }
    const api = new ApiClient(server.url);
    const login = await api.login(creds);
    L.check(`server:${name}`, 'login', `server ${name} up at ${server.url}; real admin signs in`, login.status === 200, `POST /api/auth/login -> ${login.status}`);
    servers.set(key, { server, api });
    log(`  ${name.padEnd(10)} ${server.url}  db=${db}`);
  }

  // Queue every API scan up front so they run while the CLI scans run.
  for (const [key, list] of groups) {
    const srv = servers.get(key);
    for (const r of list) {
      r.api = { server: srv?.server.name ?? key };
      if (!srv) {
        r.api.error = 'server did not start';
        continue;
      }
      const t0 = Date.now();
      const pr = await srv.api.req<{ id: string }>('POST', '/api/projects', {
        name: r.s.id,
        tier: isScale(r.s) ? 'Large' : 'Standard',
        target: r.scanDir,
        owner: `hammer · ${r.s.repo}@${r.s.commit.slice(0, 7)}`,
      });
      if (pr.status !== 201) {
        r.api.error = `POST /api/projects -> ${pr.status} ${pr.text.slice(0, 300)}`;
        continue;
      }
      r.api.projectId = pr.body.id;
      const sc = await srv.api.req<ScanRow>('POST', `/api/projects/${pr.body.id}/scans`, {});
      if (sc.status !== 202) {
        r.api.error = `POST scans -> ${sc.status} ${sc.text.slice(0, 300)}`;
        continue;
      }
      r.api.scanId = sc.body.id;
      r.api.ms = -t0; // completed below
    }
  }

  // 4. CLI scans --------------------------------------------------------------------------------
  log(`\nCLI scans (${cliJobs} at a time; real network; no --offline/--fixtures)`);
  await pool(ready, cliJobs, async (r) => {
    const outDir = path.join(RUN_DIR, r.s.id, 'cli');
    mkdirSync(outDir, { recursive: true });
    const args = [CLI, 'scan', r.scanDir!, '--out', outDir, '--format', 'all', ...(r.s.asOf ? ['--as-of', r.s.asOf] : [])];
    const env: NodeJS.ProcessEnv = { ...process.env, BLASTRADIUS_CACHE_DIR: CACHE_CLI };
    delete env.BLASTRADIUS_OFFLINE;
    delete env.BLASTRADIUS_FIXTURES;
    const proc = await runProc(process.execPath, args, { env, timeoutMs: timeoutMs(r.s) });
    writeFileSync(path.join(outDir, 'stdout.txt'), proc.stdout);
    writeFileSync(path.join(outDir, 'stderr.txt'), proc.stderr);
    r.cli = { proc, outDir };
    r.cli.result = readJson<JResult>(path.join(outDir, 'blastradius.json'));
    r.cli.sarif = readJson<unknown>(path.join(outDir, 'blastradius.sarif'));
    try {
      r.cli.html = readFileSync(path.join(outDir, 'blastradius.html'), 'utf8');
    } catch {
      /* asserted below */
    }
    const c = r.cli.result ? countsOf(r.cli.result) : null;
    log(
      `  ${proc.code === 0 ? 'done' : 'FAIL'} ${r.s.id.padEnd(36)} ${ms(proc.ms)} peak ${proc.peakRssMb ?? '?'}MB exit=${proc.code}${proc.timedOut ? ' TIMEOUT' : ''}` +
        (c ? ` comps=${r.cli.result!.inventory.components} crit=${c.critical} high=${c.high} warn=${r.cli.result!.warnings?.length ?? 0}` : ''),
    );
  });

  // 5. Wait for API scans -------------------------------------------------------------------------
  log('\nWaiting for API scans');
  for (const r of ready) {
    const a = r.api;
    const srv = servers.get(r.s.asOf ?? 'now');
    if (!a || !a.scanId || !srv) continue;
    const w = await waitForScan(srv.api, a.scanId, timeoutMs(r.s), srv.server);
    a.scan = w.scan;
    if (w.error) a.error = w.error;
    if (a.scan?.startedAt && a.scan.finishedAt) a.ms = Date.parse(a.scan.finishedAt) - Date.parse(a.scan.startedAt);
    else delete a.ms;
    if (a.scan?.status === 'succeeded') {
      const j = await srv.api.req<JResult>('GET', `/api/reports/${a.scanId}.json`);
      if (j.status === 200) a.result = typeof j.body === 'string' ? (JSON.parse(j.body) as JResult) : j.body;
    }
    log(`  ${a.scan?.status ?? 'error'} ${r.s.id.padEnd(36)} ${a.ms !== undefined ? ms(a.ms) : ''} ${a.error ?? a.scan?.error ?? ''}`);
  }

  // 6. Assertions per scenario --------------------------------------------------------------------
  log('\nAssertions');
  for (const r of ready) await assertScenario(L, r, servers.get(r.s.asOf ?? 'now')?.api);

  // 7. Robustness probes --------------------------------------------------------------------------
  const probes: Record<string, unknown> = {};
  if (!skipProbes) {
    const now = servers.get('now');
    if (now) Object.assign(probes, await apiProbes(L, now.api, now.server));
    Object.assign(probes, await cliGitProbe(L));
  }

  // 8. Report -------------------------------------------------------------------------------------
  for (const { server, api } of servers.values()) {
    const te = api.transportErrors;
    L.check(`server:${server.name}`, 'transport', `API answered every request (transport errors are retried for GETs and listed)`, te.length === 0,
      te.length ? `${te.length} transport error(s): ${te.slice(0, 5).map((e) => `${e.method} ${e.path} ${e.error} after ${e.afterMs}ms at ${e.at}`).join(' | ')}` : 'none');
    L.check(`server:${server.name}`, 'alive', `server ${server.name} survived the whole run (peak RSS ${server.peakRssMb ?? '?'}MB)`, server.alive,
      server.alive ? 'running' : `exited ${JSON.stringify(server.exit)}; log tail: ${server.log.slice(-800)}`);
  }
  for (const { server } of servers.values()) if (!keepServers) await server.stop();
  const finishedAt = new Date();
  const counts = L.counts();
  const head = await git(['rev-parse', 'HEAD'], PKG_ROOT);
  const dirty = await git(['status', '--porcelain', '--', 'src'], PKG_ROOT);
  const results = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    engine: { commit: head.out.trim() || null, srcDirty: dirty.out.trim().length > 0, node: process.version, cli: CLI },
    settings: { cliJobs, serverConcurrency, reuseCache, hammerDir: H, cacheCli: CACHE_CLI, cacheApi: CACHE_API, os: `${os.type()} ${os.release()}`, cpus: os.cpus().length },
    sources: pre.sources,
    token: pre.token,
    counts,
    verdict: counts.fail > 0 ? 'FAIL' : counts.blocked > 0 ? 'PASS_WITH_BLOCKED' : 'PASS',
    servers: [...servers.entries()].map(([k, v]) => ({ asOf: k, name: v.server.name, url: v.server.url, db: v.server.dbPath, peakRssMb: v.server.peakRssMb, admin: ADMIN_EMAIL, credentialsFile: path.join(H, 'admin.json') })),
    scenarios: runs.map((r) => scenarioSummary(r)),
    probes,
    assertions: L.items,
  };
  writeFileSync(path.join(OUT, 'results.json'), scrub(`${JSON.stringify(results, null, 2)}\n`));
  writeFileSync(path.join(OUT, 'results.md'), scrub(renderMarkdown(results)));
  log(`\n${counts.pass} pass, ${counts.fail} fail, ${counts.blocked} blocked, ${counts.skip} skip — ${results.verdict}`);
  log(`wrote ${path.join(OUT, 'results.json')} and results.md (${ms(results.durationMs)})`);
  if (keepServers && servers.size > 0) {
    log('\n--keep-servers: servers still running (Ctrl-C to stop):');
    for (const [k, v] of servers) log(`  ${k.padEnd(22)} ${v.server.url}`);
    log(`  sign in as ${ADMIN_EMAIL}; password in ${path.join(H, 'admin.json')}`);
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    for (const { server } of servers.values()) await server.stop();
  }
  if (counts.fail > 0) return 1;
  if (strict && counts.blocked > 0) return 3;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Scenario assertions
// ---------------------------------------------------------------------------------------------

async function assertScenario(L: Ledger, r: ScenarioRun, api: ApiClient | undefined): Promise<void> {
  const s = r.s;
  const id = s.id;
  const enrichHosts = s.sources.filter((h) => h !== 'github.com');
  const expectPurls = s.expect.filter((e) => e.level !== 'none' && e.level !== 'present').map((e) => e.purl);
  const cli = r.cli;
  const res = cli?.result;

  // CLI run
  L.check(id, 'cli.exit', 'CLI scan exits 0 and writes json/sarif/html', !!cli && cli.proc.code === 0 && !!res && !!cli.sarif && !!cli.html,
    cli ? `exit=${cli.proc.code}${cli.proc.timedOut ? ' (timeout)' : ''} json=${!!res} sarif=${!!cli.sarif} html=${!!cli.html}; stderr tail: ${cli.proc.stderr.slice(-300)}` : 'not run');
  if (cli) {
    L.check(id, 'cli.budget.time', `CLI scan within ${budgetSec(s)}s budget`, cli.proc.ms <= budgetSec(s) * 1000, `${ms(cli.proc.ms)}`);
    L.check(id, 'cli.budget.mem', `CLI peak RSS within ${RSS_BUDGET_MB}MB`, (cli.proc.peakRssMb ?? 0) <= RSS_BUDGET_MB, `${cli.proc.peakRssMb ?? '?'}MB`);
  }
  if (res) {
    const pj = validateJson(res);
    L.check(id, 'cli.json', 'JSON report valid (schema 1, sorted, levels match scores, https evidence)', pj.length === 0, pj.join('; ') || `${res.findings.length} findings`);
    const floor = MIN_INVENTORY[id];
    if (floor?.components !== undefined)
      L.check(id, 'cli.inventory.components', `inventory has >= ${floor.components} components (manual lockfile sweep)`, res.inventory.components >= floor.components, `components=${res.inventory.components}`);
    if (floor?.assets !== undefined)
      L.check(id, 'cli.inventory.assets', `inventory has >= ${floor.assets} assets`, res.inventory.assets >= floor.assets, `assets=${res.inventory.assets}`);
    if (s.lockfile && s.lockfile.endsWith('package-lock.json')) L.check(id, 'cli.inventory.nonempty', 'lockfile components ingested', res.inventory.components > 0, `components=${res.inventory.components}`);
  }
  if (cli?.sarif !== undefined) {
    const ps = validateSarif(cli.sarif, expectPurls);
    L.check(id, 'cli.sarif', 'SARIF 2.1.0 shape valid, expected purls present', ps.length === 0, ps.join('; ') || 'ok');
  }
  if (cli?.html !== undefined) {
    const mustText = (MUST_WARN[id] ?? []).filter((m) => /yarn/.test(m.what)).map(() => /yarn\.lock/);
    const ph = validateHtml(cli.html, expectPurls, mustText);
    L.check(id, 'cli.html', 'HTML report safe (CSP, no script/handlers/js: URLs) and shows expected purls', ph.length === 0, ph.join('; ') || `${cli.html.length} bytes`);
  }

  // Expectations (CLI and API)
  const apiRes = r.api?.result;
  for (const [i, e] of s.expect.entries()) {
    // KB-backed expectations need no remote source; a failure is a failure.
    const needs: string[] = [];
    if (res) {
      const v = checkExpectation(res, e);
      L.check(id, `cli.expect.${i}`, `CLI: ${e.purl} ${e.level}`, v.ok, v.detail, needs);
    }
    if (apiRes) {
      const v = checkExpectation(apiRes, e);
      L.check(id, `api.expect.${i}`, `API: ${e.purl} ${e.level}`, v.ok, v.detail, needs);
    }
  }
  for (const rule of s.expectAbsent ?? []) {
    const needs = rule === 'reason:malware' ? ['api.osv.dev'] : enrichHosts;
    if (res) {
      const v = checkAbsent(res, rule);
      L.check(id, `cli.absent.${rule}`, `CLI: no finding with ${rule}`, v.ok, v.detail, needs);
    }
    if (apiRes) {
      const v = checkAbsent(apiRes, rule);
      L.check(id, `api.absent.${rule}`, `API: no finding with ${rule}`, v.ok, v.detail, needs);
    }
  }

  // Must-warn (malformed / unsupported inputs) and source honesty
  for (const [label, rr] of [['CLI', res], ['API', apiRes]] as const) {
    if (!rr) continue;
    const warnings = rr.warnings ?? [];
    for (const m of MUST_WARN[id] ?? []) L.check(id, `${label.toLowerCase()}.warn.${m.what}`, `${label}: ${m.what}`, warnings.some((w) => m.re.test(w)), `${warnings.length} warnings; matching: ${warnings.filter((w) => m.re.test(w)).slice(0, 2).join(' | ') || 'none'}`);
    if (label === 'API') continue; // source checks once, on the CLI run
    const bySrc = warningsBySource(warnings);
    for (const [enricher, host] of Object.entries(ENRICHER_HOST)) {
      const npmComponents = res?.inventory.byEcosystem?.npm ?? 0;
      // npm and OSV are queried for npm components; the other enrichers per scenario sources.
      if (enricher === 'npm' || enricher === 'osv' ? npmComponents === 0 : !s.sources.includes(host)) continue;
      const ws = bySrc.get(enricher) ?? [];
      const failures = ws.filter((w) => /failed|HTTP \d{3}|returned \d{3}|timed? ?out|ECONN|ENOTFOUND|rate limit/i.test(w));
      if (blockedHost(host)) {
        L.check(id, `cli.source.${enricher}.surfaced`, `CLI: blocked ${host} surfaced as a warning (not silently clean)`, failures.length > 0, `${failures.length} ${enricher} failure warning(s): ${failures[0]?.slice(0, 160) ?? 'NONE — a blocked source produced no warning'}`);
      } else {
        // Failures caused by another unavailable source (Open Collective behind the egress proxy, the
        // unauthenticated GitHub rate limit) are "blocked" by that source; anything else fails.
        const causes = new Set(failures.map((w) => failureSource(w)).map((c) => (c === 'github-rate' ? GITHUB_RATE : c ?? 'unknown')));
        const explained = failures.length > 0 && [...causes].every((c) => blockedHost(c) && c !== host);
        L.check(id, `cli.source.${enricher}.clean`, `CLI: ${enricher} enrichment from ${host} had no request failures`, failures.length === 0 || explained,
          failures.length ? `${failures.length} failure(s) (causes: ${[...causes].join(', ')}): ${failures.slice(0, 3).join(' | ')}` : `${ws.length} ${enricher} warning(s), none failures`,
          explained ? [host, ...causes] : [host]);
      }
    }
  }

  // API run
  const a = r.api;
  L.check(id, 'api.scan', 'API: project created, scan queued and succeeded', !!a?.scan && a.scan.status === 'succeeded' && !!apiRes,
    a ? `${a.error ?? ''} status=${a.scan?.status} error=${a.scan?.error ?? ''} ${a.ms !== undefined ? ms(a.ms) : ''}` : 'not run');
  if (!api || !a?.scanId || !apiRes) return;
  L.check(id, 'api.budget.time', `API scan within ${budgetSec(s)}s budget`, (a.ms ?? Infinity) <= budgetSec(s) * 1000, a.ms !== undefined ? ms(a.ms) : 'unknown');
  const pj = validateJson(apiRes);
  L.check(id, 'api.json', 'API JSON report valid', pj.length === 0, pj.join('; ') || 'ok');
  if (res) {
    const d = diffResults(res, apiRes);
    // Two independent runs share one unauthenticated GitHub quota: when the only differing factors are
    // GitHub-derived and a run hit the rate limit, the disagreement is the missing token's, not the engine's.
    const factors = differingFactors(res, apiRes);
    const rateLimited = [...(res.warnings ?? []), ...(apiRes.warnings ?? [])].some((w) => failureSource(w) === 'github-rate');
    const githubOnly = d.length > 0 && rateLimited && [...factors].every((f) => GITHUB_FACTORS.has(f)) && !d.some((x) => x.startsWith('inventory'));
    L.check(id, 'agree', 'CLI and API agree (inventory, purls, levels, scores ±1)', d.length === 0 || githubOnly,
      d.length ? `${d.join('; ')}; differing factors: ${[...factors].join(', ')}${githubOnly ? ' (GitHub-derived only; GitHub API rate-limited)' : ''}` : `${res.findings.length} findings identical in level`,
      githubOnly ? [GITHUB_RATE] : []);
  }
  // Report downloads through the API
  const sar = await api.req('GET', `/api/reports/${a.scanId}.sarif`);
  let sarBody: unknown = sar.body;
  if (typeof sarBody === 'string') sarBody = (() => { try { return JSON.parse(sarBody as string) as unknown; } catch { return undefined; } })();
  const ps = sar.status === 200 ? validateSarif(sarBody, expectPurls) : [`HTTP ${sar.status}`];
  if (!/attachment/.test(sar.headers.get('content-disposition') ?? '')) ps.push('no Content-Disposition: attachment');
  L.check(id, 'api.sarif', 'API SARIF download valid (attachment)', ps.length === 0, ps.join('; ') || 'ok');
  const html = await api.req('GET', `/api/reports/${a.scanId}.html`);
  const ph = html.status === 200 ? validateHtml(html.text, expectPurls) : [`HTTP ${html.status}`];
  if (!/default-src 'none'/.test(html.headers.get('content-security-policy') ?? '')) ph.push('no CSP response header');
  L.check(id, 'api.html', 'API HTML download safe (CSP header + meta, no script) and shows expected purls', ph.length === 0, ph.join('; ') || `${html.text.length} bytes`);

  // Findings endpoints (what the Findings screen reads)
  type Row = { id: string; purl: string; level: string; score: number };
  const rows: Row[] = [];
  let cursor: string | null = null;
  let total = -1;
  let pages = 0;
  do {
    const q: string = `/api/findings?project=${a.projectId}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const fr = await api.req<{ items: Row[]; total: number; nextCursor: string | null }>('GET', q);
    if (fr.status !== 200) {
      L.check(id, 'api.findings', 'API /api/findings pages through every finding', false, `${q} -> ${fr.status} ${fr.text.slice(0, 200)}`);
      return;
    }
    rows.push(...fr.body.items);
    total = fr.body.total;
    cursor = fr.body.nextCursor;
    pages++;
  } while (cursor && pages < 100);
  L.check(id, 'api.findings', 'API /api/findings pages through every finding (total == report)', rows.length === apiRes.findings.length && total === apiRes.findings.length && new Set(rows.map((x) => x.purl)).size === rows.length,
    `rows=${rows.length} total=${total} report=${apiRes.findings.length} pages=${pages}`);
  const target = rows.find((x) => expectPurls.includes(x.purl)) ?? rows[0];
  if (target) {
    const fd = await api.req<{ purl: string; reasons: { evidence: string[] }[]; assets: unknown[] }>('GET', `/api/findings/${target.id}`);
    const ok = fd.status === 200 && fd.body.purl === target.purl && Array.isArray(fd.body.reasons) && Array.isArray(fd.body.assets);
    L.check(id, 'api.finding.detail', `API finding detail for ${target.purl}`, ok, `HTTP ${fd.status}; reasons=${ok ? fd.body.reasons.length : '?'} evidence=${ok ? fd.body.reasons.flatMap((x) => x.evidence).length : '?'}`);
    const g = await api.req<{ nodes: { id: string; label: string }[]; edges: unknown[] }>('GET', `/api/graph?finding=${encodeURIComponent(target.id)}`);
    const gok = g.status === 200 && Array.isArray(g.body.nodes) && g.body.nodes.length > 0 && g.body.nodes.some((n) => n.id.includes(target.purl) || n.label.includes(target.purl.replace(/^pkg:npm\//, '').split('@')[0]!.replace('%40', '@')));
    L.check(id, 'api.graph', 'API graph for the finding contains the component', gok, `HTTP ${g.status}; nodes=${g.status === 200 ? g.body.nodes.length : '?'} edges=${g.status === 200 ? g.body.edges.length : '?'}`);
  }
  const ex = await api.req<{ rows: unknown[]; columns: unknown[]; cells: unknown[] }>('GET', `/api/exposure?project=${a.projectId}`);
  L.check(id, 'api.exposure', 'API exposure matrix returns rows/columns', ex.status === 200 && Array.isArray(ex.body.rows) && Array.isArray(ex.body.columns), `HTTP ${ex.status}; rows=${ex.status === 200 ? ex.body.rows.length : '?'} cols=${ex.status === 200 ? ex.body.columns.length : '?'} cells=${ex.status === 200 ? ex.body.cells.length : '?'}`);
  const pr = await api.req<{ components: number; counts: Record<string, number>; lastScan: { status: string } | null }>('GET', `/api/projects/${a.projectId}`);
  const c = countsOf(apiRes);
  L.check(id, 'api.project.row', 'API project row (Org home) matches the scan', pr.status === 200 && pr.body.components === apiRes.inventory.components && pr.body.counts.critical === c.critical && pr.body.counts.high === c.high,
    `HTTP ${pr.status}; components=${pr.status === 200 ? pr.body.components : '?'} vs ${apiRes.inventory.components}; critical=${pr.status === 200 ? pr.body.counts.critical : '?'} vs ${c.critical}`);
}

let blockedHosts: ReadonlySet<string> = new Set();
function blockedHost(h: string): boolean {
  return blockedHosts.has(h);
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

const GIT_URL_TARGET = { url: 'https://github.com/Esri/a11y-map', commit: 'a1f8b3e33ff5d0bfe1e33006f1af63e91c76baa0', purl: 'pkg:npm/event-stream@3.3.6' };

async function apiProbes(L: Ledger, api: ApiClient, server: Server): Promise<Record<string, unknown>> {
  const P = 'probe:api';
  const out: Record<string, unknown> = {};
  const anon = new ApiClient(server.url);

  // Auth and CSRF
  const me = await anon.req('GET', '/api/me');
  L.check(P, 'auth.401', 'no session -> 401 unauthenticated', me.status === 401, `GET /api/me -> ${me.status}`);
  const bad = await anon.login({ email: ADMIN_EMAIL, password: 'wrong-password-123' });
  L.check(P, 'auth.wrong', 'wrong password -> 401', bad.status === 401, `-> ${bad.status}`);
  const csrf = await api.req('POST', '/api/projects', { name: 'csrf', tier: 'Small', target: GIT_URL_TARGET.url }, { csrf: false });
  L.check(P, 'csrf', 'mutation without X-Requested-With -> 403 csrf', csrf.status === 403 && /csrf/.test(csrf.text), `-> ${csrf.status} ${csrf.text.slice(0, 120)}`);

  // Rejected targets
  const before = await api.req<{ total: number }>('GET', '/api/projects');
  const root = path.join(hammerDir(), 'repos');
  const link = path.join(root, 'hammer-escape-link');
  try {
    rmSync(link, { force: true });
    symlinkSync('/etc', link);
  } catch {
    /* reported via the check */
  }
  const rejected: [string, string][] = [
    ['non-allowlisted host', 'https://evil.example.com/owner/repo'],
    ['look-alike host', 'https://github.com.evil.example/owner/repo'],
    ['http (not https)', 'http://github.com/Esri/a11y-map'],
    ['credentials in URL', 'https://user:pass@github.com/Esri/a11y-map'],
    ['query string', 'https://github.com/Esri/a11y-map?x=1'],
    ['port', 'https://github.com:444/Esri/a11y-map'],
    ['dot segments', 'https://github.com/Esri/../../etc'],
    ['file:// URL', 'file:///etc'],
    ['ext:: transport', 'ext::sh -c touch% /tmp/pwned'],
    ['scp-like ssh', 'git@github.com:Esri/a11y-map.git'],
    ['absolute path outside root', '/etc'],
    ['relative traversal', '../../../../etc'],
    ['traversal from inside root', path.join(root, '..', '..', '..', 'etc')],
    ['symlink inside root to /etc', link],
    ['NUL byte', `${root}/x\u0000y`],
  ];
  const rej: Record<string, number> = {};
  for (const [what, target] of rejected) {
    const r = await api.req<{ error?: { code?: string } }>('POST', '/api/projects', { name: `reject-${what.replace(/\W+/g, '-')}`, tier: 'Small', target });
    rej[what] = r.status;
    L.check(P, `reject.${what}`, `rejects target: ${what}`, r.status === 400 && (r.body as { error?: { code?: string } }).error?.code === 'bad_request', `${JSON.stringify(target).slice(0, 80)} -> ${r.status} ${r.text.slice(0, 140)}`);
  }
  const after = await api.req<{ total: number }>('GET', '/api/projects');
  L.check(P, 'reject.nothing-created', 'no project created by rejected targets', before.body.total === after.body.total, `projects ${before.body.total} -> ${after.body.total}`);
  rmSync(link, { force: true });
  out.rejectedTargets = rej;

  // Git URL target through the API
  const pr = await api.req<{ id: string; target: string }>('POST', '/api/projects', { name: 'git-url-esri-a11y-map', tier: 'Small', target: GIT_URL_TARGET.url });
  L.check(P, 'git.create', 'project with https github URL target accepted', pr.status === 201, `-> ${pr.status} ${pr.text.slice(0, 160)}`);
  if (pr.status === 201) {
    for (const ref of ['--upload-pack=touch /tmp/x', '../../etc', 'main..x', '-oProxyCommand=id']) {
      const badRef = await api.req('POST', `/api/projects/${pr.body.id}/scans`, { ref });
      L.check(P, `scan.badref.${ref}`, `hostile git ref ${JSON.stringify(ref)} rejected (400)`, badRef.status === 400, `-> ${badRef.status} ${badRef.text.slice(0, 120)}`);
    }
    const s1 = await api.req<ScanRow>('POST', `/api/projects/${pr.body.id}/scans`, {});
    const s2 = await api.req('POST', `/api/projects/${pr.body.id}/scans`, {});
    L.check(P, 'scan.409', 'second scan while one is queued/running -> 409 conflict', s2.status === 409, `-> ${s2.status} ${s2.text.slice(0, 120)}`);
    if (s1.status === 202) {
      const t0 = Date.now();
      const w = await waitForScan(api, s1.body.id, 1_200_000, server);
      const ok = w.scan?.status === 'succeeded';
      L.check(P, 'git.scan', 'API clones the https URL and the scan succeeds', ok, `status=${w.scan?.status} error=${w.scan?.error ?? w.error ?? ''} ${ms(Date.now() - t0)}`, ['github.com']);
      L.check(P, 'git.commit', `scan records the cloned commit (${GIT_URL_TARGET.commit.slice(0, 10)})`, w.scan?.commit === GIT_URL_TARGET.commit, `commit=${w.scan?.commit}`);
      if (ok) {
        const j = await api.req<JResult>('GET', `/api/reports/${s1.body.id}.json`);
        const res = typeof j.body === 'string' ? (JSON.parse(j.body) as JResult) : j.body;
        const v = checkExpectation(res, { purl: GIT_URL_TARGET.purl, level: 'critical' });
        L.check(P, 'git.finding', `git URL scan finds ${GIT_URL_TARGET.purl} critical`, v.ok, v.detail);
        out.gitUrlScan = { ms: Date.now() - t0, commit: w.scan?.commit, findings: res.findings.length, counts: countsOf(res) };
      }
    } else {
      L.check(P, 'git.scan', 'API accepts a scan for the git URL project', false, `-> ${s1.status} ${s1.text.slice(0, 160)}`);
    }
  }
  return out;
}

async function cliGitProbe(L: Ledger): Promise<Record<string, unknown>> {
  const P = 'probe:cli';
  const outDir = path.join(RUN_DIR, 'probe-cli-git');
  const env: NodeJS.ProcessEnv = { ...process.env, BLASTRADIUS_CACHE_DIR: CACHE_CLI };
  delete env.BLASTRADIUS_OFFLINE;
  const proc = await runProc(process.execPath, [CLI, 'scan', GIT_URL_TARGET.url, '--out', outDir, '--format', 'json'], { env, timeoutMs: 1_200_000 });
  const res = readJson<JResult>(path.join(outDir, 'blastradius.json'));
  L.check(P, 'git.scan', 'CLI scans an https git URL (engine clone)', proc.code === 0 && !!res, `exit=${proc.code} ${ms(proc.ms)} ${proc.stderr.slice(-200)}`, ['github.com']);
  if (res) {
    const v = checkExpectation(res, { purl: GIT_URL_TARGET.purl, level: 'critical' });
    L.check(P, 'git.finding', `CLI git URL scan finds ${GIT_URL_TARGET.purl} critical`, v.ok, v.detail);
  }
  const rejects: [string, string][] = [
    ['file:// URL', 'file:///etc'],
    ['ext:: transport', 'ext::sh -c id'],
    ['option injection', '--upload-pack=id'],
  ];
  const codes: Record<string, number | null> = {};
  for (const [what, target] of rejects) {
    const p = await runProc(process.execPath, [CLI, 'scan', '--format', 'json', '--out', path.join(RUN_DIR, 'probe-cli-reject'), '--', target], { env, timeoutMs: 60_000 });
    codes[what] = p.code;
    L.check(P, `reject.${what}`, `CLI refuses target: ${what}`, p.code !== 0 && !existsSync(path.join(RUN_DIR, 'probe-cli-reject', 'blastradius.json')), `exit=${p.code} ${p.stderr.trim().slice(-160)}`);
  }
  return { cliGitUrl: { ms: proc.ms, peakRssMb: proc.peakRssMb, exit: proc.code, findings: res?.findings.length ?? null }, cliRejects: codes };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

function scenarioSummary(r: ScenarioRun): Record<string, unknown> {
  const res = r.cli?.result;
  const api = r.api?.result;
  return {
    id: r.s.id,
    repo: r.s.repo,
    commit: r.s.commit,
    asOf: r.s.asOf ?? null,
    scanDir: r.scanDir ?? null,
    clone: r.clone ? { ok: r.clone.ok, ms: r.clone.ms, reused: r.clone.reused, error: r.clone.error ?? null } : null,
    cli: r.cli
      ? {
          exit: r.cli.proc.code,
          timedOut: r.cli.proc.timedOut,
          ms: r.cli.proc.ms,
          peakRssMb: r.cli.proc.peakRssMb,
          outDir: r.cli.outDir,
          inventory: res?.inventory ?? null,
          counts: res ? countsOf(res) : null,
          warnings: res?.warnings?.length ?? null,
          warningsBySource: res ? Object.fromEntries([...warningsBySource(res.warnings ?? [])].map(([k, v]) => [k, v.length])) : null,
          top: res?.findings.slice(0, 5).map((f) => ({ purl: f.purl, level: f.level, score: f.score, reason: f.reasons[0]?.factor ?? null })) ?? [],
        }
      : null,
    api: r.api
      ? {
          server: r.api.server,
          projectId: r.api.projectId ?? null,
          scanId: r.api.scanId ?? null,
          status: r.api.scan?.status ?? null,
          ms: r.api.ms ?? null,
          error: r.api.error ?? r.api.scan?.error ?? null,
          counts: api ? countsOf(api) : null,
          warnings: api?.warnings?.length ?? null,
        }
      : null,
  };
}

interface ResultsDoc {
  runId: string;
  startedAt: string;
  durationMs: number;
  engine: { commit: string | null; srcDirty: boolean; node: string };
  settings: { cliJobs: number; serverConcurrency: number; reuseCache: boolean };
  sources: Preflight['sources'];
  token: Preflight['token'];
  counts: Record<string, number>;
  verdict: string;
  scenarios: Record<string, unknown>[];
  assertions: { scope: string; title: string; status: string; detail: string; blockedBy?: string[] }[];
  servers: { name: string; url: string; db: string; peakRssMb: number | null }[];
}

function renderMarkdown(d: ResultsDoc): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines: string[] = [];
  lines.push(`# Blastradius hammer results`, '');
  lines.push(`**Verdict: ${d.verdict}** — ${d.counts.pass} pass, ${d.counts.fail} fail, ${d.counts.blocked} blocked, ${d.counts.skip} skip.`, '');
  lines.push(`Run ${d.runId}, ${ms(d.durationMs)}. Engine ${d.engine.commit?.slice(0, 10) ?? '?'}${d.engine.srcDirty ? ' (+ uncommitted src changes)' : ''}, Node ${d.engine.node}. CLI jobs ${d.settings.cliJobs}, server concurrency ${d.settings.serverConcurrency}, ${d.settings.reuseCache ? 'reused' : 'fresh'} HTTP caches.`, '');
  lines.push('A "blocked" assertion passed only because, or could not be judged while, a data source it depends on was unreachable. It is not a pass.', '');
  lines.push('## Data sources', '', '| host | state | detail |', '|---|---|---|');
  for (const s of d.sources) lines.push(`| ${s.host} | ${s.state} | ${esc(s.detail.slice(0, 120))} |`);
  lines.push(`| GitHub token | ${d.token.source} | core limit ${d.token.coreLimit ?? '?'}${d.token.authenticated === false ? ' (unauthenticated)' : ''} |`, '');
  lines.push('## Scenarios', '', '| scenario | CLI time | CLI peak RSS | API time | components | crit/high/med/low | warnings | assertions (p/f/b) |', '|---|---|---|---|---|---|---|---|');
  for (const s of d.scenarios) {
    const cli = s.cli as { ms: number; peakRssMb: number | null; inventory: { components: number } | null; counts: Record<string, number> | null; warnings: number | null } | null;
    const api = s.api as { ms: number | null; status: string | null } | null;
    const as = d.assertions.filter((a) => a.scope === s.id);
    const n = (st: string) => as.filter((a) => a.status === st).length;
    const c = cli?.counts;
    lines.push(
      `| ${s.id} | ${cli ? ms(cli.ms) : '-'} | ${cli?.peakRssMb ?? '-'} MB | ${api?.ms != null ? ms(api.ms) : api?.status ?? '-'} | ${cli?.inventory?.components ?? '-'} | ${c ? `${c.critical}/${c.high}/${c.medium}/${c.low}` : '-'} | ${cli?.warnings ?? '-'} | ${n('pass')}/${n('fail')}/${n('blocked')} |`,
    );
  }
  lines.push('');
  const fails = d.assertions.filter((a) => a.status === 'fail');
  lines.push(`## Failures (${fails.length})`, '');
  if (fails.length === 0) lines.push('None.');
  for (const a of fails) lines.push(`- **${a.scope}** — ${esc(a.title)}: ${esc(a.detail.slice(0, 500))}`);
  lines.push('');
  const blockedA = d.assertions.filter((a) => a.status === 'blocked');
  lines.push(`## Blocked by missing sources (${blockedA.length})`, '');
  if (blockedA.length === 0) lines.push('None.');
  for (const a of blockedA) lines.push(`- ${a.scope} — ${esc(a.title)} (blocked: ${(a.blockedBy ?? []).join(', ')})`);
  lines.push('', '## All assertions', '', '| scope | assertion | status | detail |', '|---|---|---|---|');
  for (const a of d.assertions) lines.push(`| ${a.scope} | ${esc(a.title)} | ${a.status.toUpperCase()} | ${esc(a.detail.slice(0, 220))} |`);
  lines.push('', '## Servers', '');
  for (const s of d.servers) lines.push(`- ${s.name}: ${s.url} db ${s.db} (peak RSS ${s.peakRssMb ?? '?'} MB)`);
  return `${lines.join('\n')}\n`;
}

const liveServers: Server[] = [];
process.on('exit', () => {
  for (const s of liveServers) s.kill();
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) if (!keepServers || sig === 'SIGTERM') process.once(sig, () => process.exit(130));

/**
 * Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set at startup. In a container
 * whose egress goes through a proxy (which may also inject GitHub credentials), the runner, the CLI
 * and the servers must use it, or every GitHub call runs unauthenticated and the preflight would
 * report the egress policy wrongly. Re-exec once with the variable set; children inherit it.
 * The engine itself does not honour HTTPS_PROXY on its own; that is reported, not hidden.
 */
function reexecThroughProxy(): Promise<number> | null {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy || process.env.NODE_USE_ENV_PROXY === '1' || process.env.BLASTRADIUS_HAMMER_NO_PROXY_REEXEC === '1') return null;
  process.stdout.write('egress proxy configured (HTTPS_PROXY): re-running with NODE_USE_ENV_PROXY=1 so Node fetch uses it\n');
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', BLASTRADIUS_HAMMER_NO_PROXY_REEXEC: '1' },
  });
  // Forward stop signals so the child shuts its servers down (and --keep-servers' Ctrl-C works).
  // Ctrl-C in a terminal already reaches the child (same process group); forward it only otherwise.
  process.prependListener('SIGTERM', () => child.kill('SIGTERM'));
  process.prependListener('SIGINT', () => {
    if (!process.stdout.isTTY) child.kill('SIGINT');
  });
  return new Promise((resolve) => child.on('close', (code, signal) => resolve(code ?? (signal ? 130 : 1))));
}

const reexec = reexecThroughProxy();
(reexec ?? main())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`hammer crashed: ${scrub((e as Error).stack ?? String(e))}\n`);
    process.exitCode = 1;
  });
