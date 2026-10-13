/**
 * Hammer global setup (runs once, before any worker):
 *  1. wait for the live server, sign in as the admin the scenario runner used;
 *  2. create one AppSec, one Developer and one Auditor account through the real invite API
 *     (POST /api/members: a one-time password in dev mode, an invite link to accept otherwise);
 *  3. save a signed-in storage state per role (out/auth/, git-ignored);
 *  4. list the projects on the server and match them to the scenarios;
 *  5. probe which data-source hosts this container can reach, so dependent assertions can be
 *     reported as "blocked: <host>" instead of passing or failing silently.
 *
 * Secrets: passwords live only in out/auth/users.json (mode 0600, git-ignored). Nothing here
 * prints a password, a session cookie or a token.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { request, type APIRequestContext } from '@playwright/test';
import {
  AUTH_DIR,
  BASE_URL,
  ROLE_IDS,
  OUT_DIR,
  RESULTS_DIR,
  RESULTS_ROOT,
  SERVER,
  SERVER_AS_OF,
  STATE_FILE,
  ensureDirs,
  loadScenarios,
  type HammerProject,
  type HammerState,
  type HammerUser,
  type Role,
  type Scenario,
  webBuildMtimeMs,
} from './lib/env';

const run = promisify(execFile);
const XRW = { 'X-Requested-With': 'blastradius' };

/** Hosts the scenarios depend on. Probed with curl so the container's proxy policy applies. */
const SOURCE_PROBES: Record<string, string> = {
  'github.com': 'https://github.com/',
  'registry.npmjs.org': 'https://registry.npmjs.org/',
  'api.osv.dev': 'https://api.osv.dev/v1/query',
  'api.deps.dev': 'https://api.deps.dev/v3/systems/npm/packages/react',
  'api.securityscorecards.dev': 'https://api.securityscorecards.dev/',
  // A repository lookup (what the engine does); a proxy may answer / and /rate_limit but refuse repos (403).
  'api.github.com': 'https://api.github.com/repos/npm/cli',
};

async function probe(url: string): Promise<boolean> {
  try {
    const { stdout } = await run('curl', ['-s', '-o', '/dev/null', '-m', '12', '-w', '%{http_code}', url], { timeout: 20_000 });
    const code = Number(stdout.trim());
    // 000: no connection; 403/407 from the egress proxy: denied by policy.
    return code > 0 && code !== 407 && code !== 403;
  } catch {
    return false;
  }
}

function adminCredentials(): { email: string; password: string } {
  // The scenario runner writes {email, password} (mode 0600) and lists the file in its results.
  if (process.env.HAMMER_ADMIN_FILE) {
    const c = JSON.parse(readFileSync(process.env.HAMMER_ADMIN_FILE, 'utf8')) as { email?: string; password?: string };
    if (c.email && c.password) return { email: c.email, password: c.password };
  }
  const email = process.env.HAMMER_ADMIN_EMAIL;
  let password = process.env.HAMMER_ADMIN_PASSWORD;
  if (!password && process.env.HAMMER_ADMIN_PASSWORD_FILE) password = readFileSync(process.env.HAMMER_ADMIN_PASSWORD_FILE, 'utf8').trim();
  if (!email || !password) throw new Error('Set HAMMER_ADMIN_FILE, or HAMMER_ADMIN_EMAIL with HAMMER_ADMIN_PASSWORD / HAMMER_ADMIN_PASSWORD_FILE, for the populated server.');
  return { email, password };
}

