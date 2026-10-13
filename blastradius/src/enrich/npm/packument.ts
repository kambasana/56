/**
 * Pure derivations from an npm packument. No I/O: `packumentFacts()` turns a
 * packument + a version into Facts, which makes it usable by backtests that
 * replay a historical packument.
 *
 * Time travel: versions published after `now` are ignored for history-based
 * signals, so a backtest with `now` set to the incident date only sees the
 * history that existed then.
 */
import { makeFact, npmPurl } from '../../core/types.js';
import type {
  Fact,
  FundingValue,
  Maintainer,
  MaintainersValue,
  ProvenanceValue,
  PublisherValue,
  PackageSizeValue,
  ReleaseAgeValue,
  DependencyAddedValue,
  RepoValue,
} from '../../core/types.js';
import { isObject, npmPackagePage } from './registry.js';
import { fundingFromManifestField, repoFromManifestField } from './repo.js';
import { isReleaseBot } from '../../history/bots.js';
import { analyzeInstallScripts, markNewInstallHooks } from './scripts.js';
import { addMonths } from '../../history/aggregate.js';
import { releaseCadence, releasePublishers } from '../../stability/cadence.js';
import type {
  NpmMaintainerChangeValue,
  NpmPublisherChangeValue,
  NpmVersionManifest,
  Packument,
  VersionRecord,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HANDLE_MAX = 214;
const MAX_MAINTAINERS = 500;
const MAX_VERSIONS = 20_000;

export interface PackumentFactOptions {
  /** Reference time (EnrichContext.now). */
  now: Date;
  /** Fact.fetchedAt; defaults to `now`. */
  fetchedAt?: Date | string;
  /** Only emit publisher/maintainer changes that happened at most this many days before the scanned release (default 365). */
  changeWindowDays?: number;
  /** Keep public registry e-mail addresses in facts (default false: data minimisation). */
  includeEmails?: boolean;
  /** Max maintainer_change facts per component from version history (default 5). */
  maxMaintainerChanges?: number;
}

export function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

function str(v: unknown, max = 1000): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

function parseTime(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Legacy person string `"name <email> (url)"` (email and url optional, in that order). Linear-time
 * scan (no backtracking regex over untrusted registry data). Anything else after the name yields {}.
 */
function parsePersonString(s: string): { name?: string; email?: string } {
  let i = 0;
  while (i < s.length && s[i] !== '<' && s[i] !== '(') i++;
  const name = s.slice(0, i).trim();
  if (!name) return {};
  let email: string | undefined;
  if (s[i] === '<') {
    const end = s.indexOf('>', i + 1);
    if (end < 0) return {};
    email = s.slice(i + 1, end);
    i = end + 1;
    while (i < s.length && /\s/.test(s[i]!)) i++;
  }
  if (s[i] === '(') {
    const end = s.indexOf(')', i + 1);
    if (end < 0) return {};
    i = end + 1;
  }
  if (s.slice(i).trim() !== '') return {};
  return email ? { name, email } : { name };
}

/** Maintainer list from a manifest/packument field (`[{name,email}]` or legacy `"name <email>"` strings). */
export function parseMaintainers(field: unknown, includeEmails = false): Maintainer[] | undefined {
  if (!Array.isArray(field)) return undefined;
  const out: Maintainer[] = [];
  for (const m of field.slice(0, MAX_MAINTAINERS)) {
    let name: string | undefined;
    let email: string | undefined;
    if (typeof m === 'string') {
      ({ name, email } = parsePersonString(m.slice(0, 600)));
    } else if (isObject(m)) {
      name = str(m.name, HANDLE_MAX);
      email = str(m.email, 254);
    }
    if (!name || out.some((o) => o.name === name)) continue;
    out.push(includeEmails && email ? { name, email } : { name });
  }
  return out;
}

function manifest(p: Packument, version: string): NpmVersionManifest | undefined {
  const versions = isObject(p.versions) ? p.versions : undefined;
  const m = versions && Object.hasOwn(versions, version) ? versions[version] : undefined;
  return isObject(m) ? m : undefined;
}

/**
 * Publish history sorted by publish time (oldest first), restricted to versions
 * that exist in `versions` and have a `time` entry. Pass `asOf` to drop later versions.
 */
export function versionHistory(p: Packument, asOf?: Date): VersionRecord[] {
  const versions = isObject(p.versions) ? p.versions : {};
  const time = isObject(p.time) ? p.time : {};
  const limit = asOf?.getTime();
  const out: VersionRecord[] = [];
  for (const version of Object.keys(versions).slice(0, MAX_VERSIONS)) {
    const ms = parseTime(time[version]);
    if (ms === undefined || (limit !== undefined && ms > limit)) continue;
    const m = manifest(p, version);
    if (!m) continue;
    const user = isObject(m._npmUser) ? m._npmUser : undefined;
    const rec: VersionRecord = {
      version,
      publishedAt: new Date(ms).toISOString(),
      publishedMs: ms,
      trustedPublisher: user?.trustedPublisher !== undefined && user.trustedPublisher !== null,
    };
    const publisher = str(user?.name, HANDLE_MAX);
    if (publisher) rec.publisher = publisher;
    const maint = parseMaintainers(m.maintainers);
    if (maint && maint.length > 0) rec.maintainers = maint.map((x) => x.name);
    out.push(rec);
  }
  out.sort((a, b) => a.publishedMs - b.publishedMs || compareVersions(a.version, b.version));
  return out;
}

/** Loose semver ordering used only as a tie-breaker. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[-+]/)[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  const preA = a.includes('-');
  const preB = b.includes('-');
  if (preA !== preB) return preA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function dependencyNames(m: NpmVersionManifest | undefined): Set<string> {
  const names = new Set<string>();
  for (const field of [m?.dependencies, m?.optionalDependencies]) {
    if (!isObject(field)) continue;
    for (const k of Object.keys(field).slice(0, 5000)) if (k.length <= HANDLE_MAX) names.add(k);
  }
  return names;
}

/** True when `version` only bumps the patch number of `base` (same major.minor, release builds only). */
export function isPatchBump(base: string, version: string): boolean {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  const b = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!a && !!b && a[1] === b[1] && a[2] === b[2] && Number(b[3]) > Number(a[3]);
}

/** A dependency counts as brand new when its first release is at most this many days before the release adding it. */
export const YOUNG_DEPENDENCY_DAYS = 30;

/** First release time (ms) of a package as of `asOf`; undefined when it had none by then. */
export function firstPublishedMs(p: Packument, asOf?: Date): number | undefined {
  return versionHistory(p, asOf)[0]?.publishedMs;
}

/**
 * Fill `young` on dependency_added facts: which added dependencies were brand new at release time.
 * `firstPublished(name)` returns the first release time in ms, null when the package had no release
 * at all (only after the scan's clock), or undefined when unknown (not fetched; never counted).
 */
export function markYoungDependencies(facts: Fact[], firstPublished: (name: string) => number | null | undefined): void {
  for (const f of facts) {
    if (f.kind !== 'dependency_added') continue;
    const v = f.value as DependencyAddedValue;
    const rel = v.releasedAt ? Date.parse(v.releasedAt) : NaN;
    if (!Number.isFinite(rel)) continue;
    const young: { name: string; daysBeforeRelease: number }[] = [];
    for (const name of v.added) {
      const first = firstPublished(name);
      if (first === undefined) continue;
      const days = first === null ? 0 : Math.floor((rel - first) / 86_400_000);
      if (first === null || days <= YOUNG_DEPENDENCY_DAYS) young.push({ name, daysBeforeRelease: days });
    }
    v.young = young;
  }
}

/** Runtime/optional dependency names present in `version` but not in `baseVersion`. */
export function addedDependencies(p: Packument, version: string, baseVersion: string): string[] {
  const base = dependencyNames(manifest(p, baseVersion));
  return [...dependencyNames(manifest(p, version))].filter((d) => !base.has(d)).sort();
}

/**
 * publisher_change: the account that published `version` first published this
 * package recently (within `windowDays` before `version`), after other accounts
 * had published it. Returns undefined when the publisher is the original one,
 * when the change is outside the window, or when the new version was published
 * via npm trusted publishing (an OIDC CI identity, not a person's account).
 */
export function derivePublisherChange(
  history: readonly VersionRecord[],
  version: string,
  p: Packument,
  windowDays = 365,
): NpmPublisherChangeValue | undefined {
  const idx = history.findIndex((h) => h.version === version);
  const scanned = history[idx];
  if (!scanned?.publisher || scanned.trustedPublisher) return undefined;
  const firstIdx = history.findIndex((h, i) => i <= idx && h.publisher === scanned.publisher);
  if (firstIdx <= 0) return undefined;
  const first = history[firstIdx]!;
  const before = history.slice(0, firstIdx).filter((h) => h.publisher);
  const prev = before[before.length - 1];
  if (!prev?.publisher) return undefined;
  const daysBeforeRelease = daysBetween(first.publishedMs, scanned.publishedMs);
  if (daysBeforeRelease > windowDays) return undefined;
  const previousPublishers = [...new Set(before.map((h) => h.publisher!))];
  return {
    version: first.version,
    previousVersion: prev.version,
    previousPublisher: prev.publisher,
    newPublisher: scanned.publisher,
    changedAt: first.publishedAt,
    // Contract (core/types PublisherChangeValue): had newPublisher published this package before the
    // change? `first` is that account's first release, so by construction it had not.
    firstTimePublisher: !previousPublishers.includes(scanned.publisher),
    scannedVersion: scanned.version,
    firstSeenVersion: first.version,
    daysBeforeRelease,
    previousPublishers,
    addedDependencies: addedDependencies(p, scanned.version, prev.version),
  };
}

/**
 * maintainer_change from per-version `maintainers` lists: every point at or before `version`
 * (within `windowDays`) where the maintainer set differs from the previous version that recorded
 * one. Most recent first. `daysBeforeRelease` = days from the version where the change was observed
 * to the scanned version.
 *
 * Tier 0.5: a release published through npm trusted publishing stores whatever list the OIDC
 * publish wrote (mongodb-connection-string-url 7.0.2 stored 3 of its 8 maintainers, which read as
 * "removed devtoolsbot, added dariakp"), so those lists are never compared. With `current` (the
 * packument's own `maintainers`, when it describes the scan's point in time) an "added" account
 * must still maintain the package and a "removed" one must no longer; an account that published a
 * later release (`_npmUser`) was not removed.
 */
export function deriveMaintainerChanges(
  history: readonly VersionRecord[],
  version: string,
  windowDays = 365,
  max = 5,
  current?: readonly string[],
): NpmMaintainerChangeValue[] {
  const idx = history.findIndex((h) => h.version === version);
  const scanned = history[idx];
  if (!scanned) return [];
  const upTo = history.slice(0, idx + 1);
  const known = upTo.filter((h) => h.maintainers && !h.trustedPublisher);
  const now = current ? new Set(current) : undefined;
  const out: NpmMaintainerChangeValue[] = [];
  for (let i = known.length - 1; i >= 1 && out.length < max; i--) {
    const cur = known[i]!;
    const days = daysBetween(cur.publishedMs, scanned.publishedMs);
    if (days > windowDays) break;
    const prevSet = new Set(known[i - 1]!.maintainers);
    const curSet = new Set(cur.maintainers);
    const laterPublishers = new Set(upTo.filter((h) => h.publishedMs >= cur.publishedMs && h.publisher).map((h) => h.publisher!));
    const added = [...curSet].filter((m) => !prevSet.has(m) && (!now || now.has(m))).sort();
    const removed = [...prevSet].filter((m) => !curSet.has(m) && (!now || !now.has(m)) && !laterPublishers.has(m)).sort();
    if (added.length === 0 && removed.length === 0) continue;
    out.push({ added, removed, changedAt: cur.publishedAt, version: cur.version, daysBeforeRelease: days, via: 'version-history' });
  }
  return out;
}

/**
 * The packument's current maintainer names when they describe the scan's point in time: the
 * packument was last modified at or before `now` (a live scan). A replay in the past (backtests,
 * --as-of) gets undefined: today's list is not what the registry said then.
 */
export function currentMaintainersAt(p: Packument, now: Date): string[] | undefined {
  const modified = isObject(p.time) ? parseTime(p.time.modified) : undefined;
  if (modified === undefined || modified > now.getTime() + DAY_MS) return undefined;
  const list = parseMaintainers(p.maintainers);
  return list && list.length > 0 ? list.map((m) => m.name) : undefined;
}

/**
 * The release `version` most plausibly follows: the newest version published before it that is
 * lower in semver order (so a 0.7.x patch is not compared with a 0.8.0 published in between).
 */
export function previousRelease(history: readonly VersionRecord[], version: string): VersionRecord | undefined {
  const idx = history.findIndex((h) => h.version === version);
  if (idx <= 0) return undefined;
  for (let i = idx - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.publishedMs < history[idx]!.publishedMs && compareVersions(h.version, version) < 0) return h;
  }
  return undefined;
}

/** True for a prerelease or build-tagged version (4.23.0-nightly-…, 7.17.1-alpha.9, 1.0.0-rc.1). */
export function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version) || !/^\d+\.\d+\.\d+(\+.*)?$/.test(version);
}

