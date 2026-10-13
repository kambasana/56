/**
 * PyPI release-record enricher (Tier 0.5: Python upkeep must never read as clean).
 *
 * For every PyPI component, once per project:
 *   GET https://pypi.org/pypi/{name}/json (PyPI JSON API, https://docs.pypi.org/api/json/):
 *     `releases` (each file's `upload_time_iso_8601` and `yanked` / `yanked_reason`, PEP 592) and
 *     `info.classifiers` ("Development Status :: 7 - Inactive", set by the maintainers);
 *   GET https://pypi.org/simple/{name}/ with Accept: application/vnd.pypi.simple.v1+json (PEP 691
 *     JSON Simple API; `project-status`, PEP 792: active, archived, quarantined, deprecated; files
 *     with a PEP 740 provenance attestation, i.e. Trusted Publishing).
 * and derives, as the npm enricher does from a packument:
 *   release_cadence (package): S4 over the stable releases (PEP 440 pre-releases left out);
 *   release_age (per version in use): its upload date, the latest release, the first release, the
 *     stable releases in the final year, whether it is yanked, and the project status;
 *   declared_status (package): the "Inactive" classifier (low confidence, like a README declaration);
 *   release_publishers (package): the versions published in the last 36 months and those with a
 *     Trusted Publishing attestation (PEP 740), for the git-side release-continuity checks; no
 *     account names (PyPI does not publish the uploader).
 * A release's date is its earliest file upload. Releases after the scan time are left out.
 * Repository and Scorecard come from deps.dev (src/enrich/depsdev), git history from the history
 * enricher; together they give PyPI packages the same labels as npm ones (src/stability).
 */
import type { EnrichContext, Enricher } from '../../core/plugin.js';
import { makeFact, unversionedPurl, type Fact, type Inventory, type ReleaseAgeValue, type ReleasePublishersValue } from '../../core/types.js';
import { isPrereleaseVersion } from '../../history/continuity.js';
import { releaseCadence, type ReleaseRecord } from '../../stability/cadence.js';
import { normalizePypiName, pypiPurl } from '../../ingest/python.js';
import { mapLimit } from '../depsdev/util.js';
import { normalizeRepoUrl } from '../depsdev/repo.js';
import { declaredStatusOf } from '../../stability/declared.js';

export const PYPI_BASE = 'https://pypi.org';
const DAY_MS = 86_400_000;
const SOURCE = 'pypi';

export interface PypiEnricherOptions {
  /** Base URL (default https://pypi.org). */
  baseUrl?: string;
  /** Parallel projects (default 4; HttpClient also rate-limits per host). */
  concurrency?: number;
}


export function pypiProjectPage(name: string, version?: string): string {
  return `https://pypi.org/project/${encodeURIComponent(normalizePypiName(name))}/${version ? `${encodeURIComponent(version)}/` : ''}`;
}

interface PypiFile {
  upload_time_iso_8601?: unknown;
  upload_time?: unknown;
  yanked?: unknown;
  yanked_reason?: unknown;
}

export interface PypiProject {
  info?: { version?: unknown; classifiers?: unknown; name?: unknown; description?: unknown; project_urls?: unknown; home_page?: unknown };
  releases?: Record<string, PypiFile[] | unknown>;
}

export interface PypiSimple {
  'project-status'?: { status?: unknown; reason?: unknown };
  /** Files; `provenance` is the URL of a PEP 740 attestation (Trusted Publishing), else null. */
  files?: { filename?: unknown; provenance?: unknown }[];
}

export interface PypiRelease {
  version: string;
  publishedMs: number;
  publishedAt: string;
  /** Every file of the release is yanked. */
  yanked: boolean;
  yankedReason?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 300) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);

/** Releases with at least one file, by earliest upload, oldest first; none after `asOf`. */
export function pypiReleases(p: PypiProject, asOf: Date): PypiRelease[] {
  const out: PypiRelease[] = [];
  const releases = isObj(p.releases) ? p.releases : {};
  for (const [version, files] of Object.entries(releases).slice(0, 5000)) {
    if (!Array.isArray(files) || files.length === 0) continue;
    let first: number | undefined;
    let yanked = true;
    let reason: string | undefined;
    for (const f of files as PypiFile[]) {
      if (!isObj(f)) continue;
      const t = Date.parse(String(f.upload_time_iso_8601 ?? (typeof f.upload_time === 'string' ? `${f.upload_time}Z` : '')));
      if (Number.isFinite(t) && (first === undefined || t < first)) first = t;
      if (f.yanked !== true) yanked = false;
      else reason ??= str(f.yanked_reason, 300);
    }
    if (first === undefined || first > asOf.getTime()) continue;
    out.push({ version, publishedMs: first, publishedAt: new Date(first).toISOString(), yanked, ...(yanked && reason ? { yankedReason: reason } : {}) });
  }
  return out.sort((a, b) => a.publishedMs - b.publishedMs || a.version.localeCompare(b.version));
}

