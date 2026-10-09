/**
 * `blastradius serve`: open the store, wire the job runner, optionally seed dev data, and
 * listen with @hono/node-server. Default host is 127.0.0.1 (loopback only).
 */
import { AlertWatcher, type AlertWatcherOptions } from './watch.js';
import { AccountIndexer, type AccountIndexerOptions } from './accounts.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve as nodeServe } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { GitRunner } from '../ingest/git.js';
import type { ScanOptions } from '../pipeline.js';
import { createApp } from './app.js';
import type { ServerConfig, ServerDeps } from './context.js';
import { ScanJobs, type FixtureReplay } from './jobs.js';
import { ConcurrencyGate, RateLimiter } from './ratelimit.js';
import { GitHubAdapter, githubConfigFromEnv, type GitHubAppConfig } from './sources/github.js';
import { SourceService } from './sources/service.js';
import { DEFAULT_WEB_DIR } from './static.js';
import {
  closeStore,
  createBinding,
  createProject,
  deleteExpiredSessions,
  deleteUserSessions,
  enqueueScan,
  failInterruptedScans,
  latestSucceededScan,
  listBindingRecords,
  listDevUsers,
  listProjects,
  openStore,
  seedDev,
  type Store,
} from './store/index.js';

/** test/fixtures (recorded API responses) and the e2e fixture repo, from src/ and dist/. */
export const FIXTURES_DIR = fileURLToPath(new URL('../../test/fixtures', import.meta.url));
export const E2E_REPO_DIR = fileURLToPath(new URL('../../test/fixtures/e2e-repo', import.meta.url));
/** Shortly after the 2018-11-26 event-stream advisory: the replay date for the fixture scan. */
export const FIXTURE_AS_OF = new Date('2018-11-27T00:00:00Z');
export const DEV_PROJECT_NAME = 'payments-platform';

/** --dev-seed: projects on fixture repos (under test/fixtures) replay the recorded responses as of the fixture date. */
export const DEV_FIXTURE_REPLAY: FixtureReplay = { root: FIXTURES_DIR, asOf: FIXTURE_AS_OF, fixturesDir: FIXTURES_DIR };

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface CreateServerOptions {
  /** SQLite path; ':memory:' by default. */
  dbPath?: string;
  store?: Store;
  devMode?: boolean;
  /** Local scan root(s). Default: env BLASTRADIUS_SCAN_ROOT, else the cwd. */
  localRoots?: string[];
  offline?: boolean;
  fixturesDir?: string;
  /** Reference time for every scan (offline demos). */
  asOf?: Date;
  /** Replay fixture-repo targets offline at the fixture date (see ScanJobsOptions.fixtureReplay). */
  fixtureReplay?: FixtureReplay;
  /** web/dist; null disables static serving. */
  webDir?: string | null;
  concurrency?: number;
  secureCookies?: ServerConfig['secureCookies'];
  /** Trusted reverse proxy addresses (X-Forwarded-For / -Proto are honoured only from these). */
  trustProxy?: string[];
  /** Engine overrides (tests). */
  scanOptions?: Partial<ScanOptions>;
  gitRunner?: GitRunner;
  log?: (m: string) => void;
  /** Failed sign-in attempts per client address per 15 minutes (default 50). */
  loginIpRateLimit?: number;
  /** Scans per user per hour (default 60). */
  scanRateLimit?: number;
  /** Knowledge-pack alerts and webhook (defaults from BLASTRADIUS_PACK / BLASTRADIUS_ALERT_WEBHOOK). */
  alerts?: AlertWatcherOptions;
  /** GitHub App connector; default from BLASTRADIUS_GITHUB_* (null: not configured). */
  github?: GitHubAppConfig | null;
  /** Account index options (tests inject an offline HttpClient; default: scanOptions.http when given). */
  accounts?: AccountIndexerOptions;
}

export function defaultLocalRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const r = env.BLASTRADIUS_SCAN_ROOT;
  return r && r.trim() ? r.split(':').filter(Boolean) : [process.cwd()];
}