/** Release line: the major for 1.x and later, major.minor for 0.x (semver: 0.x minors may break). */
export function releaseLine(version: string): string | undefined {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (!m) return undefined;
  return m[1] === '0' ? `0.${m[2]}` : m[1];
}

/**
 * The release a stable version's provenance is compared with (Tier 0.5): the newest earlier
 * STABLE release of the same release line. Prereleases and nightlies are built by other pipelines
 * (typescript-eslint's canaries and react-native-screens' nightlies carry provenance, their stable
 * releases did not), so a stable release is never compared with one, and a prerelease is never
 * compared at all. Undefined when there is no such release.
 */
export function previousStableOnLine(history: readonly VersionRecord[], version: string): VersionRecord | undefined {
  if (isPrerelease(version)) return undefined;
  const line = releaseLine(version);
  const idx = history.findIndex((h) => h.version === version);
  if (idx <= 0 || line === undefined) return undefined;
  for (let i = idx - 1; i >= 0; i--) {
    const h = history[i]!;
    if (isPrerelease(h.version) || releaseLine(h.version) !== line) continue;
    if (h.publishedMs < history[idx]!.publishedMs && compareVersions(h.version, version) < 0) return h;
  }
  return undefined;
}

export function deriveProvenance(m: NpmVersionManifest | undefined): ProvenanceValue {
  const att = isObject(m?.dist) && isObject(m.dist.attestations) ? m.dist.attestations : undefined;
  if (!att) return { hasProvenance: false };
  const predicate = isObject(att.provenance) ? str(att.provenance.predicateType, 300) : undefined;
  const value: ProvenanceValue = { hasProvenance: true, type: 'npm-attestation' };
  if (predicate) {
    const slsa = /^https:\/\/slsa\.dev\/provenance\/v(\d+(?:\.\d+)?)$/.exec(predicate);
    if (slsa) value.type = slsa[1] === '1' ? 'slsa-v1' : `slsa-v${slsa[1]}`;
  }
  const url = str(att.url, 2048);
  if (url?.startsWith('https://')) value.url = url;
  return value;
}

