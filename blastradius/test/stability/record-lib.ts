/**
 * Helpers shared by the stability fixture recorders (record.ts, record-tier0.ts). Network only;
 * never imported by tests.
 */
import { tarballFootprint } from '../../src/enrich/npm/tarball.js';
import { repoFromManifestField } from '../../src/enrich/npm/repo.js';
import { packumentUrl } from '../../src/enrich/npm/registry.js';
import { normalizeRepoUrl } from '../../src/enrich/depsdev/repo.js';
import { ensureClone, readHistory } from '../../src/history/git.js';
import { localIdentity } from '../../src/history/identity.js';
import type { HistoryRecord } from '../../src/history/record.js';
import { declaredStatusOf } from '../../src/stability/declared.js';
import { rmSync } from 'node:fs';
import type { RecordedPackage } from './fixture.js';

export type Json = Record<string, any>;

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

export async function getJson(url: string): Promise<{ status: number; body?: Json }> {
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
export function repositoryField(r: unknown): Json | undefined {
  const n = repoFromManifestField(r);
  return n ? { type: 'git', url: n.url, ...(n.directory ? { directory: n.directory } : {}) } : undefined;
}

/** Packument trimmed to the stability inputs; e-mails collected separately (memory only). */
export function trimPackument(raw: Json, inUse: readonly string[]): { packument: Json; emails: Map<string, Set<string>> } {
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
export function repoOf(p: Json, versions: readonly string[]): { url: string; directory?: string } | undefined {
  for (const v of versions) {
    const r = repoFromManifestField(p.versions?.[v]?.repository) ?? repoFromManifestField(p.repository);
    if (r) return r.directory ? { url: r.url, directory: r.directory } : { url: r.url };
  }
  const r = repoFromManifestField(p.repository);
  return r ? (r.directory ? { url: r.url, directory: r.directory } : { url: r.url }) : undefined;
}

/** The enricher's repository key (src/enrich/history/index.ts). */
export function cloneKey(url: string): string | undefined {
  let u = url.replace(/\.git$/, '').replace(/\/+$/, '');
  if (u.startsWith('https://github.com/')) u = u.toLowerCase();
  return /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+$/.test(u) ? u : undefined;
}

export async function recordHistory(url: string, emails: Map<string, Set<string>>, salt: Buffer, cacheDir: string): Promise<HistoryRecord | { error: string }> {
  const t0 = Date.now();
  try {
    const dir = await ensureClone(url, { dir: cacheDir, maxBytes: 300e6, timeoutMs: 600_000 });
    const rec = await readHistory(dir, { repo: url, salt, timeoutMs: 600_000 });
    rmSync(dir, { recursive: true, force: true });
    const ids = new Set<string>();
    for (const c of rec.commits) (ids.add(c.author), ids.add(c.committer));
    for (const t of rec.tags) ids.add(t.by);
    const links: Record<string, string> = {};
    const all: Record<string, string[]> = {};
    for (const [name, set] of emails) {
      for (const e of set) {
        const id = localIdentity(e, salt);
        if (!ids.has(id)) continue;
        links[name] ??= id;
        (all[name] ??= []).includes(id) || all[name]!.push(id);
      }
    }
    rec.npmPublishers = links;
    // Tier 0: every id an account's registry addresses hash to (the npm-publisher identity merge).
    rec.npmPublisherIds = all;
    console.log(`  history ${url}: ${rec.commits.length} commits, ${rec.tags.length} tags, ${Object.keys(links).length}/${emails.size} npm accounts matched, ${Date.now() - t0} ms`);
    return rec;
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0]!.slice(0, 200);
    console.log(`  history ${url}: not read (${msg})`);
    return { error: msg };
  }
}

export async function recordProject(url: string): Promise<Json | undefined> {
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

export async function recordPackage(name: string, versions: string[]): Promise<{ pkg: RecordedPackage; emails: Map<string, Set<string>> } | undefined> {
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

/** OSV record trimmed to what osvRecordsToFacts reads, for `name` only (no credits, no details). */
export function trimOsv(rec: Json, name: string): Json {
  const out: Json = { id: rec.id };
  for (const k of ['aliases', 'summary', 'published', 'modified', 'withdrawn', 'severity']) if (rec[k] !== undefined) out[k] = rec[k];
  out.affected = (rec.affected ?? []).filter((a: Json) => a?.package?.ecosystem === 'npm' && String(a?.package?.name).toLowerCase() === name.toLowerCase()).map((a: Json) => ({ package: { ecosystem: 'npm', name: a.package.name }, ranges: a.ranges ?? [], ...(a.database_specific?.severity ? { database_specific: { severity: a.database_specific.severity } } : {}) }));
  out.references = (rec.references ?? []).filter((r: Json) => r?.type === 'ADVISORY' || r?.type === 'REPORT').map((r: Json) => ({ type: r.type, url: r.url }));
  const db = rec.database_specific ?? {};
  const keep: Json = {};
  if (db.severity !== undefined) keep.severity = db.severity;
  if (Array.isArray(db.cwe_ids)) keep.cwe_ids = db.cwe_ids;
  if (db.malicious !== undefined) keep.malicious = db.malicious;
  if (Object.keys(keep).length) out.database_specific = keep;
  return out;
}

export async function osvFor(name: string, version: string, records: Map<string, Json>): Promise<Json[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.osv.dev/v1/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ package: { name, ecosystem: 'npm' }, version }) });
      if (res.status !== 200) throw new Error(`OSV ${res.status}`);
      const body = (await res.json()) as Json;
      if (body.next_page_token) throw new Error('OSV paging not expected for one version');
      const out: Json[] = [];
      for (const v of body.vulns ?? []) {
        if (!records.has(v.id)) records.set(v.id, v);
        out.push(trimOsv(records.get(v.id)!, name));
      }
      return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return [];
}

