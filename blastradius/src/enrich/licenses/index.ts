/**
 * Licences enricher (docs/WHO-BEHIND-PLAN.md L1, L2, L3): `license` and `license_change` facts.
 *
 * Sources, each recorded as the fact's `source`:
 *   - "depsdev" (primary): deps.dev GetVersionBatch, POST /v3alpha/versionbatch (sent 100 versions
 *     at a time, deps.dev's page size), `licenseDetails[]` = the author's string + deps.dev's SPDX
 *     mapping.
 *     The release history comes from GetPackage, GET /v3/systems/{system}/packages/{name}.
 *     deps.dev terms: Google API Terms of Service; caching is expressly permitted
 *     (https://docs.deps.dev/api/v3/#terms).
 *   - "clearlydefined" (second source, for disagreement and curation): POST /definitions with
 *     `expand=-files`, `licensed.declared` and the licence score. ClearlyDefined data is CC0; the
 *     POST endpoint is limited to 250 requests a minute (https://docs.clearlydefined.io/docs/get-involved/using-data).
 *   - "registry": the package registry's own metadata (PyPI JSON API `info.license_expression`,
 *     `info.license`, License classifiers; npm packument `versions[v].license`), asked only for
 *     releases deps.dev has no licence data for when a change is found across them (and the
 *     releases on either side), so the change is placed at the release that made it. See registry.ts.
 *   - "lockfile" / "sbom": the `license` npm copies into package-lock.json, or an imported SBOM's
 *     licences (Component.declaredLicenses). As declared in the scanned files.
 *
 * Ecosystems: every purl type deps.dev covers (npm, maven, pypi, golang, cargo, nuget, gem);
 * Syft brings the non-npm ones into an inventory. GitHub Actions have no package metadata: their
 * value is the licence the repository declares today (deps.dev GetProject, "the license reported
 * by the project host"), marked basis "repository" because it is not per version. Docker images
 * stay unknown (deps.dev has no container licences).
 */
import type { EnrichContext, Enricher } from '../../core/plugin.js';
import { OfflineMissError, SkippedHosts } from '../../core/http.js';
import { makeFact, parsePurl, unversionedPurl } from '../../core/types.js';
import type { Component, Fact, Inventory, LicenseChangeValue, Purl, PurlString } from '../../core/types.js';
import { detectLicenseChanges, releaseSegments, sortReleases, type ReleaseLicense } from '../../licenses/history.js';
import { licenseValue, licenseValueFromStrings } from '../../licenses/value.js';
import { errorMessage, mapLimit } from '../depsdev/util.js';
import { fetchRegistryReleases, PYPI_API, registrySupports, type RegistryRelease } from './registry.js';

export const DEPSDEV_API = 'https://api.deps.dev';
export const CLEARLYDEFINED_API = 'https://api.clearlydefined.io';

export interface LicenseEnricherOptions {
  /** deps.dev base URL. */
  baseUrl?: string;
  /** ClearlyDefined base URL. */
  clearlyDefinedUrl?: string;
  /** Query ClearlyDefined as a second source (default true). */
  clearlyDefined?: boolean;
  /** Fetch each package's release history for licence changes (default true). */
  history?: boolean;
  /**
   * Releases before the oldest version in use that are also compared (default 20). Every release
   * from there to the latest is compared, so a change between the version in use and the latest
   * (an upgrade would bring it) is always seen, plus the recent history before it.
   */
  historyBefore?: number;
  /** Most releases per package compared, the newest kept (default 400). */
  maxVersionsPerPackage?: number;
  /** Most recent changes kept per package (default 20). */
  maxChangesPerPackage?: number;
  /** Packages whose history is fetched in parallel (default 4). */
  concurrency?: number;
  /**
   * Fill releases without deps.dev licence data from the package registry's own metadata (PyPI
   * JSON API, npm packument) when a licence change is found across them (default true).
   */
  registry?: boolean;
  /** PyPI base URL (default https://pypi.org). */
  pypiUrl?: string;
  /** Most registry lookups per package (default 100); releases beyond stay gaps. */
  maxRegistryPerPackage?: number;
}

/** deps.dev system for a purl type. */
const SYSTEMS: Readonly<Record<string, string>> = {
  npm: 'NPM',
  maven: 'MAVEN',
  pypi: 'PYPI',
  golang: 'GO',
  cargo: 'CARGO',
  nuget: 'NUGET',
  gem: 'RUBYGEMS',
};