export function deriveReleaseAge(p: Packument, version: string, now: Date): ReleaseAgeValue | undefined {
  const time = isObject(p.time) ? p.time : {};
  const publishedMs = parseTime(time[version]);
  if (publishedMs === undefined) return undefined;
  const nowMs = now.getTime();
  const value: ReleaseAgeValue = {
    version,
    publishedAt: new Date(publishedMs).toISOString(),
    ageDays: Math.max(0, daysBetween(publishedMs, nowMs)),
  };
  const history = versionHistory(p, now);
  const tags = isObject(p['dist-tags']) ? p['dist-tags'] : {};
  let latest = str(tags.latest, 256);
  if (!latest || !history.some((h) => h.version === latest)) {
    // dist-tag points to a version after `now` (backtest) or is missing: newest stable release instead.
    latest = [...history].reverse().find((h) => !h.version.includes('-'))?.version;
  }
  const latestRec = history.find((h) => h.version === latest);
  if (latestRec) {
    value.latestVersion = latestRec.version;
    value.latestPublishedAt = latestRec.publishedAt;
  }
  const newest = history[history.length - 1];
  if (newest) value.daysSinceLatestRelease = Math.max(0, daysBetween(newest.publishedMs, nowMs));
  // Finished / low-surface inputs (P3): the first release, and the stable releases in the final
  // year of the history (a burst of releases right before it stopped is churn, not a finished package).
  if (history[0]) value.firstPublishedAt = history[0].publishedAt;
  const stable = history.filter((h) => !h.version.includes('-'));
  const lastStable = stable[stable.length - 1];
  if (lastStable) value.releasesInFinalYear = stable.filter((h) => h.publishedMs > lastStable.publishedMs - 365 * DAY_MS).length;
  const deprecated = str(manifest(p, version)?.deprecated, 500);
  if (deprecated) value.deprecated = deprecated;
  const latestDeprecated = latestRec ? str(manifest(p, latestRec.version)?.deprecated, 500) : undefined;
  if (latestDeprecated) value.latestDeprecated = latestDeprecated;
  // Moved-repo check (Tier 0): the repository this version declares, and the one the latest release declares.
  const inUseRepo = repoFromManifestField(manifest(p, version)?.repository);
  if (inUseRepo) value.repository = { url: inUseRepo.url, ...(inUseRepo.directory ? { directory: inUseRepo.directory } : {}) };
  const latestRepo = latestRec ? repoFromManifestField(manifest(p, latestRec.version)?.repository) : undefined;
  if (latestRepo) value.latestRepository = { url: latestRepo.url, ...(latestRepo.directory ? { directory: latestRepo.directory } : {}) };
  return value;
}