/** Build the deps and app without listening (tests and serve()). */
export function createServer(opts: CreateServerOptions = {}) {
  const log = opts.log ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const store = opts.store ?? openStore({ path: opts.dbPath ?? ':memory:' });
  const config: ServerConfig = {
    devMode: opts.devMode === true,
    localRoots: opts.localRoots ?? defaultLocalRoots(),
    offline: opts.offline === true,
    ...(opts.fixturesDir !== undefined ? { fixturesDir: opts.fixturesDir } : {}),
    webDir: opts.webDir === undefined ? (existsSync(DEFAULT_WEB_DIR) ? DEFAULT_WEB_DIR : null) : opts.webDir,
    version: packageVersion(),
    ...(opts.secureCookies ? { secureCookies: opts.secureCookies } : {}),
    ...(opts.trustProxy && opts.trustProxy.length > 0 ? { trustProxy: [...opts.trustProxy] } : {}),
  };
  const watcher = new AlertWatcher(store, { log, ...(opts.alerts ?? {}) });
  const githubConfig = opts.github === undefined ? githubConfigFromEnv() : opts.github;
  // Late-bound: the scan runner asks the sources for fetch-only checkouts of connected repos.
  let sources: SourceService | undefined;
  const accounts = new AccountIndexer(store, {
    offline: config.offline,
    ...(config.fixturesDir !== undefined ? { fixturesDir: config.fixturesDir } : {}),
    ...(opts.scanOptions?.http ? { http: opts.scanOptions.http } : {}),
    ...(opts.scanOptions?.cacheDir !== undefined ? { cacheDir: opts.scanOptions.cacheDir } : {}),
    log,
    ...(opts.accounts ?? {}),
  });
  const jobs = new ScanJobs({
    onScanSucceeded: (projectId, mode) => {
      watcher.afterScan(projectId);
      // Registry data is fetched the way the scan fetched it (a fixture replay stays offline).
      accounts.afterScan(projectId, mode);
    },
    onScanFinished: (projectId, scanId, ok) => sources?.onScanFinished(projectId, scanId, ok),
    materialise: (projectId, ref) => (sources ? sources.materialiseForProject(projectId, ref) : Promise.resolve(null)),
    store,
    localRoots: () => config.localRoots,
    offline: config.offline,
    ...(config.fixturesDir !== undefined ? { fixturesDir: config.fixturesDir } : {}),
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
    ...(opts.fixtureReplay ? { fixtureReplay: opts.fixtureReplay } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.scanOptions ? { scanOptions: opts.scanOptions } : {}),
    ...(opts.gitRunner ? { gitRunner: opts.gitRunner } : {}),
    log,
  });
  sources = new SourceService({ store, jobs, github: githubConfig ? new GitHubAdapter(githubConfig) : null, log });
  const deps: ServerDeps = {
    store,
    jobs,
    sources,
    config,
    log,
    loginLimiter: new RateLimiter(10, 15 * 60_000),
    loginIpLimiter: new RateLimiter(opts.loginIpRateLimit ?? 50, 15 * 60_000),
    loginGate: new ConcurrencyGate(4, 32),
    scanLimiter: new RateLimiter(opts.scanRateLimit ?? 60, 60 * 60_000),
    watcher,
    accounts,
  };
  return { app: createApp(deps), deps, store, jobs, config };
}

export interface DevSeedOutcome {
  orgId: string;
  password: string;
  users: string[];
  projectId: string;
  scanId: string | null;
}

/**
 * Dev seed: users and org from the store seed, plus project "payments-platform" on the e2e
 * fixture repo with an offline fixture scan as of 2018-11-27 (queued, not awaited).
 */
export async function seedDevData(deps: Pick<ServerDeps, 'store' | 'jobs' | 'config'>): Promise<DevSeedOutcome> {
  const { store, jobs, config } = deps;
  const seeded = await seedDev(store, { devMode: true });
  const admin = seeded.users.find((u) => u.role === 'org_admin')!;
  if (!config.localRoots.includes(E2E_REPO_DIR)) config.localRoots.push(E2E_REPO_DIR);
  const existing = listProjects(store, seeded.org.id).find((p) => p.name === DEV_PROJECT_NAME);
  const project =
    existing ??
    createProject(
      store,
      seeded.org.id,
      { name: DEV_PROJECT_NAME, tier: 'Standard', target: E2E_REPO_DIR, owner: 'Payments · fixture repo' },
      admin.id,
    );
  // The seeded Developer is also bound to this project, so they can triage its findings
  // (Developer's project-scope grant, docs/UX.md §9).
  const developer = seeded.users.find((u) => u.role === 'developer');
  const bound = listBindingRecords(store, seeded.org.id, { projectId: project.id }).some(
    (b) => b.roleId === 'developer' && b.scope.kind === 'project' && b.subject.kind === 'user' && b.subject.userId === developer?.id,
  );
  if (developer && !bound) {
    createBinding(store, seeded.org.id, { roleId: 'developer', subject: { kind: 'user', userId: developer.id }, scope: { kind: 'project', projectId: project.id } }, admin.id);
  }
  let scanId: string | null = null;
  if (!latestSucceededScan(store, project.id)) {
    const scan = enqueueScan(store, seeded.org.id, project.id, { requestedBy: admin.id, offline: true });
    jobs.setOverrides(scan.id, { offline: true, fixturesDir: FIXTURES_DIR, asOf: FIXTURE_AS_OF });
    jobs.kick();
    scanId = scan.id;
  }
  return { orgId: seeded.org.id, password: seeded.password, users: seeded.users.map((u) => u.email), projectId: project.id, scanId };
}

