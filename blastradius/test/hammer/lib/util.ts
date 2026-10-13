/**
 * Hammer harness utilities: process runner with peak-memory sampling, data-source preflight,
 * token loading and the assertion ledger. Real network, real processes; nothing is mocked.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HAMMER_ROOT = path.resolve(import.meta.dirname, '..');
export const PKG_ROOT = path.resolve(HAMMER_ROOT, '..', '..');
export const REPO_ROOT = path.resolve(PKG_ROOT, '..');
export const CLI = path.join(PKG_ROOT, 'dist', 'cli.js');

export function hammerDir(): string {
  const env = process.env.BLASTRADIUS_HAMMER_DIR;
  if (env && env.trim()) return path.resolve(env);
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'blastradius-hammer');
}

// ---------------------------------------------------------------------------------------------
// Secrets: the token only ever lives in process.env and is scrubbed from anything we persist.
// ---------------------------------------------------------------------------------------------

let secretValues: string[] = [];

export type TokenSource = 'file' | 'env' | 'env-rejected' | 'file-rejected' | 'none';

export function loadGithubToken(): TokenSource {
  const file = path.join(REPO_ROOT, 'secrets', 'github-token.txt');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) {
      process.env.GITHUB_TOKEN = t;
      secretValues.push(t);
      return 'file';
    }
  }
  const env = process.env.GITHUB_TOKEN;
  if (env && env.trim()) {
    secretValues.push(env.trim());
    return 'env';
  }
  return 'none';
}

/** Remove any secret value from text before it is printed or written. */
export function scrub(text: string): string {
  let out = text;
  for (const s of secretValues) if (s.length >= 8) out = out.split(s).join('***');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

export interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  peakRssMb: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Peak resident set (VmHWM) of a live Linux process, in MB; null when unavailable. */
export function readPeakRssMb(pid: number): number | null {
  try {
    const m = /VmHWM:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

const CAP = 4 * 1024 * 1024;

export function runProc(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd ?? PKG_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let peak: number | null = null;
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < CAP) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString('utf8');
    });
    const sample = () => {
      if (child.pid === undefined) return;
      const v = readPeakRssMb(child.pid);
      if (v !== null) peak = Math.max(peak ?? 0, v);
    };
    const poll = setInterval(sample, 200);
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (e) => {
      stderr += `\nspawn error: ${e.message}`;
    });
    child.on('close', (code, signal) => {
      clearInterval(poll);
      clearTimeout(killer);
      resolve({ code, signal, ms: Date.now() - t0, peakRssMb: peak, stdout: scrub(stdout), stderr: scrub(stderr), timedOut });
    });
  });
}

export function git(args: string[], cwd: string, timeoutMs = 300_000): Promise<{ ok: boolean; out: string; err: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GITHUB_TOKEN;
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', ...args],
      { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout), err: scrub(String(stderr || (err ? err.message : ''))) }),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------------------------

export type SourceState = 'ok' | 'blocked' | 'error';
export interface SourceProbe {
  host: string;
  state: SourceState;
  status?: number;
  detail: string;
  ms: number;
}

export const SOURCE_HOSTS = [
  'github.com',
  'registry.npmjs.org',
  'raw.githubusercontent.com',
  'api.osv.dev',
  'api.deps.dev',
  'api.securityscorecards.dev',
  'api.github.com',
  'api.opencollective.com',
] as const;

/** Pseudo-source: GitHub API calls without a working token (60 requests/hour per address). */
export const GITHUB_RATE = 'api.github.com (rate limit: no working token)';