/**
 * package_size from the registry's `dist.unpackedSize` / `dist.fileCount` of `version` (both
 * needed), or from a tarball footprint read by the caller. Undefined when neither is known.
 */
export function packageSize(p: Packument, version: string, tarball?: { unpackedSize: number; fileCount: number }): PackageSizeValue | undefined {
  const m = manifest(p, version);
  if (!m) return undefined;
  const dist = isObject(m.dist) ? m.dist : undefined;
  const size = dist?.unpackedSize;
  const files = dist?.fileCount;
  const dependencies = dependencyNames(m).size;
  if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && typeof files === 'number' && Number.isSafeInteger(files) && files >= 0) {
    return { version, unpackedSize: size, fileCount: files, dependencies, via: 'npm.dist' };
  }
  return tarball ? { version, unpackedSize: tarball.unpackedSize, fileCount: tarball.fileCount, dependencies, via: 'npm.tarball' } : undefined;
}

/**
 * Whether the size of a version without `dist.unpackedSize` is worth reading from its tarball: only
 * when the package has had no release for `inactiveMonths` (the finished / low-surface test applies
 * to inactive packages only).
 */
export function needsTarballSize(p: Packument, now: Date, inactiveMonths: number): boolean {
  const newest = versionHistory(p, now).at(-1);
  if (!newest) return false;
  return newest.publishedMs < addMonths(now, -inactiveMonths).getTime();
}

