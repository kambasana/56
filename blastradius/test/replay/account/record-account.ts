/**
 * Record the account-level replay dataset ONCE (needs network; never run in tests or CI).
 *   tsx test/replay/account/record-account.ts --osv-dir <dir of OSV npm JSON> --cache <scratch dir>
 *
 * Writes test/replay/account/data/:
 *   org/<owner>__<repo>/      package.json + package-lock.json of real repos at pinned commits
 *                             (the 2025 exposure repos and the two hammer control repos)
 *   advisories.json           OSV records the proof uses, trimmed to id/published/package/versions
 *   timelines.json            per package: every version's publish time, publisher (_npmUser) and
 *                             maintainers, trimmed to the incident windows plus the last version
 *                             before each window. Versions npm deleted keep their time and are
 *                             marked `gone` (no publisher: it is not reconstructed here).
 *   locked.json               publisher and maintainers of every locked name@version (H3)
 *   accounts.json             each account's package list as npm returns it today (with the sample
 *                             rule applied), and why the account is in the dataset
 *   manifest.json             provenance: source URL and fetch time for every item
 *
 * Re-running reuses the per-package cache, so an interrupted recording resumes.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../../../src/pipeline.js';
import { DATA_DIR as REPLAY_DATA } from '../server.js';
import { encodeTimelines } from './timelines.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const osvDir = arg('--osv-dir');
const cache = arg('--cache');
if (!osvDir || !cache) throw new Error('--osv-dir <dir> and --cache <dir> are required');
mkdirSync(join(cache, 'pk'), { recursive: true });

/** Windows the proof queries (event-stream 2018; chalk/debug, Shai-Hulud and the control period 2025). */
const WINDOWS: [string, string][] = [
  ['2018-08-01T00:00:00Z', '2018-12-31T23:59:59Z'],
  ['2025-05-15T00:00:00Z', '2025-12-31T23:59:59Z'],
];
/** Re-apply the windows to an already trimmed timeline (the cache may hold wider windows). */
function retrim(tl: Timeline): Timeline {
  const keep = new Set<string>();
  for (const [from, to] of WINDOWS) {
    const f = Date.parse(from);
    const t = Date.parse(to);
    const before = tl.versions.filter((e) => Date.parse(e.t) < f).sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).pop();
    if (before) keep.add(before.v);
    for (const e of tl.versions) if (Date.parse(e.t) >= f && Date.parse(e.t) <= t) keep.add(e.v);
  }
  return { ...tl, versions: tl.versions.filter((e) => keep.has(e.v)) };
}
const SAMPLE_CAP = 1500;

/** 2025 exposure repos (GitHub code search for "chalk-5.6.1.tgz" in package-lock.json, taken in the order found) and the hammer controls. */
const REPOS = [
  { repo: 'amarpreetbhatia/api-generator', commit: '747bbd4855712c431357f26c102fe25eb31bdad7', role: 'exposure-2025' },
  { repo: 'lperry65/Aider-Chat', commit: 'b1d64b4d834e198bde3006d0447394bbcbe93fc7', role: 'exposure-2025' },
  { repo: 'ppnavillera/eclass-video-downloader', commit: '1afea024a672ce285443a989784c17efddd234ea', role: 'exposure-2025' },
  { repo: 'franRappazzini/spl-staking', commit: 'fff12b41703b07deeade95c27a282986bb87c42d', role: 'exposure-2025' },
  { repo: 'Antonia095/blog-front', commit: 'df0e8c0f4b7532af2c97a0169a3b19e74d44d007', role: 'exposure-2025' },
  { repo: 'microsoft/TypeScript', commit: 'de61e696214322f72d967bd17c58c50e44b2920d', role: 'control' },
  { repo: 'mochajs/mocha', commit: 'a9fc5296831641fbbcc8862e561e498549d840dc', role: 'control' },
];

