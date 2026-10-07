/**
 * Shared as-of feature module (docs/DATA-ML.md §2.4). One pure function turns a packument and a
 * release into a fixed-order numeric feature vector. The bootstrap uses it (through the features
 * CLI) to build the training set, and scan time uses it to score, so the two can never drift.
 *
 * No leakage: only data that existed at `asOf` is read.
 *   - Versions (and `time` entries) published after `asOf` are invisible.
 *   - Every feature describes the release relative to the history before it, so a vector computed
 *     right after the release equals the one computed a year later (no "age since release").
 *   - Packument-level fields that describe today (top-level `maintainers`, `dist-tags`,
 *     `time.modified`, `readme`) are never read: per-version manifests are used instead.
 *   - Manifest fields that npm or the author can change after publishing (`deprecated`) and the
 *     registry's own `hasInstallScript` flag are never read; neither are replay notes (`_replay`).
 *   - Whether a version still has a manifest today (npm unpublishes malware) is never used.
 * Unknown values are NaN (LightGBM routes them with the split's learnt default direction).
 */
import { isObject } from '../enrich/npm/registry.js';
import { compareVersions, deriveProvenance, isPatchBump, parseMaintainers, YOUNG_DEPENDENCY_DAYS } from '../enrich/npm/packument.js';
import { analyzeInstallScripts } from '../enrich/npm/scripts.js';
import type { NpmVersionManifest, Packument } from '../enrich/npm/types.js';
import { RISKY_INSTALL_SCRIPT_FLAGS } from '../core/install-flags.js';

/** Bump when a feature's meaning or order changes; a model trained on another version is rejected. */
export const FEATURE_SCHEMA = 'blastradius-features/v1';