/** ClearlyDefined type/provider for a purl type (https://docs.clearlydefined.io, "coordinates"). */
const CD_TYPES: Readonly<Record<string, [string, string]>> = {
  npm: ['npm', 'npmjs'],
  maven: ['maven', 'mavencentral'],
  pypi: ['pypi', 'pypi'],
  golang: ['go', 'golang'],
  cargo: ['crate', 'cratesio'],
  nuget: ['nuget', 'nuget'],
  gem: ['gem', 'rubygems'],
};

interface PackageKey {
  system: string;
  name: string;
  /** Unversioned purl (fact subject for package-level facts). */
  purl: PurlString;
  /** deps.dev UI page for the package. */
  page: string;
}

/** deps.dev package key for a component, or undefined when deps.dev does not cover it. */
export function depsDevKey(c: Pick<Component, 'purl'>): (PackageKey & { version: string }) | undefined {
  let p: Purl;
  try {
    p = parsePurl(c.purl);
  } catch {
    return undefined;
  }
  const system = SYSTEMS[p.type];
  if (!system || !p.version || p.qualifiers?.vcs_url) return undefined;
  let name: string;
  if (p.type === 'maven') {
    if (!p.namespace) return undefined;
    name = `${p.namespace}:${p.name}`;
  } else if (p.type === 'npm' || p.type === 'golang') {
    name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
  } else {
    name = p.name;
  }
  if (name.length > 300 || p.version.length > 200) return undefined;
  const purl = unversionedPurl(c.purl);
  return { system, name, version: p.version, purl, page: `https://deps.dev/${system.toLowerCase()}/${encodeURIComponent(name)}` };
}