const now = new Date().toISOString();
const provenance: Record<string, unknown>[] = [];
const writeJson = (rel: string, data: unknown) => {
  const p = join(DATA, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(data)}\n`);
};

// ---------------------------------------------------------------------------------------------
// 1. Repos at pinned commits.
for (const o of REPOS) {
  const out = join(DATA, 'org', o.repo.replace('/', '__'));
  if (!existsSync(join(out, 'package-lock.json'))) {
    const dir = mkdtempSync(join(tmpdir(), 'acct-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', `https://github.com/${o.repo}.git`, o.commit], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
      mkdirSync(out, { recursive: true });
      for (const f of ['package.json', 'package-lock.json']) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(out, f));
      const date = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%cI']).toString().trim();
      writeFileSync(join(out, 'commit.json'), `${JSON.stringify({ repo: o.repo, commit: o.commit, committedAt: date, fetchedAt: now })}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const c = JSON.parse(readFileSync(join(out, 'commit.json'), 'utf8'));
  provenance.push({ kind: 'repo', repo: o.repo, commit: o.commit, committedAt: c.committedAt, role: o.role, url: `https://github.com/${o.repo}/tree/${o.commit}`, files: ['package.json', 'package-lock.json'], fetchedAt: c.fetchedAt });
  console.log(`repo ${o.repo} (${o.role}) committed ${c.committedAt}`);
}

// Locked (name, version) per project, from the engine's own ingest (offline).
async function lockedOf(dir: string): Promise<{ name: string; version: string }[]> {
  const res = await scan({ target: dir, formats: [], offline: true, cacheDir: false, enrichers: () => [] });
  return res.inventory.components.filter((c) => c.ecosystem === 'npm').map((c) => ({ name: c.name, version: c.version }));
}
const projects: Record<string, { name: string; version: string }[]> = {};
for (const d of readdirSync(join(REPLAY_DATA, 'org')).sort()) projects[d.replace('__', '/')] = await lockedOf(join(REPLAY_DATA, 'org', d));
for (const o of REPOS) projects[o.repo] = await lockedOf(join(DATA, 'org', o.repo.replace('/', '__')));

// ---------------------------------------------------------------------------------------------
// 2. Advisories from the local OSV export.
interface Adv { id: string; published: string; name: string; versions: string[]; allVersions: boolean; group: string[] }
const SHAI = /shai[- _]?hulud/i;
const advs: Adv[] = [];
for (const f of readdirSync(osvDir)) {
  if (!f.endsWith('.json')) continue;
  const text = readFileSync(join(osvDir, f), 'utf8');
  const r = JSON.parse(text) as Record<string, any>;
  const p = String(r.published ?? '');
  const group: string[] = [];
  if (p >= '2025-09-08' && p < '2025-09-13') group.push('chalk-week');
  if (SHAI.test(text) && p >= '2025-09-14' && p < '2025-10-01') group.push('shai-hulud-1');
  if (SHAI.test(text) && p >= '2025-11-20' && p < '2025-12-06') group.push('shai-hulud-2');
  if (['GHSA-mh6f-8j2x-4483', 'GHSA-9x64-5r7x-2q53'].includes(r.id)) group.push('event-stream');
  if (!group.length || r.withdrawn) continue;
  for (const a of r.affected ?? []) {
    if (a.package?.ecosystem !== 'npm') continue;
    const all = (a.ranges ?? []).some((x: any) => (x.events ?? []).some((e: any) => e.introduced === '0') && !(x.events ?? []).some((e: any) => e.fixed || e.last_affected));
    advs.push({ id: r.id, published: p, name: a.package.name, versions: a.versions ?? [], allVersions: all, group });
  }
}
advs.sort((a, b) => a.published.localeCompare(b.published) || a.id.localeCompare(b.id));
writeJson('advisories.json', advs);
provenance.push({ kind: 'advisories', source: 'OSV npm export all.zip (https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip)', count: advs.length, fetchedAt: now, rule: 'published 2025-09-08..12 (chalk week); text /shai[- _]?hulud/i published 2025-09-14..30 (wave 1) or 2025-11-20..12-05 (wave 2); event-stream GHSAs; withdrawn skipped' });
console.log(`advisories: ${advs.length}`);

