/**
 * `blastradius serve`: open the store, wire the job runner, optionally seed dev data, and
 * listen with @hono/node-server. Default host is 127.0.0.1 (loopback only).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve as nodeServe } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { GitRunner } from '../ingest/git.js';
import type { ScanOptions } from '../pipeline.js';
import { createApp } from './app.js';
import type { ServerConfig, ServerDeps } from './context.js';
import { ScanJobs } from './jobs.js';
import { ConcurrencyGate, RateLimiter } from './ratelimit.js';
import { DEFAULT_WEB_DIR } from './static.js';
import {
  closeStore,
  createProject,
  deleteExpiredSessions,
  deleteUserSessions,
  enqueueScan,
  failInterruptedScans,
  latestSucceededScan,
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
  /** web/dist; null disables static serving. */
  webDir?: string | null;
  concurrency?: number;
  secureCookies?: ServerConfig['secureCookies'];
  /** Engine overrides (tests). */
  scanOptions?: Partial<ScanOptions>;
  gitRunner?: GitRunner;
  log?: (m: string) => void;
  /** Failed sign-in attempts per client address per 15 minutes (default 50). */
  loginIpRateLimit?: number;
  /** Scans per user per hour (default 60). */
  scanRateLimit?: number;
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
  };
  const jobs = new ScanJobs({
    store,
    localRoots: () => config.localRoots,
    offline: config.offline,
    ...(config.fixturesDir !== undefined ? { fixturesDir: config.fixturesDir } : {}),
    ...(opts.asOf ? { asOf: opts.asOf } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.scanOptions ? { scanOptions: opts.scanOptions } : {}),
    ...(opts.gitRunner ? { gitRunner: opts.gitRunner } : {}),
    log,
  });
  const deps: ServerDeps = {
    store,
    jobs,
    config,
    log,
    loginLimiter: new RateLimiter(10, 15 * 60_000),
    loginIpLimiter: new RateLimiter(opts.loginIpRateLimit ?? 50, 15 * 60_000),
    loginGate: new ConcurrencyGate(4, 32),
    scanLimiter: new RateLimiter(opts.scanRateLimit ?? 60, 60 * 60_000),
  };
  return { app: createApp(deps), deps, store, jobs, config };
}

export interface DevSeedOutcome {
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
  let scanId: string | null = null;
  if (!latestSucceededScan(store, project.id)) {
    const scan = enqueueScan(store, seeded.org.id, project.id, { requestedBy: admin.id, offline: true });
    jobs.setOverrides(scan.id, { offline: true, fixturesDir: FIXTURES_DIR, asOf: FIXTURE_AS_OF });
    jobs.kick();
    scanId = scan.id;
  }
  return { password: seeded.password, users: seeded.users.map((u) => u.email), projectId: project.id, scanId };
}

export interface ServeOptions extends CreateServerOptions {
  port?: number;
  host?: string;
  devSeed?: boolean;
}

/** Reference time for every scan: --as-of, else the fixture date under --dev-seed, else now. */
export function serveAsOf(opts: Pick<ServeOptions, 'asOf' | 'devSeed'>): Date | undefined {
  return opts.asOf ?? (opts.devSeed === true ? FIXTURE_AS_OF : undefined);
}

/** Start listening. Resolves once the port is bound; returns a close() that stops everything. */
export async function serve(opts: ServeOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const devMode = opts.devMode === true || opts.devSeed === true;
  // Dev seed scans replay the 2018 fixtures: rescans from the UI must use the same reference
  // date, or today's date makes unchanged packages look newly abandoned.
  const asOf = serveAsOf(opts);
  const { app, deps, store, jobs } = createServer({ ...opts, devMode, ...(asOf ? { asOf } : {}) });
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
  if (!deps.config.webDir) log('web/dist not found: serving the API only (build the web app with `npm --prefix web run build`)');
  const host = opts.host ?? '127.0.0.1';
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
  return {
    url,
    close: async () => {
      clearInterval(sessionSweep);
      jobs.stop();
      await jobs.drain();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!opts.store) closeStore(store);
    },
  };
}