/** ClearlyDefined coordinates ("npm/npmjs/@babel/core/7.24.0"), or undefined. */
export function clearlyDefinedCoordinates(c: Pick<Component, 'purl'>): string | undefined {
  let p: Purl;
  try {
    p = parsePurl(c.purl);
  } catch {
    return undefined;
  }
  const t = CD_TYPES[p.type];
  if (!t || !p.version || p.qualifiers?.vcs_url) return undefined;
  const ns = p.namespace ? (p.type === 'golang' ? encodeURIComponent(p.namespace) : p.namespace) : '-';
  const seg = (s: string) => s.replace(/\//g, '%2F');
  return [t[0], t[1], ns, seg(p.name), seg(p.version)].join('/');
}

interface DepsDevLicenseDetail {
  license?: string;
  spdx?: string;
}
interface BatchVersion {
  versionKey?: { system?: string; name?: string; version?: string };
  publishedAt?: string;
  licenses?: string[];
  licenseDetails?: DepsDevLicenseDetail[];
}
interface BatchResponse {
  responses?: { request?: { versionKey?: { system?: string; name?: string; version?: string } }; version?: BatchVersion }[];
  nextPageToken?: string;
}
interface PackageResponse {
  versions?: { versionKey?: { version?: string }; publishedAt?: string }[];
}
interface ProjectResponse {
  license?: string;
}
interface ClearlyDefinedDefinition {
  licensed?: { declared?: string; score?: { total?: number }; toolScore?: { total?: number } };
  described?: { releaseDate?: string };
}

/** deps.dev answers a version batch in pages of 100; asking for 100 at a time avoids re-sending a large body per page. */
const BATCH_MAX = 100;
const CD_BATCH_MAX = 500;

function versionKey(system: string, name: string, version: string): string {
  return `${system}\u0000${name}\u0000${version}`;
}

function entriesOf(v: BatchVersion): { raw: string; spdx?: string }[] {
  const details = Array.isArray(v.licenseDetails) ? v.licenseDetails.filter((d) => d && typeof d === 'object') : [];
  if (details.length > 0) {
    return details.map((d) => {
      const e: { raw: string; spdx?: string } = { raw: typeof d.license === 'string' ? d.license : '' };
      if (typeof d.spdx === 'string') e.spdx = d.spdx;
      return e;
    });
  }
  // v3 shape: SPDX strings only.
  return (Array.isArray(v.licenses) ? v.licenses : []).filter((l): l is string => typeof l === 'string').map((l) => ({ raw: l, spdx: l }));
}

export function createLicenseEnricher(opts: LicenseEnricherOptions = {}): Enricher {
  const base = (opts.baseUrl ?? DEPSDEV_API).replace(/\/+$/, '');
  const cdBase = (opts.clearlyDefinedUrl ?? CLEARLYDEFINED_API).replace(/\/+$/, '');
  const wantHistory = opts.history ?? true;
  const wantCd = opts.clearlyDefined ?? true;
  const maxVersions = opts.maxVersionsPerPackage ?? 400;
  const historyBefore = opts.historyBefore ?? 20;
  const maxChanges = opts.maxChangesPerPackage ?? 20;
  const concurrency = opts.concurrency ?? 4;
  const wantRegistry = opts.registry ?? true;
  const pypiBase = opts.pypiUrl ?? PYPI_API;
  const maxRegistry = opts.maxRegistryPerPackage ?? 100;

  return {
    name: 'licenses',
    async enrich(inv: Inventory, ctx: EnrichContext): Promise<Fact[]> {
      const problems = new Problems(ctx);
      const facts: Fact[] = [];
      const components = [...inv.components].sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));

      // 1. Licences declared in the scanned files.
      for (const c of components) {
        const d = c.declaredLicenses;
        if (!d || d.values.length === 0) continue;
        facts.push(makeFact('license', c.purl, licenseValueFromStrings(d.values, c.version), { source: d.via, fetchedAt: ctx.now }));
      }

      // 2. deps.dev: release history per package, then one batch for every version needed.
      const packages = new Map<string, PackageKey & { inUse: Set<string>; history: { version: string; publishedAt?: string }[] }>();
      const byComponent = new Map<PurlString, PackageKey & { version: string }>();
      for (const c of components) {
        const k = depsDevKey(c);
        if (!k) continue;
        byComponent.set(c.purl, k);
        const id = `${k.system}\u0000${k.name}`;
        let p = packages.get(id);
        if (!p) packages.set(id, (p = { system: k.system, name: k.name, purl: k.purl, page: k.page, inUse: new Set(), history: [] }));
        p.inUse.add(k.version);
      }
      const pkgList = [...packages.values()].sort((a, b) => (a.system + a.name < b.system + b.name ? -1 : 1));
      if (wantHistory) {
        await mapLimit(pkgList, concurrency, async (p) => {
          try {
            const r = await ctx.http.fetchJsonOrNull<PackageResponse>(`${base}/v3/systems/${p.system.toLowerCase()}/packages/${encodeURIComponent(p.name)}`);
            const versions = (Array.isArray(r?.versions) ? r.versions : [])
              .map((v) => ({ version: v?.versionKey?.version, publishedAt: v?.publishedAt }))
              .filter((v): v is { version: string; publishedAt: string | undefined } => typeof v.version === 'string' && v.version.length <= 200)
              // A replay (--as-of) must not see releases that did not exist yet.
              .filter((v) => !ctx.historical || p.inUse.has(v.version) || !v.publishedAt || Date.parse(v.publishedAt) <= ctx.now.getTime());
            const sorted = sortReleases(versions);
            const used = sorted.map((v, i) => (p.inUse.has(v.version) ? i : -1)).filter((i) => i >= 0);
            const from = used.length > 0 ? Math.max(0, Math.min(...used) - historyBefore) : Math.max(0, sorted.length - historyBefore);
            p.history = sorted
              .slice(from)
              .slice(-maxVersions)
              .map((v) => (typeof v.publishedAt === 'string' ? { version: v.version, publishedAt: v.publishedAt } : { version: v.version }));
          } catch (e) {
            problems.add(e, `package ${p.system.toLowerCase()}/${p.name}`);
          }
        });
      }
      const requests: { system: string; name: string; version: string }[] = [];
      for (const p of pkgList) {
        const vs = new Set(p.history.map((h) => h.version));
        const extra = [...p.inUse].filter((v) => !vs.has(v)).sort();
        for (const v of [...p.history.map((h) => h.version), ...extra]) requests.push({ system: p.system, name: p.name, version: v });
      }
      const versions = new Map<string, BatchVersion>();
      for (let i = 0; i < requests.length; i += BATCH_MAX) {
        const chunk = requests.slice(i, i + BATCH_MAX);
        let pageToken: string | undefined;
        for (let page = 0; page < 100; page++) {
          const body: { requests: { versionKey: { system: string; name: string; version: string } }[]; pageToken?: string } = {
            requests: chunk.map((r) => ({ versionKey: r })),
          };
          if (pageToken) body.pageToken = pageToken;
          let res: BatchResponse | null;
          try {
            res = await ctx.http.fetchJsonOrNull<BatchResponse>(`${base}/v3alpha/versionbatch`, { method: 'POST', body });
          } catch (e) {
            problems.add(e, `version batch of ${chunk.length}`);
            break;
          }
          for (const r of Array.isArray(res?.responses) ? res.responses : []) {
            const k = r?.request?.versionKey;
            if (!k?.system || !k.name || !k.version || !r.version || typeof r.version !== 'object') continue;
            versions.set(versionKey(k.system, k.name, k.version), r.version);
          }
          pageToken = typeof res?.nextPageToken === 'string' && res.nextPageToken ? res.nextPageToken : undefined;
          if (!pageToken) break;
        }
      }

      for (const c of components) {
        const k = byComponent.get(c.purl);
        const v = k && versions.get(versionKey(k.system, k.name, k.version));
        if (!k || !v) continue;
        const page = `${k.page}/${encodeURIComponent(k.version)}`;
        facts.push(makeFact('license', c.purl, licenseValue(entriesOf(v), k.version), { source: 'depsdev', fetchedAt: ctx.now, evidence: [page] }));
      }
      for (const p of pkgList) {
        if (p.history.length < 2) continue;
        const releases: ReleaseLicense[] = [];
        for (const h of p.history) {
          const v = versions.get(versionKey(p.system, p.name, h.version));
          const lv = v ? licenseValue(entriesOf(v), h.version) : undefined;
          // A release deps.dev has no record for is a gap too (counted, never a change).
          const r: ReleaseLicense = { version: h.version, expressions: lv?.expressions ?? [], status: lv?.status ?? 'unknown', raw: lv?.raw ?? [] };
          const at = h.publishedAt ?? v?.publishedAt;
          if (typeof at === 'string') r.publishedAt = at;
          releases.push(r);
        }
        let changes: LicenseChangeValue[] = detectLicenseChanges(releases);

        // 2a. A change across releases without deps.dev licence data: ask the package registry
        // for those releases (and the two around them, so values are compared like with like).
        const evidenceOf = new Map<string, string>();
        if (wantRegistry && registrySupports(p.system) && changes.some((c) => (c.unknownBetween ?? 0) > 0)) {
          const order = sortReleases(releases);
          const ask = new Set<string>();
          for (const c of changes) {
            if (!c.unknownBetween) continue;
            const lo = order.findIndex((r) => r.version === c.previousVersion);
            const hi = order.findIndex((r) => r.version === c.version);
            if (lo < 0 || hi < 0) continue;
            for (const r of order.slice(lo, hi + 1)) ask.add(r.version);
          }
          const list = order.map((r) => r.version).filter((v) => ask.has(v));
          if (list.length > maxRegistry) ctx.warn?.(`licenses: ${p.system.toLowerCase()}/${p.name}: ${list.length} releases around licence-data gaps, registry checked for the first ${maxRegistry}`);
          let fill: RegistryRelease[] = [];
          try {
            fill = await fetchRegistryReleases(ctx.http, p.system, p.name, list.slice(0, maxRegistry), { pypiBase });
          } catch (e) {
            problems.add(e, `registry metadata for ${p.system.toLowerCase()}/${p.name}`);
          }
          if (fill.length > 0) {
            const published = new Map(releases.map((r) => [r.version, r.publishedAt]));
            const fillReleases: ReleaseLicense[] = fill.map((f) => {
              const lv = licenseValue(f.entries, f.version);
              evidenceOf.set(f.version, f.evidence);
              const r: ReleaseLicense = { version: f.version, expressions: lv.expressions, status: lv.status, raw: lv.raw, source: 'registry' };
              const at = published.get(f.version) ?? f.publishedAt;
              if (at) r.publishedAt = at;
              return r;
            });
            changes = detectLicenseChanges(releases, { fill: fillReleases, primarySource: 'depsdev' });
            // The registry's statement for each version in use it was asked about, as its own source.
            for (const c of components) {
              const k = byComponent.get(c.purl);
              if (!k || k.system !== p.system || k.name !== p.name) continue;
              const f = fill.find((x) => x.version === k.version);
              if (f) facts.push(makeFact('license', c.purl, licenseValue(f.entries, k.version), { source: 'registry', fetchedAt: ctx.now, evidence: [f.evidence] }));
            }
          }
        }

        for (const ch of changes.slice(-maxChanges)) {
          const fromRegistry = ch.fromSource === 'registry' || ch.toSource === 'registry';
          const evidence = fromRegistry
            ? [...new Set([evidenceOf.get(ch.version), evidenceOf.get(ch.previousVersion), `${p.page}/${encodeURIComponent(ch.version)}`, `${p.page}/${encodeURIComponent(ch.previousVersion)}`].filter((x): x is string => !!x))]
            : [`${p.page}/${encodeURIComponent(ch.version)}`, `${p.page}/${encodeURIComponent(ch.previousVersion)}`];
          facts.push(makeFact('license_change', p.purl, ch, { source: fromRegistry ? 'registry' : 'depsdev', fetchedAt: ctx.now, evidence }));
        }
      }

      // 2b. GitHub Actions: the repository's licence today (deps.dev GetProject), one request per repo.
      // A replay (--as-of) skips it: today's repository licence was not observable then.
      const actionRepos = new Map<string, Component[]>();
      for (const c of ctx.historical ? [] : components) {
        let p: Purl;
        try {
          p = parsePurl(c.purl);
        } catch {
          continue;
        }
        if (p.type !== 'githubactions' || !p.namespace || !/^[A-Za-z0-9_.-]{1,100}$/.test(p.namespace) || !/^[A-Za-z0-9_.-]{1,100}$/.test(p.name)) continue;
        const repo = `github.com/${p.namespace.toLowerCase()}/${p.name.toLowerCase()}`;
        actionRepos.set(repo, [...(actionRepos.get(repo) ?? []), c]);
      }
      await mapLimit([...actionRepos.keys()].sort(), concurrency, async (repo) => {
        let r: ProjectResponse | null;
        try {
          r = await ctx.http.fetchJsonOrNull<ProjectResponse>(`${base}/v3/projects/${encodeURIComponent(repo)}`);
        } catch (e) {
          problems.add(e, `project ${repo}`);
          return;
        }
        const license = typeof r?.license === 'string' ? r.license.trim() : '';
        if (!license) return;
        for (const c of actionRepos.get(repo)!) {
          const value = licenseValue([{ raw: license, spdx: license }], c.version);
          value.basis = 'repository';
          facts.push(makeFact('license', c.purl, value, { source: 'depsdev', fetchedAt: ctx.now, evidence: [`https://deps.dev/project/github/${encodeURIComponent(repo.slice('github.com/'.length))}`] }));
        }
      });

      // 3. ClearlyDefined declared licence for the versions in use.
      if (wantCd) {
        const coords = new Map<string, Component>();
        for (const c of components) {
          const k = clearlyDefinedCoordinates(c);
          if (k && !coords.has(k)) coords.set(k, c);
        }
        const keys = [...coords.keys()].sort();
        for (let i = 0; i < keys.length; i += CD_BATCH_MAX) {
          const chunk = keys.slice(i, i + CD_BATCH_MAX);
          let res: Record<string, ClearlyDefinedDefinition> | null;
          try {
            res = await ctx.http.fetchJsonOrNull<Record<string, ClearlyDefinedDefinition>>(`${cdBase}/definitions?expand=-files`, { method: 'POST', body: chunk });
          } catch (e) {
            problems.add(e, `ClearlyDefined batch of ${chunk.length}`);
            continue;
          }
          if (!res || typeof res !== 'object') continue;
          for (const key of chunk) {
            const def = Object.hasOwn(res, key) ? res[key] : undefined;
            const declared = def?.licensed?.declared;
            if (typeof declared !== 'string' || !declared.trim()) continue;
            const c = coords.get(key)!;
            const value = licenseValueFromStrings([declared], c.version);
            const score = def?.licensed?.score?.total;
            if (typeof score === 'number' && Number.isFinite(score)) value.score = Math.max(0, Math.min(100, Math.round(score)));
            facts.push(makeFact('license', c.purl, value, { source: 'clearlydefined', fetchedAt: ctx.now, evidence: [`https://clearlydefined.io/definitions/${key}`] }));
          }
        }
      }

      problems.flush();
      return facts;
    },
  };
}

/** True for a version string deps.dev history comparison can place (plain release). */
export function isPlainRelease(version: string): boolean {
  return releaseSegments(version) !== undefined;
}

class Problems {
  private offlineMisses: string[] = [];
  private readonly skipped = new SkippedHosts();
  constructor(private readonly ctx: EnrichContext) {}
  add(e: unknown, what: string): void {
    if (this.skipped.add(e)) return;
    if (e instanceof OfflineMissError) this.offlineMisses.push(e.key);
    else this.ctx.warn?.(`licenses: ${what} failed: ${errorMessage(e)}`);
  }
  flush(): void {
    this.skipped.flush('licenses', this.ctx.warn);
    if (this.offlineMisses.length === 0) return;
    this.ctx.warn?.(`licenses: ${this.offlineMisses.length} request(s) had no fixture or cached response offline (e.g. ${this.offlineMisses[0]})`);
    this.offlineMisses = [];
  }
}