// ---------------------------------------------------------------------------------------------
// 3. Packuments (full documents, trimmed on arrival).
export interface VersionEntry { v: string; t: string; u?: string; m?: string[]; gone?: true }
export interface Timeline { name: string; fetchedAt: string; missing?: true; unpublished?: string; versions: VersionEntry[] }
const locked: Record<string, { u?: string; m?: string[]; gone?: true }> = {};
const wantLocked = new Map<string, Set<string>>();
for (const list of Object.values(projects)) for (const c of list) (wantLocked.get(c.name) ?? wantLocked.set(c.name, new Set()).get(c.name)!).add(c.version);

const enc = (n: string) => (n.startsWith('@') ? `@${encodeURIComponent(n.slice(1))}` : encodeURIComponent(n));
const cacheFile = (n: string) => join(cache, 'pk', `${n.replace('/', '__')}.json`);

function trim(name: string, raw: Record<string, any> | null): { tl: Timeline; lockedMeta: Record<string, { u?: string; m?: string[]; gone?: true }> } {
  if (!raw) return { tl: { name, fetchedAt: now, missing: true, versions: [] }, lockedMeta: {} };
  const time = (raw.time ?? {}) as Record<string, string>;
  const vers = (raw.versions ?? {}) as Record<string, any>;
  const entry = (v: string): VersionEntry => {
    const m = vers[v];
    if (!m) return { v, t: time[v]!, gone: true };
    const e: VersionEntry = { v, t: time[v]! };
    if (m._npmUser?.name) e.u = String(m._npmUser.name);
    if (Array.isArray(m.maintainers)) e.m = m.maintainers.map((x: any) => String(typeof x === 'string' ? x : x?.name)).sort();
    return e;
  };
  const all = Object.keys(time).filter((k) => k !== 'created' && k !== 'modified' && k !== 'unpublished' && !Number.isNaN(Date.parse(time[k]!)));
  all.sort((a, b) => Date.parse(time[a]!) - Date.parse(time[b]!));
  const keep = new Set<string>();
  for (const [from, to] of WINDOWS) {
    const f = Date.parse(from);
    const t = Date.parse(to);
    const before = all.filter((v) => Date.parse(time[v]!) < f).pop();
    if (before) keep.add(before);
    for (const v of all) if (Date.parse(time[v]!) >= f && Date.parse(time[v]!) <= t) keep.add(v);
  }
  const tl: Timeline = { name, fetchedAt: now, versions: all.filter((v) => keep.has(v)).map(entry) };
  if (time.unpublished) tl.unpublished = JSON.stringify(time.unpublished).slice(0, 200);
  const lockedMeta: Record<string, { u?: string; m?: string[]; gone?: true }> = {};
  for (const v of wantLocked.get(name) ?? []) {
    const e = vers[v] ? entry(v) : { v, t: '', gone: true as const };
    lockedMeta[`${name}@${v}`] = { ...(e.u ? { u: e.u } : {}), ...(e.m ? { m: e.m } : {}), ...(e.gone ? { gone: true as const } : {}) };
  }
  return { tl, lockedMeta };
}

async function fetchJson(url: string): Promise<any | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) void res.body?.cancel().catch(() => undefined); // an unread body holds the connection
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 7) throw new Error(`${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

async function packuments(names: string[]): Promise<void> {
  const todo = names.filter((n) => !existsSync(cacheFile(n)));
  let done = 0;
  const pool = Array.from({ length: 16 }, async () => {
    while (todo.length) {
      const n = todo.pop()!;
      const raw = await fetchJson(`https://registry.npmjs.org/${enc(n)}`);
      writeFileSync(cacheFile(n), JSON.stringify(trim(n, raw)));
      if (++done % 200 === 0) console.log(`  packuments ${done}`);
    }
  });
  await Promise.all(pool);
}
const loadCached = (n: string) => JSON.parse(readFileSync(cacheFile(n), 'utf8')) as { tl: Timeline; lockedMeta: typeof locked };

