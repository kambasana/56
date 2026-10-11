/**
 * Record the stability fixtures ONCE (needs network; never run in tests or CI):
 *   npx tsx test/stability/record.ts [--subjects] [--control]
 *
 * For the §8 subjects (subjects.ts) and every production npm dependency of the control
 * repositories (test/replay/data/org):
 *   - the npm packument (https://registry.npmjs.org/<name>), trimmed to what the stability inputs read:
 *     dist-tags, time, maintainers, repository and per version `_npmUser.name` / trusted publishing /
 *     `deprecated` (plus repository for the versions in use and the latest). The README is reduced
 *     to the declared status slimPackument derives from it. Registry e-mail addresses are dropped;
 *   - the source repository's history through the real P2 collector (src/history/git.ts: blobless
 *     bare clone, fixed-format git log) with a random salt that is discarded afterwards, plus the
 *     npm accounts whose registry e-mail address hashes to an id in that history (S5a link);
 *   - the deps.dev project (https://api.deps.dev/v3/projects/<id>), trimmed to the Scorecard result;
 *     the Scorecard API (https://api.securityscorecards.dev) when deps.dev has none.
 *
 * Output: test/fixtures/stability/recorded/subjects.json and history/<slug>.json (subjects), and
 * control.json.gz (control set). Clones go to a temporary directory, each deleted once read.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installEnvProxy } from '../../src/core/proxy.js';
import { repoFromManifestField } from '../../src/enrich/npm/repo.js';
import { packumentUrl } from '../../src/enrich/npm/registry.js';
import { normalizeRepoUrl } from '../../src/enrich/depsdev/repo.js';
import { ensureClone, readHistory } from '../../src/history/git.js';
import { localIdentity } from '../../src/history/identity.js';
import type { HistoryRecord } from '../../src/history/record.js';
import { declaredStatusOf } from '../../src/stability/declared.js';
import { productionComponents } from '../../src/stability/production.js';
import { scan } from '../../src/pipeline.js';
import { encodeFixture, type HistoryFixture } from '../history/fixture.js';
import { controlRepos, ORG_DIR, STABILITY_SUBJECTS } from './subjects.js';
import { STABILITY_DIR, type ControlFixture, type RecordedPackage } from './fixture.js';

await installEnvProxy();
const args = process.argv.slice(2);
const doSubjects = args.length === 0 || args.includes('--subjects');
const doControl = args.length === 0 || args.includes('--control');
const recordedAt = new Date();
const salt = randomBytes(32);
const cacheDir = mkdtempSync(join(process.env.BR_RECORD_TMP ?? tmpdir(), 'br-stability-'));
mkdirSync(join(STABILITY_DIR, 'history'), { recursive: true });

type Json = Record<string, any>;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

async function getJson(url: string): Promise<{ status: number; body?: Json }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'blastradius-recorder (stability fixtures)' } });
      if (res.status === 404) return { status: 404 };
      if (res.status === 200) return { status: 200, body: (await res.json()) as Json };
      if (res.status !== 429 && res.status < 500) return { status: res.status };
    } catch {
      // retried
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  return { status: 0 };
}

/** A repository field as the normalised https URL (+ directory) the enrichers derive from it; scp-style "git@host:" forms are dropped. */
function repositoryField(r: unknown): Json | undefined {
  const n = repoFromManifestField(r);
  return n ? { type: 'git', url: n.url, ...(n.directory ? { directory: n.directory } : {}) } : undefined;
}

/** Packument trimmed to the stability inputs; e-mails collected separately (memory only). */
function trimPackument(raw: Json, inUse: readonly string[]): { packument: Json; emails: Map<string, Set<string>> } {
  const emails = new Map<string, Set<string>>();
  const latest = typeof raw['dist-tags']?.latest === 'string' ? raw['dist-tags'].latest : undefined;
  const keepRepo = new Set([...inUse, ...(latest ? [latest] : [])]);
  const versions: Json = {};
  for (const [v, m] of Object.entries((raw.versions ?? {}) as Json)) {
    if (!m || typeof m !== 'object') continue;
    const out: Json = {};
    const u = m._npmUser;
    if (u && typeof u === 'object' && typeof u.name === 'string') {
      out._npmUser = { name: u.name, ...(u.trustedPublisher ? { trustedPublisher: u.trustedPublisher } : {}) };
      if (typeof u.email === 'string') {
        const s = emails.get(u.name) ?? new Set<string>();
        s.add(u.email);
        emails.set(u.name, s);
      }
    }
    // Deprecation messages are kept verbatim, except e-mail addresses (some messages name one).
    if (typeof m.deprecated === 'string' && m.deprecated) out.deprecated = m.deprecated.replace(EMAIL_RE, '<e-mail address removed>');
    if (keepRepo.has(v) && repositoryField(m.repository)) out.repository = repositoryField(m.repository);
    versions[v] = out;
  }
  const time: Json = {};
  for (const [k, t] of Object.entries((raw.time ?? {}) as Json)) if (k === 'created' || k === 'modified' || Object.hasOwn(versions, k)) time[k] = t;
  const packument: Json = {
    name: raw.name,
    'dist-tags': raw['dist-tags'] ?? {},
    time,
    maintainers: Array.isArray(raw.maintainers) ? raw.maintainers.map((x: Json) => ({ name: x?.name })).filter((x: Json) => typeof x.name === 'string') : [],
    repository: repositoryField(raw.repository),
    versions,
  };
  const declared = declaredStatusOf(raw.readme);
  if (declared) packument._declaredStatus = declared;
  return { packument, emails };
}