async function httpProbe(host: string, url: string, init: RequestInit = {}): Promise<SourceProbe> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const deny = res.headers.get('x-deny-reason');
    const body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
    const ms = Date.now() - t0;
    if (deny || (res.status === 403 && /not in allowlist|egress/i.test(body))) {
      return { host, state: 'blocked', status: res.status, detail: `egress proxy: ${deny ?? body}`, ms };
    }
    if (res.ok || res.status === 404) return { host, state: 'ok', status: res.status, detail: `HTTP ${res.status}`, ms };
    return { host, state: 'error', status: res.status, detail: `HTTP ${res.status}: ${body.slice(0, 120)}`, ms };
  } catch (e) {
    // Walk the cause chain: through an egress proxy the root cause is e.g. "Proxy response (403) !== 200".
    const parts: string[] = [];
    for (let c: unknown = e, i = 0; c && i < 5; c = (c as { cause?: unknown }).cause, i++) {
      const x = c as { code?: unknown; message?: unknown };
      const bit = [typeof x.code === 'string' ? x.code : '', typeof x.message === 'string' ? x.message : ''].filter(Boolean).join(' ');
      if (bit && !parts.includes(bit)) parts.push(bit);
    }
    return { host, state: 'blocked', detail: `network error: ${parts.join(' <- ').slice(0, 200)}`, ms: Date.now() - t0 };
  }
}

export interface Preflight {
  sources: SourceProbe[];
  token: { source: TokenSource; authenticated: boolean | null; coreLimit: number | null; coreRemaining: number | null };
}