/** Feature order is part of the contract with the exported model. Append only. */
export const FEATURE_NAMES = [
  // Release history (from the `time` map, so unpublished versions still count as releases).
  'prior_releases',
  'package_age_days',
  'days_since_prev_release',
  'median_gap_days_prior',
  'gap_ratio',
  'releases_prior_365d',
  'releases_prev_24h',
  'majors_released_24h',
  'is_backport',
  'bump_kind',
  'is_prerelease',
  // Who published it.
  'publisher_prior_releases',
  'publisher_first_release',
  'publisher_tenure_days',
  'publisher_differs_prev',
  'distinct_publishers_prior',
  'days_since_new_publisher',
  // How it was published.
  'trusted_publisher',
  'prev_trusted_publisher',
  'trusted_share_prior',
  'has_provenance',
  'prev_has_provenance',
  'provenance_share_prior',
  // Maintainer list recorded in the release manifests.
  'maintainers_count',
  'maintainers_added_vs_prev',
  'maintainers_removed_vs_prev',
  'days_since_maintainer_change',
  // Install scripts.
  'install_hooks',
  'new_install_hooks',
  'prev_install_hooks',
  'install_flags_risky',
  'install_script_share_prior',
  // Dependencies.
  'deps_count',
  'deps_added',
  'deps_removed',
  'young_deps_added',
  // Optional external facts (deps.dev / Scorecard / downloads); NaN when not supplied.
  'scorecard_score',
  'dependents_log10',
  'downloads_trend',
  'typosquat_distance',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number>;

export interface FeatureExtras {
  /**
   * First release time (ms) of another package as of `asOf`: null when it had no release by then,
   * undefined when unknown. Enables `young_deps_added`.
   */
  firstPublished?: (name: string) => number | null | undefined;
  /** Facts that must themselves be as of `asOf` (the caller's responsibility). */
  scorecardScore?: number;
  dependents?: number;
  /** Recent weekly downloads divided by the trailing average (as of `asOf`). */
  downloadsTrend?: number;
  /** Popular package names for the typosquat distance (the package's own name is skipped). */
  popularNames?: readonly string[];
}

const DAY = 86_400_000;
/** "Prior" shares look at this many most recent earlier releases. */
const SHARE_WINDOW = 10;
const MAX_VERSIONS = 20_000;

interface Release {
  version: string;
  ms: number;
  manifest?: NpmVersionManifest;
}

function str(v: unknown, max = 214): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

/** Version keys of the `time` map, published at or before `limit`, oldest first. */
function timeline(p: Packument, limit: number): Release[] {
  const time = isObject(p.time) ? p.time : {};
  const versions = isObject(p.versions) ? p.versions : {};
  const out: Release[] = [];
  for (const [version, t] of Object.entries(time).slice(0, MAX_VERSIONS + 3)) {
    if (version === 'created' || version === 'modified' || version === 'unpublished') continue;
    const ms = typeof t === 'string' ? Date.parse(t) : NaN;
    if (!Number.isFinite(ms) || ms > limit) continue;
    const m = Object.hasOwn(versions, version) && isObject(versions[version]) ? (versions[version] as NpmVersionManifest) : undefined;
    out.push(m ? { version, ms, manifest: m } : { version, ms });
  }
  out.sort((a, b) => a.ms - b.ms || compareVersions(a.version, b.version));
  return out;
}

function publisherOf(m: NpmVersionManifest | undefined): string | undefined {
  return isObject(m?._npmUser) ? str(m._npmUser.name) : undefined;
}

function trustedOf(m: NpmVersionManifest | undefined): number {
  if (!m) return NaN;
  const tp = isObject(m._npmUser) ? m._npmUser.trustedPublisher : undefined;
  return tp !== undefined && tp !== null ? 1 : 0;
}

function provenanceOf(m: NpmVersionManifest | undefined): number {
  return m ? (deriveProvenance(m).hasProvenance ? 1 : 0) : NaN;
}

function maintainersOf(m: NpmVersionManifest | undefined): string[] | undefined {
  const list = parseMaintainers(m?.maintainers);
  return list && list.length > 0 ? list.map((x) => x.name) : undefined;
}

function hooksOf(m: NpmVersionManifest | undefined) {
  return analyzeInstallScripts(m?.scripts, { gypfile: m?.gypfile === true });
}

function depNames(m: NpmVersionManifest | undefined): Set<string> {
  const out = new Set<string>();
  for (const field of [m?.dependencies, m?.optionalDependencies]) {
    if (!isObject(field)) continue;
    for (const k of Object.keys(field).slice(0, 5000)) if (k.length <= 214) out.add(k);
  }
  return out;
}

function major(v: string): number {
  const n = Number.parseInt(v.split('.')[0] ?? '', 10);
  return Number.isFinite(n) ? n : NaN;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function share(rs: readonly Release[], f: (m: NpmVersionManifest) => number): number {
  const known = rs.filter((r) => r.manifest).slice(-SHARE_WINDOW);
  if (known.length === 0) return NaN;
  return known.reduce((n, r) => n + f(r.manifest!), 0) / known.length;
}

/** 0 = first release, 1 = patch, 2 = minor, 3 = major, 4 = prerelease or unparseable, relative to `prev`. */
function bumpKind(prev: string | undefined, version: string): number {
  if (!prev) return 0;
  if (version.includes('-')) return 4;
  if (isPatchBump(prev, version)) return 1;
  const a = /^(\d+)\.(\d+)\.(\d+)/.exec(prev);
  const b = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!a || !b) return 4;
  return a[1] !== b[1] ? 3 : 2;
}

/** Bounded Levenshtein distance (returns max+1 when larger). Names are at most 214 chars. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return Math.min(prev[b.length]!, max + 1);
}

const RISKY = new Set<string>(RISKY_INSTALL_SCRIPT_FLAGS);

/**
 * Feature vector for `name@version` as of `asOf`. Returns undefined when the release is not
 * visible at `asOf` (published later, or no manifest to describe it).
 */
export function featuresAsOf(p: Packument, name: string, version: string, asOf: Date, extras: FeatureExtras = {}): FeatureVector | undefined {
  const limit = asOf.getTime();
  if (!Number.isFinite(limit)) return undefined;
  const all = timeline(p, limit);
  const idx = all.findIndex((r) => r.version === version);
  const cur = all[idx];
  if (!cur?.manifest) return undefined;
  const t = cur.ms;
  const prior = all.filter((r, i) => i !== idx && r.ms <= t && (r.ms < t || i < idx));
  const priorKnown = prior.filter((r) => r.manifest);
  // The release this one follows: newest earlier, semver-lower release with a manifest.
  const prev = [...priorKnown].reverse().find((r) => compareVersions(r.version, version) < 0);
  const m = cur.manifest;
  const f = Object.fromEntries(FEATURE_NAMES.map((n) => [n, NaN])) as FeatureVector;

  // --- Release history --------------------------------------------------------------------
  f.prior_releases = prior.length;
  f.package_age_days = prior.length ? (t - prior[0]!.ms) / DAY : 0;
  const last = prior[prior.length - 1];
  if (last) f.days_since_prev_release = (t - last.ms) / DAY;
  const gaps = prior.slice(1).map((r, i) => (r.ms - prior[i]!.ms) / DAY);
  f.median_gap_days_prior = median(gaps);
  if (Number.isFinite(f.days_since_prev_release) && Number.isFinite(f.median_gap_days_prior)) {
    f.gap_ratio = f.days_since_prev_release / Math.max(f.median_gap_days_prior, 1 / 24);
  }
  f.releases_prior_365d = prior.filter((r) => r.ms >= t - 365 * DAY).length;
  const day = prior.filter((r) => r.ms >= t - DAY);
  f.releases_prev_24h = day.length;
  f.majors_released_24h = new Set([...day, cur].map((r) => major(r.version)).filter(Number.isFinite)).size;
  f.is_backport = prior.some((r) => !r.version.includes('-') && compareVersions(r.version, version) > 0) ? 1 : 0;
  f.bump_kind = bumpKind(prev?.version, version);
  f.is_prerelease = version.includes('-') ? 1 : 0;

  // --- Publisher --------------------------------------------------------------------------
  const pub = publisherOf(m);
  const withPub = priorKnown.filter((r) => publisherOf(r.manifest));
  const pubs = new Set(withPub.map((r) => publisherOf(r.manifest)!));
  f.distinct_publishers_prior = pubs.size;
  if (pub) {
    const mine = withPub.filter((r) => publisherOf(r.manifest) === pub);
    f.publisher_prior_releases = mine.length;
    f.publisher_first_release = withPub.length > 0 && mine.length === 0 ? 1 : 0;
    f.publisher_tenure_days = mine.length ? (t - mine[0]!.ms) / DAY : 0;
    const before = withPub[withPub.length - 1];
    if (before) f.publisher_differs_prev = publisherOf(before.manifest) === pub ? 0 : 1;
  }
  // Most recent release that was some account's first release of this package (after the very first).
  const seen = new Set<string>();
  let newPublisherAt: number | undefined;
  for (const r of [...withPub, ...(pub ? [cur] : [])]) {
    const who = publisherOf(r.manifest)!;
    if (!seen.has(who)) {
      if (seen.size > 0) newPublisherAt = r.ms;
      seen.add(who);
    }
  }
  if (newPublisherAt !== undefined) f.days_since_new_publisher = (t - newPublisherAt) / DAY;

  // --- Publish method ---------------------------------------------------------------------
  f.trusted_publisher = trustedOf(m);
  f.prev_trusted_publisher = trustedOf(prev?.manifest);
  f.trusted_share_prior = share(prior, (x) => trustedOf(x));
  f.has_provenance = provenanceOf(m);
  f.prev_has_provenance = provenanceOf(prev?.manifest);
  f.provenance_share_prior = share(prior, (x) => provenanceOf(x));

  // --- Maintainers ------------------------------------------------------------------------
  const maint = maintainersOf(m);
  if (maint) f.maintainers_count = maint.length;
  const prevMaint = maintainersOf(prev?.manifest);
  if (maint && prevMaint) {
    f.maintainers_added_vs_prev = maint.filter((x) => !prevMaint.includes(x)).length;
    f.maintainers_removed_vs_prev = prevMaint.filter((x) => !maint.includes(x)).length;
  }
  const lists = [...priorKnown, cur].map((r) => ({ ms: r.ms, list: maintainersOf(r.manifest) })).filter((x) => x.list);
  for (let i = lists.length - 1; i >= 1; i--) {
    const a = new Set(lists[i - 1]!.list);
    const b = new Set(lists[i]!.list);
    if (a.size !== b.size || [...b].some((x) => !a.has(x))) {
      f.days_since_maintainer_change = (t - lists[i]!.ms) / DAY;
      break;
    }
  }

  // --- Install scripts --------------------------------------------------------------------
  const hooks = hooksOf(m);
  f.install_hooks = hooks.hooks.length;
  f.install_flags_risky = (hooks.flags ?? []).filter((x) => RISKY.has(x)).length;
  if (prev?.manifest) {
    const ph = hooksOf(prev.manifest);
    f.prev_install_hooks = ph.hooks.length;
    f.new_install_hooks = hooks.hooks.filter((h) => !ph.hooks.includes(h)).length;
  }
  f.install_script_share_prior = share(prior, (x) => (hooksOf(x).hooks.length > 0 ? 1 : 0));

  // --- Dependencies -----------------------------------------------------------------------
  const deps = depNames(m);
  f.deps_count = deps.size;
  if (prev?.manifest) {
    const pd = depNames(prev.manifest);
    const added = [...deps].filter((d) => !pd.has(d));
    f.deps_added = added.length;
    f.deps_removed = [...pd].filter((d) => !deps.has(d)).length;
    if (extras.firstPublished) {
      let known = 0;
      let young = 0;
      for (const d of added) {
        const first = extras.firstPublished(d);
        if (first === undefined) continue;
        known++;
        if (first === null || first > t || (t - first) / DAY <= YOUNG_DEPENDENCY_DAYS) young++;
      }
      f.young_deps_added = added.length === 0 ? 0 : known === 0 ? NaN : young;
    }
  }

  // --- Optional external facts ------------------------------------------------------------
  if (typeof extras.scorecardScore === 'number' && Number.isFinite(extras.scorecardScore)) f.scorecard_score = extras.scorecardScore;
  if (typeof extras.dependents === 'number' && Number.isFinite(extras.dependents) && extras.dependents >= 0) f.dependents_log10 = Math.log10(1 + extras.dependents);
  if (typeof extras.downloadsTrend === 'number' && Number.isFinite(extras.downloadsTrend)) f.downloads_trend = extras.downloadsTrend;
  if (extras.popularNames && extras.popularNames.length > 0) {
    let best = 4;
    for (const other of extras.popularNames) if (other !== name) best = Math.min(best, editDistance(name, other, 3));
    f.typosquat_distance = best;
  }
  return f;
}

/** The vector as an array in FEATURE_NAMES order (the model's input). */
export function featureArray(f: FeatureVector): number[] {
  return FEATURE_NAMES.map((n) => f[n]);
}