const incidentNames = new Set([...advs.map((a) => a.name), 'event-stream', 'flatmap-stream']);
const inventoryNames = new Set([...wantLocked.keys()]);
await packuments([...new Set([...incidentNames, ...inventoryNames])].sort());
console.log(`packuments for inventories and incidents: ${incidentNames.size + inventoryNames.size}`);
for (const n of inventoryNames) Object.assign(locked, loadCached(n).lockedMeta);

// ---------------------------------------------------------------------------------------------
// 4. Accounts: incident accounts, control accounts; their current package lists.
const timelines = new Map<string, Timeline>();
for (const n of [...incidentNames, ...inventoryNames]) timelines.set(n, loadCached(n).tl);

/** Publisher of a version: _npmUser, or the sole maintainer of the previous version (attribution). */
function publisherOf(tl: Timeline, v: string): string | undefined {
  const i = tl.versions.findIndex((e) => e.v === v);
  if (i < 0) return undefined;
  if (tl.versions[i]!.u) return tl.versions[i]!.u;
  const prev = tl.versions.slice(0, i).reverse().find((e) => e.m);
  return prev?.m?.length === 1 ? prev.m[0] : undefined;
}
const incidentAccounts = new Map<string, string>([['qix', 'chalk-debug-2025'], ['right9ctrl', 'event-stream-2018']]);
for (const a of advs.filter((x) => x.group.some((g) => g.startsWith('shai-hulud')))) {
  const tl = timelines.get(a.name);
  for (const v of a.versions) {
    const u = tl ? publisherOf(tl, v) : undefined;
    if (u && !incidentAccounts.has(u)) incidentAccounts.set(u, a.group.find((g) => g.startsWith('shai'))!);
  }
}
// Control accounts: top 10 publishers of locked packages across the control repos, plus named ones.
const ctrlCount = new Map<string, number>();
for (const o of REPOS.filter((r) => r.role === 'control'))
  for (const c of projects[o.repo]!) {
    const u = locked[`${c.name}@${c.version}`]?.u;
    if (u) ctrlCount.set(u, (ctrlCount.get(u) ?? 0) + 1);
  }
const controls = new Map<string, string>();
for (const [u] of [...ctrlCount].filter(([u]) => !incidentAccounts.has(u)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)) controls.set(u, 'top-10 publisher in control repos');
for (const u of ['sindresorhus', 'ljharb', 'isaacs', 'types']) if (!controls.has(u)) controls.set(u, 'named control');
await packuments(['@babel/core', '@aws-sdk/client-s3']);
for (const n of ['@babel/core', '@aws-sdk/client-s3']) {
  const tl = loadCached(n).tl;
  timelines.set(n, tl);
  const last = tl.versions.filter((e) => e.t >= '2025-06-01' && e.t <= '2025-12-31T23:59:59Z' && e.u).pop();
  if (last?.u && !controls.has(last.u) && !incidentAccounts.has(last.u)) controls.set(last.u, `monorepo release account (${n})`);
}

const accounts: Record<string, { role: string; reason: string; packages: string[]; total: number; sampled: boolean; fetchedAt: string; url: string }> = {};
console.log(`incident accounts: ${incidentAccounts.size}; control accounts: ${controls.size}`);
mkdirSync(join(cache, 'users'), { recursive: true });
/**
 * The account's current package list: /-/user/<u>/package, or, when that endpoint keeps answering
 * 429, the registry search `maintainer:<u>` (paginated). The source used is recorded per account.
 */