/** Source repository as packumentFacts derives it (version in use, then the package). */
function repoOf(p: Json, versions: readonly string[]): { url: string; directory?: string } | undefined {
  for (const v of versions) {
    const r = repoFromManifestField(p.versions?.[v]?.repository) ?? repoFromManifestField(p.repository);
    if (r) return r.directory ? { url: r.url, directory: r.directory } : { url: r.url };
  }
  const r = repoFromManifestField(p.repository);
  return r ? (r.directory ? { url: r.url, directory: r.directory } : { url: r.url }) : undefined;
}

/** The enricher's repository key (src/enrich/history/index.ts). */
function cloneKey(url: string): string | undefined {
  let u = url.replace(/\.git$/, '').replace(/\/+$/, '');
  if (u.startsWith('https://github.com/')) u = u.toLowerCase();
  return /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+$/.test(u) ? u : undefined;
}

async function recordHistory(url: string, emails: Map<string, Set<string>>): Promise<HistoryRecord | { error: string }> {
  const t0 = Date.now();
  try {
    const dir = await ensureClone(url, { dir: cacheDir, maxBytes: 300e6, timeoutMs: 600_000 });
    const rec = await readHistory(dir, { repo: url, salt, timeoutMs: 600_000 });
    rmSync(dir, { recursive: true, force: true });
    const ids = new Set<string>();
    for (const c of rec.commits) (ids.add(c.author), ids.add(c.committer));
    for (const t of rec.tags) ids.add(t.by);
    const links: Record<string, string> = {};
    for (const [name, set] of emails) {
      for (const e of set) {
        const id = localIdentity(e, salt);
        if (ids.has(id)) {
          links[name] = id;
          break;
        }
      }
    }
    rec.npmPublishers = links;
    console.log(`  history ${url}: ${rec.commits.length} commits, ${rec.tags.length} tags, ${Object.keys(links).length}/${emails.size} npm accounts matched, ${Date.now() - t0} ms`);
    return rec;
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0]!.slice(0, 200);
    console.log(`  history ${url}: not read (${msg})`);
    return { error: msg };
  }
}

async function recordProject(url: string): Promise<Json | undefined> {
  const n = normalizeRepoUrl(url);
  if (!n?.projectId) return undefined;
  const dd = await getJson(`https://api.deps.dev/v3/projects/${encodeURIComponent(n.projectId)}`);
  const sc = dd.body?.scorecard;
  if (sc) return { source: 'depsdev', projectKey: dd.body!.projectKey, scorecard: { date: sc.date, repository: { name: sc.repository?.name }, overallScore: sc.overallScore, checks: (sc.checks ?? []).filter((c: Json) => c?.name === 'Maintained').map((c: Json) => ({ name: c.name, score: c.score, reason: c.reason })) } };
  if (n.host !== 'github') return dd.status === 200 ? { source: 'depsdev', projectKey: dd.body!.projectKey } : undefined;
  const api = await getJson(`https://api.securityscorecards.dev/projects/github.com/${n.owner}/${n.name}`);
  if (api.body) return { source: 'scorecard', score: api.body.score, date: api.body.date, repo: { name: api.body.repo?.name }, checks: (api.body.checks ?? []).filter((c: Json) => c?.name === 'Maintained').map((c: Json) => ({ name: c.name, score: c.score, reason: c.reason })) };
  return dd.status === 200 ? { source: 'depsdev', projectKey: dd.body!.projectKey } : undefined;
}

async function recordPackage(name: string, versions: string[]): Promise<{ pkg: RecordedPackage; emails: Map<string, Set<string>> } | undefined> {
  const res = await getJson(packumentUrl(name));
  if (!res.body) {
    console.log(`  npm ${name}: ${res.status}`);
    return undefined;
  }
  const { packument, emails } = trimPackument(res.body, versions);
  const repo = repoOf(packument, versions);
  const pkg: RecordedPackage = { name, versions, packument };
  if (repo) pkg.repo = repo;
  return { pkg, emails };
}

