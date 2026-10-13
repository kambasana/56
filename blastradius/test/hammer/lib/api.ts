/**
 * Real `blastradius serve` processes for the hammer run. The admin user and org are created
 * through the store API (not --dev / --dev-seed), the server is the built dist/cli.js, and
 * every call goes over HTTP with the same CSRF header the web app sends.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { closeStore, createOrg, createUser, openStore } from '../../../src/server/store/index.js';
import { CLI, PKG_ROOT, readPeakRssMb, scrub } from './util.js';

export const ADMIN_EMAIL = 'hammer-admin@blastradius.test';

export interface AdminCreds {
  email: string;
  password: string;
}

/** Fresh SQLite DB with one real (non-dev) user who is Org admin of org "Hammer". */
export function createDb(dbPath: string, creds: AdminCreds): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const s = openStore({ path: dbPath });
  try {
    const u = createUser(s, { email: creds.email, name: 'Hammer Admin', password: creds.password });
    createOrg(s, { name: 'Hammer', slug: 'hammer' }, u.id);
  } finally {
    closeStore(s);
  }
}

export function newCreds(file: string): AdminCreds {
  const creds = { email: ADMIN_EMAIL, password: randomBytes(18).toString('base64url') };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return creds;
}

export class Server {
  url = '';
  log = '';
  peakRssMb: number | null = null;
  exit: { code: number | null; signal: string | null } | null = null;
  private child: ChildProcess | null = null;
  private poll: NodeJS.Timeout | null = null;

  constructor(
    readonly name: string,
    readonly dbPath: string,
    readonly opts: { asOf?: string; scanRoot: string; cacheDir: string; concurrency?: number; logFile?: string },
  ) {}

  get alive(): boolean {
    return this.child !== null && this.exit === null;
  }

  args(): string[] {
    return [CLI, 'serve', '--db', this.dbPath, '--port', '0', '--concurrency', String(this.opts.concurrency ?? 2), ...(this.opts.asOf ? ['--as-of', this.opts.asOf] : [])];
  }

  async start(timeoutMs = 60_000): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env, BLASTRADIUS_SCAN_ROOT: this.opts.scanRoot, BLASTRADIUS_CACHE_DIR: this.opts.cacheDir };
    delete env.BLASTRADIUS_OFFLINE;
    delete env.BLASTRADIUS_FIXTURES;
    const child = spawn(process.execPath, this.args(), { cwd: PKG_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.once('exit', (code, signal) => {
      this.exit = { code, signal };
      if (this.opts.logFile) appendFileSync(this.opts.logFile, `\n[hammer] server exited code=${code} signal=${signal}\n`);
    });
    this.poll = setInterval(() => {
      if (child.pid !== undefined) {
        const v = readPeakRssMb(child.pid);
        if (v !== null) this.peakRssMb = Math.max(this.peakRssMb ?? 0, v);
      }
    }, 250);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server ${this.name} did not start in ${timeoutMs}ms: ${this.log.slice(-500)}`)), timeoutMs);
      const onData = (d: Buffer) => {
        const s = scrub(d.toString('utf8'));
        if (this.log.length < 2_000_000) this.log += s;
        if (this.opts.logFile) appendFileSync(this.opts.logFile, s);
        const m = /listening on (http:\/\/[^\s]+)/.exec(this.log);
        if (m && !this.url) {
          this.url = m[1]!;
          clearTimeout(timer);
          resolve();
        }
      };
      child.stderr!.on('data', onData);
      child.stdout!.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (!this.url) reject(new Error(`server ${this.name} exited (${code}): ${this.log.slice(-800)}`));
      });
    });
  }

  /** Synchronous last-resort kill (process exit handler). */
  kill(): void {
    if (this.child && this.exit === null) this.child.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        c.kill('SIGKILL');
        resolve();
      }, 15_000);
      c.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      c.kill('SIGTERM');
    });
  }
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

export class ApiClient {
  private cookie = '';
  readonly transportErrors: { at: string; method: string; path: string; error: string; afterMs: number }[] = [];
  constructor(readonly base: string) {}

  async req<T = unknown>(method: string, p: string, body?: unknown, opts: { csrf?: boolean; auth?: boolean } = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.csrf !== false && method !== 'GET') headers['X-Requested-With'] = 'blastradius';
    if (opts.auth !== false && this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response | null = null;
    // GETs are retried on transport errors (each one is recorded); mutations never are.
    const attempts = method === 'GET' ? 4 : 1;
    let lastErr = '';
    for (let i = 0; i < attempts && !res; i++) {
      const t0 = Date.now();
      try {
        res = await fetch(this.base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        const err = e as Error & { cause?: { code?: string; message?: string } };
        lastErr = `${err.cause?.code ?? err.name}: ${err.cause?.message ?? err.message}`;
        this.transportErrors.push({ at: new Date().toISOString(), method, path: p.slice(0, 120), error: lastErr, afterMs: Date.now() - t0 });
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    if (!res) {
      const text = `request failed after ${attempts} attempt(s): ${lastErr}`;
      return { status: 0, body: text as unknown as T, text, headers: new Headers() };
    }
    const setCookie = res.headers.get('set-cookie');
    const m = setCookie ? /br_session=([^;]*)/.exec(setCookie) : null;
    if (m) this.cookie = `br_session=${m[1]}`;
    const text = await res.text();
    let parsed: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed as T, text, headers: res.headers };
  }

  async login(creds: AdminCreds): Promise<ApiResponse> {
    return this.req('POST', '/api/auth/login', creds);
  }
}

export interface ScanRow {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  commit: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  summary: { warnings: string[]; findings: number; counts: Record<string, number>; inventory: { components: number } } | null;
}

export async function waitForScan(api: ApiClient, scanId: string, timeoutMs: number, server?: Server): Promise<{ scan: ScanRow | null; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: ScanRow | null = null;
  while (Date.now() < deadline) {
    const r = await api.req<ScanRow>('GET', `/api/scans/${scanId}`);
    if (r.status !== 200) return { scan: last, error: `GET /api/scans/${scanId} -> ${r.status} ${r.text.slice(0, 200)}${server && !server.alive ? ` (server exited: ${JSON.stringify(server.exit)}; log tail: ${server.log.slice(-600)})` : ''}` };
    last = r.body;
    if (last.status === 'succeeded' || last.status === 'failed') return { scan: last };
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { scan: last, error: `timed out after ${timeoutMs}ms in status ${last?.status}` };
}