async function signIn(email: string, password: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: XRW });
  const res = await ctx.post('/api/auth/login', { data: { email, password } });
  if (!res.ok()) throw new Error(`Sign-in for ${email} failed: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
  return ctx;
}

async function json<T>(ctx: APIRequestContext, path: string): Promise<T> {
  const res = await ctx.get(path);
  if (!res.ok()) throw new Error(`GET ${path}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

function matchScenario(p: { name: string; target: string }, scenarios: Scenario[]): string | null {
  const t = p.target.toLowerCase();
  const n = p.name.toLowerCase();
  for (const s of scenarios) if (n === s.id.toLowerCase()) return s.id;
  for (const s of scenarios) {
    const repo = s.repo.toLowerCase();
    const variants = [repo, repo.replace('/', '__'), repo.replace('/', '-'), repo.replace('/', '_')];
    if (t.includes(s.id.toLowerCase()) || n.includes(s.id.toLowerCase())) return s.id;
    if (variants.some((v) => t.includes(v)) && (t.includes(s.commit.slice(0, 7)) || !scenarios.some((o) => o !== s && o.repo.toLowerCase() === repo))) return s.id;
  }
  return null;
}

export default async function globalSetup(): Promise<void> {
  ensureDirs();
  // A plain run starts a fresh report; run-all.mjs keeps the other servers' results.
  if (process.env.HAMMER_KEEP_RESULTS === '1') rmSync(RESULTS_DIR, { recursive: true, force: true });
  else {
    rmSync(RESULTS_ROOT, { recursive: true, force: true });
    for (const f of readdirSync(OUT_DIR)) if (/^state-.*\.json$/.test(f)) rmSync(join(OUT_DIR, f), { force: true });
  }
  ensureDirs();

  // 1. Server up.
  const anon = await request.newContext({ baseURL: BASE_URL });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ok = await anon
      .get('/api/health')
      .then((r) => r.ok())
      .catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`${BASE_URL}/api/health did not answer within 60 s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await anon.dispose();

  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const cred = adminCredentials();
  const admin = await signIn(cred.email, cred.password);
  const me = await json<{ user: { id: string }; org: { id: string; name: string } | null; devMode: boolean }>(admin, '/api/me');
  if (!me.org) throw new Error('The admin has no organization: populate the server first.');
  await admin.storageState({ path: join(AUTH_DIR, 'admin.json') });

  const users: HammerUser[] = [{ role: 'admin', email: cred.email, password: cred.password, userId: me.user.id, storageState: join(AUTH_DIR, 'admin.json'), via: 'admin' }];

  // 2-3. One account per non-admin role, through the real invite API.
  for (const role of ['appsec', 'developer', 'auditor'] as Role[]) {
    const email = `hammer-${role}-${runId}@hammer.test`;
    const res = await admin.post('/api/members', {
      data: { email, name: `Hammer ${role[0]!.toUpperCase()}${role.slice(1)}`, bindings: [{ roleId: ROLE_IDS[role], scope: { kind: 'org' } }] },
    });
    if (res.status() !== 201) throw new Error(`Invite ${role}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { member?: { id: string }; oneTimePassword?: string; invite?: { token: string } };
    let ctx: APIRequestContext;
    let password: string;
    let via: HammerUser['via'];
    let userId: string;
    if (body.oneTimePassword && body.member) {
      password = body.oneTimePassword;
      via = 'invite-otp';
      ctx = await signIn(email, password);
      userId = body.member.id;
    } else if (body.invite) {
      password = randomBytes(18).toString('base64url');
      via = 'invite-link';
      ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: XRW });
      const acc = await ctx.post('/api/auth/accept-invite', { data: { token: body.invite.token, password } });
      if (!acc.ok()) throw new Error(`Accept invite ${role}: HTTP ${acc.status()}`);
      userId = ((await acc.json()) as { user: { id: string } }).user.id;
    } else {
      throw new Error(`Invite ${role}: response had neither a one-time password nor an invite`);
    }
    const path = join(AUTH_DIR, `${role}.json`);
    await ctx.storageState({ path });
    await ctx.dispose();
    users.push({ role, email, password, userId, storageState: path, via });
  }
  const usersFile = join(AUTH_DIR, 'users.json');
  writeFileSync(usersFile, JSON.stringify(users, null, 2), { mode: 0o600 });
  chmodSync(usersFile, 0o600);

  // 4. Projects and scenarios.
  const scenarios = loadScenarios();
  const list = await json<{ items: { id: string; name: string; target: string; lastScan: { status: string } | null; counts: Record<string, number> }[] }>(admin, '/api/projects?limit=500');
  const projects: HammerProject[] = [];
  for (const p of list.items) {
    const counts = p.counts ?? {};
    const top = await json<{ items: { id: string; purl: string }[] }>(admin, `/api/findings?project=${encodeURIComponent(p.id)}&limit=1&sort=-score`).catch(() => ({ items: [] }));
    projects.push({
      id: p.id,
      name: p.name,
      target: p.target,
      scenarioId: matchScenario(p, scenarios),
      lastScanStatus: p.lastScan?.status ?? null,
      findings: Object.values(counts).reduce((a, b) => a + b, 0),
      critical: counts.critical ?? 0,
      topFindingId: top.items[0]?.id ?? null,
      topFindingPurl: top.items[0]?.purl ?? null,
    });
  }
  const scenarioProjects: Record<string, string | null> = {};
  for (const s of scenarios) scenarioProjects[s.id] = projects.find((p) => p.scenarioId === s.id)?.id ?? null;

  // 5. Sources.
  const sources: Record<string, boolean> = {};
  await Promise.all(
    Object.entries(SOURCE_PROBES).map(async ([host, url]) => {
      sources[host] = await probe(url);
    }),
  );

  const state: HammerState = {
    server: SERVER,
    asOf: SERVER_AS_OF,
    startedAt: new Date().toISOString(),
    runId,
    baseURL: BASE_URL,
    devMode: me.devMode,
    orgId: me.org.id,
    orgName: me.org.name,
    projects,
    scenarioProjects,
    sources,
    users: users.map(({ password: _p, ...u }) => u),
    webBuildMtimeMs: webBuildMtimeMs(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  await admin.dispose();
  if (!existsSync(STATE_FILE)) throw new Error('state not written');
}