export async function preflight(tokenSource: TokenSource): Promise<Preflight> {
  const t0 = Date.now();
  const gh = await git(['ls-remote', '--', 'https://github.com/npm/cli', 'HEAD'], os.tmpdir(), 60_000);
  const githubProbe: SourceProbe = gh.ok
    ? { host: 'github.com', state: 'ok', detail: `git ls-remote OK (${gh.out.slice(0, 12)}…)`, ms: Date.now() - t0 }
    : { host: 'github.com', state: 'blocked', detail: `git ls-remote failed: ${gh.err.slice(0, 160)}`, ms: Date.now() - t0 };
  const ghHeaders: Record<string, string> = { 'User-Agent': 'blastradius-hammer', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const [npm, raw, osv, depsdev, scorecard, ghapiFirst, oc] = await Promise.all([
    httpProbe('registry.npmjs.org', 'https://registry.npmjs.org/event-stream'),
    httpProbe('raw.githubusercontent.com', 'https://raw.githubusercontent.com/npm/cli/latest/package.json'),
    httpProbe('api.osv.dev', 'https://api.osv.dev/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: { name: 'event-stream', ecosystem: 'npm' }, version: '3.3.6' }),
    }),
    httpProbe('api.deps.dev', 'https://api.deps.dev/v3/systems/npm/packages/event-stream'),
    httpProbe('api.securityscorecards.dev', 'https://api.securityscorecards.dev/projects/github.com/npm/cli'),
    httpProbe('api.github.com', 'https://api.github.com/rate_limit', { headers: ghHeaders }),
    httpProbe('api.opencollective.com', 'https://api.opencollective.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    }),
  ]);
  let ghapi = ghapiFirst;
  if (ghapi.status === 401 && ghHeaders.Authorization) {
    // The token does not authenticate from Node (e.g. a placeholder only an egress proxy rewrites).
    // Drop it so the engine runs unauthenticated instead of failing every GitHub call, and say so.
    delete ghHeaders.Authorization;
    delete process.env.GITHUB_TOKEN;
    tokenSource = tokenSource === 'file' ? 'file-rejected' : 'env-rejected';
    ghapi = await httpProbe('api.github.com', 'https://api.github.com/rate_limit', { headers: ghHeaders });
    ghapi.detail = `token rejected (401), dropped; unauthenticated: ${ghapi.detail}`;
  }
  // /rate_limit answering is not enough: the engine reads /repos/{owner}/{repo}. An egress proxy may hold
  // a session-scoped credential that answers /rate_limit but refuses repositories it was not granted
  // (403 "not enabled for this session"). Probe a real repository lookup, the request the engine makes.
  if (ghapi.state === 'ok') {
    const t1 = Date.now();
    try {
      const res = await fetch('https://api.github.com/repos/npm/cli', { headers: ghHeaders, signal: AbortSignal.timeout(20_000) });
      const body = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (res.status === 401 || ((res.status === 403 || res.status === 429) && remaining !== '0')) {
        ghapi = { host: 'api.github.com', state: 'blocked', status: res.status, detail: `/rate_limit OK but repository lookups refused: GET /repos/npm/cli -> HTTP ${res.status}: ${body.slice(0, 140)}`, ms: Date.now() - t1 };
      } else if (!res.ok && res.status !== 403 && res.status !== 429) {
        ghapi = { host: 'api.github.com', state: 'error', status: res.status, detail: `GET /repos/npm/cli -> HTTP ${res.status}: ${body.slice(0, 140)}`, ms: Date.now() - t1 };
      } else {
        ghapi.detail += `; GET /repos/npm/cli -> HTTP ${res.status}${remaining === '0' ? ' (rate limit exhausted)' : ''}`;
      }
    } catch (e) {
      ghapi = { host: 'api.github.com', state: 'blocked', detail: `GET /repos/npm/cli failed: ${(e as Error).message}`, ms: Date.now() - t1 };
    }
  }
  let token: Preflight['token'] = { source: tokenSource, authenticated: null, coreLimit: null, coreRemaining: null };
  if (ghapi.state === 'ok' || ghapi.status === 403 || ghapi.status === 401) {
    try {
      const res = await fetch('https://api.github.com/rate_limit', { headers: ghHeaders, signal: AbortSignal.timeout(20_000) });
      const j = (await res.json()) as { resources?: { core?: { limit?: number; remaining?: number } } };
      const limit = j.resources?.core?.limit ?? null;
      token = { source: tokenSource, authenticated: limit !== null ? limit > 60 : null, coreLimit: limit, coreRemaining: j.resources?.core?.remaining ?? null };
    } catch {
      /* reported via ghapi */
    }
  }
  return { sources: [githubProbe, npm, raw, osv, depsdev, scorecard, ghapi, oc], token };
}

// ---------------------------------------------------------------------------------------------
// Assertion ledger
// ---------------------------------------------------------------------------------------------

export type Status = 'pass' | 'fail' | 'blocked' | 'skip';
export interface Assertion {
  scope: string; // scenario id or probe id
  id: string;
  title: string;
  status: Status;
  detail: string;
  /** Hosts whose data the verdict depends on. */
  needs: string[];
  blockedBy?: string[];
}

export class Ledger {
  readonly items: Assertion[] = [];
  constructor(private readonly blockedHosts: Set<string>) {}

  /** Mark an extra (pseudo-)source as unavailable, e.g. the GitHub rate limit without a token. */
  block(host: string): void {
    this.blockedHosts.add(host);
  }

  /** A failing check always fails. A passing check whose data depends on a blocked host is "blocked", not passed. */
  check(scope: string, id: string, title: string, ok: boolean, detail: string, needs: string[] = []): boolean {
    const blockedBy = needs.filter((h) => this.blockedHosts.has(h));
    const status: Status = !ok ? 'fail' : blockedBy.length > 0 ? 'blocked' : 'pass';
    const a: Assertion = { scope, id, title, status, detail: scrub(detail), needs };
    if (blockedBy.length > 0) a.blockedBy = blockedBy;
    this.items.push(a);
    const tag = status === 'pass' ? 'PASS   ' : status === 'fail' ? 'FAIL   ' : `BLOCKED`;
    const extra = status === 'blocked' ? ` (blocked: ${blockedBy.join(', ')})` : '';
    process.stdout.write(`  ${tag} ${scope} :: ${title}${extra}${status === 'fail' ? `\n          ${a.detail.slice(0, 600)}` : ''}\n`);
    return ok;
  }

  skip(scope: string, id: string, title: string, detail: string): void {
    this.items.push({ scope, id, title, status: 'skip', detail, needs: [] });
    process.stdout.write(`  SKIP    ${scope} :: ${title} (${detail})\n`);
  }

  counts(): Record<Status, number> {
    const c: Record<Status, number> = { pass: 0, fail: 0, blocked: 0, skip: 0 };
    for (const a of this.items) c[a.status]++;
    return c;
  }
}