try {
  if (doSubjects) {
    const out: { _note: string; recordedAt: string; packages: Record<string, RecordedPackage & { project?: Json; historyError?: string }> } = {
      _note: `Recorded live ${recordedAt.toISOString()} by test/stability/record.ts: npm packuments (trimmed, no e-mail addresses), deps.dev / Scorecard Maintained check. Histories in history/.`,
      recordedAt: recordedAt.toISOString(),
      packages: {},
    };
    for (const s of STABILITY_SUBJECTS) {
      console.log(s.slug);
      const r = await recordPackage(s.name, [s.version]);
      if (!r) continue;
      const entry: RecordedPackage & { project?: Json; historyError?: string } = r.pkg;
      if (r.pkg.repo) {
        const project = await recordProject(r.pkg.repo.url);
        if (project) entry.project = project;
      }
      if (s.history && 'record' in s.history) {
        const rec = await recordHistory(s.history.record, r.emails);
        if ('error' in rec) entry.historyError = rec.error;
        else writeFileSync(join(STABILITY_DIR, 'history', `${s.slug}.json`), `${JSON.stringify(encodeFixture(rec, `Recorded live ${recordedAt.toISOString()} by test/stability/record.ts from ${s.history.record}: ${s.note}. Emails hashed with a random salt that was discarded; npmPublishers maps npm accounts whose registry e-mail hashes to an id here.`, recordedAt))}\n`);
      }
      out.packages[s.slug] = entry;
    }
    writeFileSync(join(STABILITY_DIR, 'subjects.json'), `${JSON.stringify(out, null, 1)}\n`);
  }

  if (doControl) {
    const byName = new Map<string, Set<string>>();
    for (const d of controlRepos()) {
      const res = await scan({ target: join(ORG_DIR, d), formats: [], offline: true, cacheDir: false, enrichers: () => [] });
      const prod = productionComponents(res.inventory);
      for (const c of res.inventory.components) {
        if (c.ecosystem !== 'npm' || !prod.has(c.purl)) continue;
        const s = byName.get(c.name) ?? new Set<string>();
        s.add(c.version);
        byName.set(c.name, s);
      }
    }
    const fixture: ControlFixture = { _note: '', recordedAt: recordedAt.toISOString(), packages: {}, projects: {}, histories: {}, historyErrors: {} };
    const emailsByRepo = new Map<string, Map<string, Set<string>>>();
    const names = [...byName.keys()].sort();
    console.log(`control: ${names.length} production npm packages`);
    for (const name of names) {
      const r = await recordPackage(name, [...byName.get(name)!].sort());
      if (!r) continue;
      fixture.packages[name] = r.pkg;
      // Monorepo packages (repository.directory) share their repository's history, as in the enricher.
      const key = r.pkg.repo ? cloneKey(r.pkg.repo.url) : undefined;
      if (!key) continue;
      const m = emailsByRepo.get(key) ?? new Map<string, Set<string>>();
      for (const [n, set] of r.emails) m.set(n, new Set([...(m.get(n) ?? []), ...set]));
      emailsByRepo.set(key, m);
    }
    const repos = [...emailsByRepo.keys()].sort();
    console.log(`control: ${repos.length} repositories`);
    for (const url of repos) {
      const project = await recordProject(url);
      if (project) fixture.projects[url] = project;
      const rec = await recordHistory(url, emailsByRepo.get(url)!);
      if ('error' in rec) fixture.historyErrors[url] = rec.error;
      else {
        // Control histories are only used for labels: no time-zone months or GraphQL lookups, and
        // commit oids only where a tag points at them.
        const tagged = new Set(rec.tags.map((t) => t.commit));
        const slim: HistoryRecord = { ...rec, tzMonths: {}, lookup: [], commits: rec.commits.map((c) => ({ ...c, oid: tagged.has(c.oid) ? c.oid : '' })) };
        fixture.histories[url] = encodeFixture(slim, '', recordedAt) as HistoryFixture;
      }
    }
    fixture._note = `Recorded live ${recordedAt.toISOString()} by test/stability/record.ts: the production npm dependencies of the control repositories (test/replay/data/org), their trimmed packuments, deps.dev / Scorecard Maintained checks and pseudonymised histories (random salt, discarded).`;
    writeFileSync(join(STABILITY_DIR, 'control.json.gz'), gzipSync(JSON.stringify(fixture), { level: 9 }));
    console.log(`control: ${Object.keys(fixture.histories).length} histories, ${Object.keys(fixture.historyErrors).length} not read`);
  }
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}