/** The tarball URL of `version` (registry `dist.tarball`), https only. */
export function tarballUrl(p: Packument, version: string): string | undefined {
  const m = manifest(p, version);
  const u = isObject(m?.dist) ? str(m.dist.tarball, 2048) : undefined;
  return u?.startsWith('https://') ? u : undefined;
}

/** The README status slimPackument derived (registry.ts), validated again (packuments are untrusted). */
function declaredStatusField(v: unknown): { status: 'deprecated' | 'unmaintained' | 'maintenance_mode'; phrase: string } | undefined {
  if (!isObject(v)) return undefined;
  const status = v.status;
  const phrase = str(v.phrase, 200);
  if ((status === 'deprecated' || status === 'unmaintained' || status === 'maintenance_mode') && phrase) return { status, phrase };
  return undefined;
}

export function packageName(p: Packument, fallback: string): string {
  return str(p.name, HANDLE_MAX) ?? fallback;
}

/**
 * All per-component facts derivable from a packument for one version.
 * Emits nothing version-specific if the version is absent (e.g. unpublished);
 * the caller decides whether to warn.
 */
export function packumentFacts(p: Packument, name: string, version: string, opts: PackumentFactOptions): Fact[] {
  const meta = (evidence: string[]) => ({ source: 'npm', fetchedAt: opts.fetchedAt ?? opts.now, evidence });
  const subject = npmPurl(name, version);
  const pkgSubject = npmPurl(name);
  const pkgPage = npmPackagePage(name);
  const versionPage = npmPackagePage(name, version);
  const windowDays = opts.changeWindowDays ?? 365;
  const facts: Fact[] = [];

  const topMaintainers = parseMaintainers(p.maintainers, opts.includeEmails);
  if (topMaintainers) {
    const value: MaintainersValue = { maintainers: topMaintainers, count: topMaintainers.length };
    const bots = topMaintainers.filter((m) => isReleaseBot(m.name)).length;
    if (bots > 0) value.releaseBots = bots;
    facts.push(makeFact('maintainers', pkgSubject, value, meta([pkgPage])));
  }

  // Stability inputs (plan S3, S4, S5a; P3): package-level, as of `now`, also when the version in
  // use is gone from the registry (event-stream 3.3.6 was unpublished).
  const asOfHistory = versionHistory(p, opts.now);
  const cadence = releaseCadence(asOfHistory, opts.now);
  if (cadence) facts.push(makeFact('release_cadence', pkgSubject, cadence, meta([pkgPage])));
  const publishers = releasePublishers(asOfHistory, opts.now);
  if (publishers) facts.push(makeFact('release_publishers', pkgSubject, publishers, meta([pkgPage])));
  const declared = declaredStatusField(p._declaredStatus);
  if (declared) facts.push(makeFact('declared_status', pkgSubject, { ...declared, via: 'npm.readme' }, meta([pkgPage])));

  const m = manifest(p, version);
  if (!m) {
    const repo = repoFromManifestField(p.repository);
    if (repo) facts.push(makeFact('repo', pkgSubject, { ...repo, via: 'npm.repository' }, meta([pkgPage])));
    return facts;
  }

  // Include the scanned version even if it is (oddly) newer than `now`.
  const history = versionHistory(p, new Date(Math.max(opts.now.getTime(), parseTime(p.time?.[version]) ?? 0)));
  const rec = history.find((h) => h.version === version);

  const user = isObject(m._npmUser) ? m._npmUser : undefined;
  const publisherName = str(user?.name, HANDLE_MAX);
  if (publisherName) {
    const value: PublisherValue = { name: publisherName, version };
    const email = str(user?.email, 254);
    if (opts.includeEmails && email) value.email = email;
    if (rec) value.publishedAt = rec.publishedAt;
    if (rec?.trustedPublisher) value.trustedPublisher = true;
    facts.push(makeFact('publisher', subject, value, meta([versionPage])));
  }

  const pubChange = derivePublisherChange(history, version, p, windowDays);
  if (pubChange) {
    const evidence = [versionPage, npmPackagePage(name, pubChange.firstSeenVersion), npmPackagePage(name, pubChange.previousVersion)];
    facts.push(makeFact('publisher_change', subject, pubChange, meta([...new Set(evidence)])));
  }

  for (const change of deriveMaintainerChanges(history, version, windowDays, opts.maxMaintainerChanges ?? 5, currentMaintainersAt(p, opts.now))) {
    facts.push(makeFact('maintainer_change', subject, change, meta([npmPackagePage(name, change.version)])));
  }

  const scripts = analyzeInstallScripts(m.scripts, { gypfile: m.gypfile === true, registryFlag: m.hasInstallScript === true });
  const prev = previousRelease(history, version);
  const prevManifest = prev ? manifest(p, prev.version) : undefined;
  if (prev && prevManifest) {
    markNewInstallHooks(scripts, analyzeInstallScripts(prevManifest.scripts, { gypfile: prevManifest.gypfile === true }), prev.version);
  }
  facts.push(makeFact('install_script', subject, scripts, meta([versionPage])));

  const added = prev && prevManifest && isPatchBump(prev.version, version) ? addedDependencies(p, version, prev.version) : [];
  if (prev && added.length > 0) {
    const value: DependencyAddedValue = { version, previousVersion: prev.version, added: added.slice(0, 20), young: [] };
    if (rec) value.releasedAt = rec.publishedAt;
    facts.push(makeFact('dependency_added', subject, value, meta([versionPage, npmPackagePage(name, prev.version)])));
  }

  const provenance = deriveProvenance(m);
  // Tier 0.5: stable to stable on the same release line only, and only when that earlier stable
  // release had provenance (a package that never had it on a stable release dropped nothing).
  const prevStable = previousStableOnLine(history, version);
  const prevStableManifest = prevStable ? manifest(p, prevStable.version) : undefined;
  if (!provenance.hasProvenance && prevStable && prevStableManifest && deriveProvenance(prevStableManifest).hasProvenance) provenance.droppedSince = prevStable.version;
  facts.push(makeFact('provenance', subject, provenance, meta(provenance.url ? [versionPage, provenance.url] : [versionPage])));

  const age = deriveReleaseAge(p, version, opts.now);
  if (age) facts.push(makeFact('release_age', subject, age, meta([versionPage])));

  const size = packageSize(p, version);
  if (size) facts.push(makeFact('package_size', subject, size, meta([versionPage])));

  const repo = repoFromManifestField(m.repository) ?? repoFromManifestField(p.repository);
  if (repo) {
    const value: RepoValue = { ...repo, via: 'npm.repository' };
    facts.push(makeFact('repo', pkgSubject, value, meta([versionPage])));
  }

  const funding = fundingFromManifestField(m.funding);
  if (funding.length > 0) {
    const value: FundingValue = { sources: funding, via: 'package.json#funding' };
    facts.push(makeFact('funding', pkgSubject, value, meta([versionPage])));
  }

  return facts;
}