export interface ServeOptions extends CreateServerOptions {
  port?: number;
  host?: string;
  devSeed?: boolean;
}

/**
 * Scan reference dates for `serve`: --as-of applies to every scan. Under --dev-seed only projects
 * whose target is a fixture repo replay the fixture date; everything else scans as of now.
 */
export function serveScanDates(opts: Pick<ServeOptions, 'asOf' | 'devSeed'>): { asOf?: Date; fixtureReplay?: FixtureReplay } {
  return {
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
    ...(opts.devSeed === true ? { fixtureReplay: DEV_FIXTURE_REPLAY } : {}),
  };
}

/** Start listening. Resolves once the port is bound; returns a close() that stops everything. */
/** Loopback bind addresses: 127.0.0.0/8, ::1 (and its IPv4-mapped form), localhost. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/^::ffff:(?=\d)/, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m[1] === '127' && m.slice(2).every((o) => Number(o) <= 255);
}

export async function serve(opts: ServeOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const devMode = opts.devMode === true || opts.devSeed === true;
  const host = opts.host ?? '127.0.0.1';
  // Dev mode seeds users with a known password and a password-less role switcher: loopback only.
  if (devMode && !isLoopbackBindHost(host)) {
    throw new Error(`dev mode (--dev / --dev-seed) only binds to a loopback address (127.0.0.1, ::1, localhost); refusing --host ${host}`);
  }
  // Dev seed scans replay the 2018 fixtures: rescans of fixture-repo projects must use the same
  // reference date (today's date makes unchanged packages look newly abandoned), while other
  // projects scan with the real current date.
  const { app, deps, store, jobs } = createServer({ ...opts, devMode, ...serveScanDates(opts) });
  const log = deps.log;
  const interrupted = failInterruptedScans(store);
  if (interrupted > 0) log(`marked ${interrupted} interrupted scan(s) as failed`);
  deleteExpiredSessions(store);
  if (!devMode) {
    // Seeded dev users have a known password; outside dev mode they cannot sign in (see the
    // login route), and any session they still hold from a dev run is ended here.
    const devUsers = listDevUsers(store);
    let ended = 0;
    for (const u of devUsers) ended += deleteUserSessions(store, u.id);
    if (devUsers.length > 0) log(`${devUsers.length} seeded dev user(s) in this database cannot sign in outside --dev${ended ? ` (${ended} session(s) ended)` : ''}`);
  }
  if (devMode) {
    const seed = await seedDevData(deps);
    log(`dev mode: users ${seed.users.join(', ')} — password: ${seed.password}`);
    if (seed.scanId) log(`dev mode: queued fixture scan ${seed.scanId} for ${DEV_PROJECT_NAME}`);
  }
  if (deps.sources.github) log('sources: GitHub App connector configured (webhooks at /api/hooks/github)');
  if (!deps.config.webDir) log('web/dist not found: serving the API only (build the web app with `npm --prefix web run build`)');
  const port = opts.port ?? 8000;
  const server = await new Promise<ReturnType<typeof nodeServe>>((resolve, reject) => {
    const s = nodeServe({ fetch: app.fetch, port, hostname: host }, () => resolve(s));
    s.once('error', reject);
  });
  const addr = server.address() as AddressInfo | null;
  const shownHost = host.includes(':') ? `[${host}]` : host;
  const url = `http://${shownHost === '0.0.0.0' ? '127.0.0.1' : shownHost}:${addr?.port ?? port}`;
  log(`blastradius serve: listening on ${url}`);
  const sessionSweep = setInterval(() => deleteExpiredSessions(store), 15 * 60_000);
  sessionSweep.unref();
  // Knowledge-pack sweep: every BLASTRADIUS_WATCH_MINUTES (default 60) when a pack is configured.
  const watchMinutes = Number(process.env.BLASTRADIUS_WATCH_MINUTES ?? 60);
  if (deps.watcher.enabled && watchMinutes > 0) {
    deps.watcher.start(watchMinutes);
    log(`alerts: checking all projects against the knowledge pack every ${watchMinutes} min`);
  }
  // Account index: every stored inventory's packages, now and every BLASTRADIUS_ACCOUNT_REFRESH_MINUTES
  // (default 360; packuments younger than a day are not re-fetched, and the HttpClient rate-limits).
  const accountMinutes = Number(process.env.BLASTRADIUS_ACCOUNT_REFRESH_MINUTES ?? 360);
  if (accountMinutes > 0) deps.accounts.start(accountMinutes);
  return {
    url,
    close: async () => {
      clearInterval(sessionSweep);
      deps.watcher.stop();
      deps.accounts.stop();
      jobs.stop();
      await deps.sources.idle();
      await jobs.drain();
      await deps.accounts.idle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!opts.store) closeStore(store);
    },
  };
}