/** Add size, dependency, tarball and OSV inputs to one recorded package (in place). */
export async function augmentPackage(pkg: RecordedPackage, osvRecords: Map<string, Json>): Promise<void> {
  const res = await getJson(packumentUrl(pkg.name));
  if (!res.body) throw new Error(`npm ${pkg.name}: ${res.status}`);
  const raw = res.body;
  const versions = pkg.packument.versions as Json;
  const latest = pkg.packument['dist-tags']?.latest;
  const tarballs: Record<string, { unpackedSize: number; fileCount: number }> = {};
  for (const v of new Set([...pkg.versions, ...(typeof latest === 'string' ? [latest] : [])])) {
    const m = raw.versions?.[v];
    if (!m || !versions[v]) continue;
    const dist: Json = {};
    if (typeof m.dist?.unpackedSize === 'number') dist.unpackedSize = m.dist.unpackedSize;
    if (typeof m.dist?.fileCount === 'number') dist.fileCount = m.dist.fileCount;
    if (typeof m.dist?.tarball === 'string') dist.tarball = m.dist.tarball;
    versions[v].dist = dist;
    for (const k of ['dependencies', 'optionalDependencies']) if (m[k] && typeof m[k] === 'object') versions[v][k] = m[k];
    if (pkg.versions.includes(v) && (dist.unpackedSize === undefined || dist.fileCount === undefined) && dist.tarball) {
      const t = await fetch(dist.tarball);
      if (t.status !== 200) throw new Error(`tarball ${dist.tarball}: ${t.status}`);
      tarballs[v] = tarballFootprint(Buffer.from(await t.arrayBuffer()));
    }
  }
  if (Object.keys(tarballs).length) pkg.tarballs = tarballs;
  const osv: Record<string, Json[]> = {};
  for (const v of pkg.versions) osv[v] = await osvFor(pkg.name, v, osvRecords);
  pkg.osv = osv;
}