/** Release age of one version in use, from the release list (undefined when the version is not on PyPI). */
export function pypiReleaseAge(releases: readonly PypiRelease[], version: string, latestDeclared: string | undefined, asOf: Date, status?: ReleaseAgeValue['projectStatus']): ReleaseAgeValue | undefined {
  const norm = (v: string) => v.toLowerCase().replace(/^v/, '');
  const r = releases.find((x) => x.version === version) ?? releases.find((x) => norm(x.version) === norm(version));
  if (!r) return undefined;
  const value: ReleaseAgeValue = { version: r.version, publishedAt: r.publishedAt, ageDays: Math.max(0, Math.floor((asOf.getTime() - r.publishedMs) / DAY_MS)) };
  const stable = releases.filter((x) => !isPrereleaseVersion(x.version) && !x.yanked);
  // The latest release: the version PyPI names (info.version) when it was out at the scan time, else the newest stable one.
  const latest = (latestDeclared ? releases.find((x) => x.version === latestDeclared) : undefined) ?? stable[stable.length - 1];
  if (latest) {
    value.latestVersion = latest.version;
    value.latestPublishedAt = latest.publishedAt;
  }
  const newest = releases[releases.length - 1];
  if (newest) value.daysSinceLatestRelease = Math.max(0, Math.floor((asOf.getTime() - newest.publishedMs) / DAY_MS));
  if (releases[0]) value.firstPublishedAt = releases[0].publishedAt;
  const lastStable = stable[stable.length - 1];
  if (lastStable) value.releasesInFinalYear = stable.filter((x) => x.publishedMs > lastStable.publishedMs - 365 * DAY_MS).length;
  if (r.yanked) value.yanked = r.yankedReason ?? '';
  if (status) value.projectStatus = status;
  return value;
}

/** PEP 792 project status other than "active". */
export function pypiProjectStatus(s: PypiSimple | null | undefined): ReleaseAgeValue['projectStatus'] | undefined {
  const ps = isObj(s) && isObj(s['project-status']) ? s['project-status'] : undefined;
  const status = ps?.status;
  if (status !== 'archived' && status !== 'deprecated' && status !== 'quarantined') return undefined;
  const reason = str(ps?.reason, 300);
  return { status, ...(reason ? { reason } : {}) };
}

/** The version in a distribution file name: "flask-3.1.3-py3-none-any.whl", "flask-3.1.3.tar.gz" → "3.1.3". */
export function versionOfFile(filename: string): string | undefined {
  if (filename.endsWith('.whl')) return filename.split('-')[1];
  const base = filename.replace(/\.(tar\.gz|tar\.bz2|tgz|zip|tar)$/i, '');
  const i = base.lastIndexOf('-');
  return i > 0 ? base.slice(i + 1) : undefined;
}

/** Versions with a file published through Trusted Publishing (a PEP 740 provenance attestation): the project's CI, not a person's upload. */
export function trustedPypiVersions(simple: PypiSimple | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const f of Array.isArray(simple?.files) ? simple!.files! : []) {
    if (typeof f?.filename !== 'string' || typeof f.provenance !== 'string' || !f.provenance) continue;
    const v = versionOfFile(f.filename);
    if (v) out.add(v);
  }
  return out;
}

/** All facts for one PyPI project (pure; used by the enricher and the recorded-data tests). */
export function pypiFacts(name: string, versions: readonly string[], project: PypiProject, simple: PypiSimple | null | undefined, asOf: Date, fetchedAt: string): Fact[] {
  const purl = (v?: string) => pypiPurl(name, v) as Fact['subject'];
  const meta = (evidence: string[]) => ({ source: SOURCE, fetchedAt, evidence });
  const releases = pypiReleases(project, asOf);
  const facts: Fact[] = [];
  const records: ReleaseRecord[] = releases.map((r) => ({ version: r.version, publishedAt: r.publishedAt, publishedMs: r.publishedMs, trustedPublisher: false }));
  const cadence = releaseCadence(records, asOf, isPrereleaseVersion);
  if (cadence) facts.push(makeFact('release_cadence', purl(), cadence, meta([pypiProjectPage(name)])));
  const status = pypiProjectStatus(simple);
  const latestDeclared = str(project.info?.version, 100);
  // The release record for the git-side continuity checks (Tier 0.5), as for npm: which versions were
  // published (a tag PyPI never got is no release of this package) and which went out through Trusted
  // Publishing (the project's CI, not a person). PyPI does not publish who uploaded a release, so no
  // account is named: the account fields stay empty.
  if (releases.length) {
    const trusted = trustedPypiVersions(simple);
    const since = asOf.getTime() - 3 * 365 * DAY_MS;
    const recent = releases.filter((r) => r.publishedMs >= since).slice(-500);
    const value: ReleasePublishersValue = { releases: releases.length, accounts: [] };
    const tv = releases.filter((r) => trusted.has(r.version)).map((r) => r.version);
    if (tv.length) value.trustedVersions = tv.slice(-500);
    if (recent.length) {
      value.publisherByVersion = Object.fromEntries(recent.map((r) => [r.version, '']));
      value.publisherSince = recent[0]!.publishedAt.slice(0, 10);
    }
    facts.push(makeFact('release_publishers', purl(), value, meta([pypiProjectPage(name)])));
  }
  // Tier 0.6: the source repository the LATEST release declares (project_urls); the labels use it
  // only when deps.dev knows none for the version in use (geographiclib 2.0 declares only a homepage).
  const latestRepo = latestDeclared ? pypiSourceRepo(project.info) : undefined;
  for (const v of versions) {
    const age = pypiReleaseAge(releases, v, latestDeclared, asOf, status);
    if (age && latestRepo) age.latestRepository = latestRepo;
    if (age) facts.push(makeFact('release_age', purl(v), age, meta([pypiProjectPage(name, age.version)])));
  }
  const classifiers = Array.isArray(project.info?.classifiers) ? (project.info.classifiers as unknown[]).filter((c): c is string => typeof c === 'string') : [];
  const inactive = classifiers.find((c) => /^Development Status :: 7 - Inactive$/i.test(c.trim()));
  // Tier 0.6: the project description is the PyPI README; a project-level declaration in it counts
  // like an npm README's, and together with the Inactive classifier the two are the second fact
  // for each other (click-plugins: "This PyPI package is no longer actively maintained").
  const described = declaredStatusOf(project.info?.description, name);
  if (inactive && described && described.status !== 'maintenance_mode')
    facts.push(makeFact('declared_status', purl(), { status: 'unmaintained', phrase: described.phrase, via: 'pypi.description', also: `the PyPI classifier "${inactive.trim()}"` }, meta([pypiProjectPage(name)])));
  else if (inactive) facts.push(makeFact('declared_status', purl(), { status: 'unmaintained', phrase: inactive.trim(), via: 'pypi.classifier' }, meta([pypiProjectPage(name)])));
  else if (described) facts.push(makeFact('declared_status', purl(), { ...described, via: 'pypi.description' }, meta([pypiProjectPage(name)])));
  return facts;
}

