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
  ReleaseAgeValue,
  DependencyAddedValue,
  RepoValue,
} from '../../core/types.js';
import { isObject, npmPackagePage } from './registry.js';
import { fundingFromManifestField, repoFromManifestField } from './repo.js';
import { analyzeInstallScripts, markNewInstallHooks } from './scripts.js';
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
 * maintainer_change from per-version `maintainers` lists: every point at or
 * before `version` (within `windowDays`) where the maintainer set differs from
 * the previous version that recorded one. Most recent first.
 * `daysBeforeRelease` = days from the version where the change was observed to the scanned version.
 */
export function deriveMaintainerChanges(
  history: readonly VersionRecord[],
  version: string,
  windowDays = 365,
  max = 5,
): NpmMaintainerChangeValue[] {
  const idx = history.findIndex((h) => h.version === version);
  const scanned = history[idx];
  if (!scanned) return [];
  const known = history.slice(0, idx + 1).filter((h) => h.maintainers);
  const out: NpmMaintainerChangeValue[] = [];
  for (let i = known.length - 1; i >= 1 && out.length < max; i--) {
    const cur = known[i]!;
    const days = daysBetween(cur.publishedMs, scanned.publishedMs);
    if (days > windowDays) break;
    const prevSet = new Set(known[i - 1]!.maintainers);
    const curSet = new Set(cur.maintainers);
    const added = [...curSet].filter((m) => !prevSet.has(m)).sort();
    const removed = [...prevSet].filter((m) => !curSet.has(m)).sort();
    if (added.length === 0 && removed.length === 0) continue;
    out.push({ added, removed, changedAt: cur.publishedAt, version: cur.version, daysBeforeRelease: days, via: 'version-history' });
  }
  return out;
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
  const deprecated = str(manifest(p, version)?.deprecated, 500);
  if (deprecated) value.deprecated = deprecated;
  return value;
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
    facts.push(makeFact('maintainers', pkgSubject, value, meta([pkgPage])));
  }

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

  for (const change of deriveMaintainerChanges(history, version, windowDays, opts.maxMaintainerChanges ?? 5)) {
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
    const value: DependencyAddedValue = { version, previousVersion: prev.version, added: added.slice(0, 20) };
    facts.push(makeFact('dependency_added', subject, value, meta([versionPage, npmPackagePage(name, prev.version)])));
  }

  const provenance = deriveProvenance(m);
  if (!provenance.hasProvenance && prev && prevManifest && deriveProvenance(prevManifest).hasProvenance) provenance.droppedSince = prev.version;
  facts.push(makeFact('provenance', subject, provenance, meta(provenance.url ? [versionPage, provenance.url] : [versionPage])));

  const age = deriveReleaseAge(p, version, opts.now);
  if (age) facts.push(makeFact('release_age', subject, age, meta([versionPage])));

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