/** Summary of a packument stored in snapshots (no e-mails, no READMEs). */
export interface PackumentSummary {
  name: string;
  maintainers: string[];
  distTags: Record<string, string>;
  latestVersion?: string;
  latestPublisher?: string;
  versionCount: number;
  modified?: string;
  repository?: string;
}

export function summarizePackument(p: Packument, name: string): PackumentSummary {
  const tags: Record<string, string> = {};
  if (isObject(p['dist-tags'])) {
    for (const [k, v] of Object.entries(p['dist-tags']).slice(0, 50)) if (typeof v === 'string' && k.length <= 64) tags[k] = v.slice(0, 256);
  }
  const versions = isObject(p.versions) ? p.versions : {};
  const summary: PackumentSummary = {
    name: packageName(p, name),
    maintainers: (parseMaintainers(p.maintainers) ?? []).map((m) => m.name).sort(),
    distTags: tags,
    versionCount: Object.keys(versions).length,
  };
  const latest = tags.latest;
  if (latest) {
    summary.latestVersion = latest;
    const pub = str(manifest(p, latest)?._npmUser?.name, HANDLE_MAX);
    if (pub) summary.latestPublisher = pub;
  }
  const modified = isObject(p.time) ? str(p.time.modified, 64) : undefined;
  if (modified) summary.modified = modified;
  const repo = repoFromManifestField(p.repository);
  if (repo) summary.repository = repo.url;
  return summary;
}