/** GET with curl and a hard timeout (Node's fetch sometimes never settled on 429s through the proxy). */
function curlGet(url: string): { status: number; body: string } {
  try {
    const out = execFileSync('curl', ['-sS', '-m', '40', '-w', '\n%{http_code}', url], { maxBuffer: 64 << 20 }).toString();
    const i = out.lastIndexOf('\n');
    return { status: Number(out.slice(i + 1)), body: out.slice(0, i) };
  } catch {
    return { status: 0, body: '' };
  }
}
async function userPackages(u: string): Promise<{ url: string; names: string[] }> {
  const url = `https://registry.npmjs.org/-/user/${encodeURIComponent(u)}/package`;
  const res = curlGet(url);
  if (res.status === 200) return { url, names: Object.keys(JSON.parse(res.body) as Record<string, string>) };
  if (res.status === 404) return { url, names: [] };
  const names: string[] = [];
  const surl = `https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(u)}&size=250`;
  for (let from = 0; ; from += 250) {
    console.log(`    search ${u} from ${from}`);
    let r = curlGet(`${surl}&from=${from}`);
    for (let i = 0; r.status !== 200 && i < 5; i++) {
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** i));
      r = curlGet(`${surl}&from=${from}`);
    }
    if (r.status !== 200) throw new Error(`search ${u}: HTTP ${r.status}`);
    const page = JSON.parse(r.body) as { objects: { package: { name: string; maintainers?: { username: string }[] } }[]; total: number };
    // The search matches loosely; keep only packages that list the account as a maintainer.
    for (const o of page.objects) if (!o.package.maintainers || o.package.maintainers.some((m) => m.username === u)) names.push(o.package.name);
    if (from + 250 >= page.total || page.objects.length === 0 || from >= 5000) break;
  }
  return { url: surl, names };
}
for (const [u, why] of [...incidentAccounts.entries(), ...controls.entries()]) {
  const uf = join(cache, 'users', `${encodeURIComponent(u)}.json`);
  if (!existsSync(uf)) {
    console.log(`  account list ${u}`);
    writeFileSync(uf, JSON.stringify(await userPackages(u)));
  }
  const cached = JSON.parse(readFileSync(uf, 'utf8')) as { url?: string; names?: string[] } | Record<string, string> | null;
  const isNew = !!cached && Array.isArray((cached as { names?: unknown }).names);
  const names = [...new Set(isNew ? (cached as { names: string[] }).names : Object.keys(cached ?? {}))].sort();
  const url = isNew ? String((cached as { url: string }).url) : `https://registry.npmjs.org/-/user/${u}/package`;
  const sampled = names.length > SAMPLE_CAP;
  accounts[u] = { role: incidentAccounts.has(u) ? 'incident' : 'control', reason: why, packages: sampled ? names.slice(0, SAMPLE_CAP) : names, total: names.length, sampled, fetchedAt: now, url };
}
const listNames = [...new Set(Object.values(accounts).flatMap((a) => a.packages))].sort();
console.log(`accounts: ${Object.keys(accounts).length}; their packages: ${listNames.length}`);
await packuments(listNames);
for (const n of listNames) timelines.set(n, loadCached(n).tl);

// ---------------------------------------------------------------------------------------------
// 5. Write.
const sortedTl = [...timelines.values()].map(retrim).sort((a, b) => a.name.localeCompare(b.name));
writeJson('timelines.json', encodeTimelines(sortedTl));
writeJson('locked.json', Object.fromEntries(Object.entries(locked).sort(([a], [b]) => a.localeCompare(b))));
writeJson('accounts.json', accounts);
provenance.push({ kind: 'packuments', source: 'https://registry.npmjs.org/<name> (full document)', count: sortedTl.length, fetchedAt: now, trimmed: `versions in ${WINDOWS.map((w) => w.join('..')).join(' and ')} plus the last version before each window; only time, _npmUser.name, maintainers names; deleted versions keep time and are marked gone` });
provenance.push({ kind: 'locked', source: 'versions[<locked version>] of the same packuments', count: Object.keys(locked).length, fetchedAt: now });
provenance.push({ kind: 'accounts', source: 'https://registry.npmjs.org/-/user/<account>/package (current, not historical)', count: Object.keys(accounts).length, fetchedAt: now, sampleCap: SAMPLE_CAP });
writeFileSync(join(DATA, 'manifest.json'), `${JSON.stringify({ recordedAt: now, licences: { registry: 'npm public registry metadata', advisories: 'OSV (CC-BY-4.0 / per source)', repos: 'each repo under its own licence; only lockfiles and package.json are kept' }, items: provenance }, null, 1)}\n`);
console.log(`timelines ${sortedTl.length}, locked ${Object.keys(locked).length}`);