/** project_urls keys that name the source repository (PyPA's well-known labels, case-insensitive). */
const SOURCE_KEYS = /^(?:source|source code|sourcecode|repository|repo|code|github|gitlab|git|source repository)$/i;

/**
 * Tier 0.6: the source repository the project's latest release declares: a project_urls entry
 * labelled as source (Source, Source Code, Repository, …), else a homepage that is itself a GitHub,
 * GitLab or Bitbucket repository. Funding and profile pages never count.
 */
export function pypiSourceRepo(info: PypiProject['info']): { url: string } | undefined {
  const urls = isObj(info?.project_urls) ? (info!.project_urls as Record<string, unknown>) : {};
  const candidates = [...Object.entries(urls).filter(([k]) => SOURCE_KEYS.test(k.trim())).map(([, v]) => v), ...Object.entries(urls).filter(([k]) => /^home ?page$/i.test(k.trim())).map(([, v]) => v), info?.home_page];
  for (const c of candidates) {
    const n = normalizeRepoUrl(c);
    if (n && /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+$/.test(n.url)) return { url: n.url };
  }
  return undefined;
}

export function createPypiEnricher(opts: PypiEnricherOptions = {}): Enricher {
  const base = (opts.baseUrl ?? PYPI_BASE).replace(/\/+$/, '');
  return {
    name: SOURCE,
    async enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      const byName = new Map<string, { name: string; versions: Set<string> }>();
      for (const c of inv.components) {
        if (c.ecosystem !== 'pypi' || !c.name || c.name.length > 200 || !c.version) continue;
        const key = unversionedPurl(c.purl);
        const e = byName.get(key) ?? { name: c.name, versions: new Set<string>() };
        e.versions.add(c.version);
        byName.set(key, e);
      }
      let failed = 0;
      const lists = await mapLimit([...byName.values()], opts.concurrency ?? 4, async (p) => {
        const n = encodeURIComponent(normalizePypiName(p.name));
        let project: PypiProject | null;
        try {
          // Not kept in the disk cache (ttl 0): a project's full release list is large (superset's 312
          // projects: 218 MB of JSON, 122 MB of Simple API) and only a few fields are read.
          project = await ctx.http.fetchJsonOrNull<PypiProject>(`${base}/pypi/${n}/json`, { ttlMs: 0 });
        } catch {
          failed++;
          return [];
        }
        if (!project || !isObj(project)) return [];
        // The project status is best effort: without it the release record still counts.
        // PEP 691 content negotiation: the JSON form is asked for by Accept header (PyPI answers HTML to a query parameter).
        const simple = await ctx.http.fetchJsonOrNull<PypiSimple>(`${base}/simple/${n}/`, { ttlMs: 0, headers: { accept: 'application/vnd.pypi.simple.v1+json' } }).catch(() => null);
        return pypiFacts(p.name, [...p.versions].sort(), project, simple, ctx.now, ctx.now.toISOString());
      });
      if (failed > 0) ctx.warn?.(`pypi: ${failed} project${failed === 1 ? '' : 's'} could not be read from PyPI; their upkeep falls back to deps.dev / Scorecard or stays Unknown`);
      return lists.flat().sort((a, b) => a.subject.localeCompare(b.subject) || a.kind.localeCompare(b.kind));
    },
  };
}
