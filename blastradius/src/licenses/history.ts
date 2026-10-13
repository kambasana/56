/**
 * Licence changes across a package's release history (docs/WHO-BEHIND-PLAN.md L2).
 *
 * Input: every release with its declared licences (deps.dev GetVersionBatch). Releases are put in
 * version order (numeric dot segments, the precedence semver and Maven share for plain releases;
 * pre-releases are left out), and each release with a known licence is compared with the
 * previous release with a known licence. Releases without licence data are gaps, never changes.
 * Two declarations are the same when their sorted sets of normalised SPDX expressions are equal,
 * so a re-ordered list ("Elastic-2.0, SSPL-1.0" vs "SSPL-1.0, Elastic-2.0") is not a change.
 * Gaps can be filled from a second declared source (the package registry's metadata); a change
 * still found across a gap is reported as a range, never pinned to the next release with data.
 */
import type { LicenseCategory, LicenseChangeValue, LicenseStatus } from '../core/types.js';
import { categoryOfSet } from './classify.js';
import { licenseIds } from './spdx.js';

export interface ReleaseLicense {
  version: string;
  publishedAt?: string;
  /** Normalised SPDX expressions (sorted). Empty with status unknown when the source had none. */
  expressions: string[];
  status: LicenseStatus;
  /** The author's strings (compared when there is no SPDX form). */
  raw?: string[];
  /** Source of the value when it is a gap fill (DetectOptions.fill), e.g. "registry". */
  source?: string;
}

const RELEASE_RE = /^v?(\d+(?:\.\d+)*)(?:[.-]?(?:final|release|ga))?$/i;

/** Numeric segments of a plain release ("v1.6.0" → [1,6,0]); undefined for pre-releases and pseudo-versions. */
export function releaseSegments(version: string): number[] | undefined {
  const m = RELEASE_RE.exec(version.trim());
  if (!m) return undefined;
  const parts = m[1]!.split('.').map(Number);
  return parts.every((n) => Number.isSafeInteger(n)) ? parts : undefined;
}

export function compareReleases(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Sort plain releases in version order (drops the rest). Stable for equal versions. */
export function sortReleases<T extends { version: string }>(list: readonly T[]): T[] {
  return list
    .map((r) => ({ r, seg: releaseSegments(r.version) }))
    .filter((x): x is { r: T; seg: number[] } => x.seg !== undefined)
    .sort((a, b) => compareReleases(a.seg, b.seg))
    .map((x) => x.r);
}

/**
 * The comparable value of a release: its SPDX expressions; or, when none of its licences has an
 * SPDX form, the author's strings (case and spacing folded), so "BSD" → "BSL-1.1" still shows.
 * Undefined when the release has no licence data (a gap).
 */
function valueOf(r: ReleaseLicense): { list: string[]; key: string } | undefined {
  if (r.expressions.length > 0 && (r.status === 'spdx' || r.status === 'corrected')) {
    const list = [...r.expressions].sort();
    return { list, key: `spdx:${list.join('\u0000')}` };
  }
  const raw = (r.raw ?? []).map((s) => s.trim()).filter(Boolean);
  if ((r.status === 'non_standard' || r.status === 'unlicensed' || r.status === 'see_file') && raw.length > 0) {
    const list = [...new Set(raw)].sort();
    return { list, key: `raw:${list.map((s) => s.toLowerCase().replace(/\s+/g, ' ')).join('\u0000')}` };
  }
  return undefined;
}

interface Known {
  r: ReleaseLicense;
  v: { list: string[]; key: string };
  /** Where the value comes from: the primary source's name, or the gap filler's source. */
  src: string;
  /** The value is a gap fill (DetectOptions.fill). */
  filled: boolean;
}

export interface DetectOptions {
  /**
   * Values from a second, declared source (e.g. the package registry's own metadata) used only
   * for releases the primary source has no licence data for. When two neighbouring values come
   * from different sources and differ, the fill's values for both releases are compared too: if
   * the fill states the same licence for both, it is a difference in how the two sources spell
   * it, not a change.
   */
  fill?: readonly ReleaseLicense[];
  /** Name of the primary source, recorded in `primary` (default "depsdev"). */
  primarySource?: string;
}

function categoryOf(r: ReleaseLicense): LicenseCategory {
  return r.status === 'unlicensed' ? 'proprietary' : r.status === 'spdx' || r.status === 'corrected' ? categoryOfSet(r.expressions) : 'unknown';
}

function scan(sequence: readonly (Known | undefined)[], fillBy: ReadonlyMap<string, Known>): LicenseChangeValue[] {
  const out: LicenseChangeValue[] = [];
  let prev: Known | undefined;
  let gap = 0;
  for (const cur of sequence) {
    if (!cur) {
      if (prev) gap++;
      continue;
    }
    // Same value, or (across sources) the fill states the same value for both releases.
    let same = !prev || prev.v.key === cur.v.key;
    if (prev && !same && prev.filled !== cur.filled) {
      const a = fillBy.get(prev.r.version);
      const b = fillBy.get(cur.r.version);
      if (a && b && a.v.key === b.v.key) same = true;
    }
    if (prev && !same) {
      const before = new Set(prev.r.expressions.flatMap(licenseIds));
      const after = new Set(cur.r.expressions.flatMap(licenseIds));
      const change: LicenseChangeValue = {
        version: cur.r.version,
        previousVersion: prev.r.version,
        from: prev.v.list,
        to: cur.v.list,
        fromStatus: prev.r.status,
        toStatus: cur.r.status,
        fromCategory: categoryOf(prev.r),
        toCategory: categoryOf(cur.r),
        added: [...after].filter((id) => !before.has(id)).sort(),
        removed: [...before].filter((id) => !after.has(id)).sort(),
      };
      if (cur.r.publishedAt) change.date = cur.r.publishedAt;
      if (gap > 0) change.unknownBetween = gap;
      if (prev.filled || cur.filled) {
        change.fromSource = prev.src;
        change.toSource = cur.src;
      }
      out.push(change);
    }
    prev = cur;
    gap = 0;
  }
  return out;
}

/**
 * Every licence change in version order (oldest first).
 *
 * A change found across releases without licence data is a range: it happened at some release
 * after `previousVersion`, up to and including `version`; `unknownBetween` says how many releases
 * in between had no data. It is never pinned to the first release that has data again.
 */
export function detectLicenseChanges(releases: readonly ReleaseLicense[], opts: DetectOptions = {}): LicenseChangeValue[] {
  const sorted = sortReleases(releases);
  const primaryName = opts.primarySource ?? 'depsdev';
  const known = (r: ReleaseLicense, src: string, filled: boolean): Known | undefined => {
    const v = valueOf(r);
    return v ? { r, v, src, filled } : undefined;
  };
  const primarySeq = sorted.map((r) => known(r, primaryName, false));
  const primary = scan(primarySeq, new Map());
  const fillBy = new Map<string, Known>();
  for (const f of opts.fill ?? []) {
    const k = known(f, f.source ?? 'fill', true);
    if (k && !fillBy.has(f.version)) fillBy.set(f.version, k);
  }
  if (fillBy.size === 0) return primary;
  const merged = scan(
    sorted.map((r, i) => {
      const p = primarySeq[i];
      if (p) return p;
      const f = fillBy.get(r.version);
      return f ? { ...f, r: { ...f.r, ...(r.publishedAt && !f.r.publishedAt ? { publishedAt: r.publishedAt } : {}) } } : undefined;
    }),
    fillBy,
  );
  // Where the fill placed a change, say how the primary source alone shows it (its range).
  for (const c of merged) {
    if (!c.fromSource) continue;
    const lo = releaseSegments(c.previousVersion);
    const hi = releaseSegments(c.version);
    const covering = primary.find((p) => {
      const pl = releaseSegments(p.previousVersion);
      const ph = releaseSegments(p.version);
      return !!lo && !!hi && !!pl && !!ph && compareReleases(pl, lo) <= 0 && compareReleases(ph, hi) >= 0;
    });
    if (covering && (covering.previousVersion !== c.previousVersion || covering.version !== c.version)) {
      c.primary = { source: primaryName, previousVersion: covering.previousVersion, version: covering.version, ...(covering.unknownBetween ? { unknownBetween: covering.unknownBetween } : {}) };
    }
  }
  return merged;
}

/** True when the change was found across releases without licence data (a range, not one release). */
export function isRangeChange(c: Pick<LicenseChangeValue, 'unknownBetween'>): boolean {
  return (c.unknownBetween ?? 0) > 0;
}

/**
 * Where a change happened, in words: "at 10.0.0 (previous release 9.1.2)" or, across releases
 * without data, "between 9.1.2 and 20.10.1; 7 releases in between had no licence data".
 */
export function describeChangePlacement(c: Pick<LicenseChangeValue, 'version' | 'previousVersion' | 'unknownBetween'>): string {
  const n = c.unknownBetween ?? 0;
  if (n > 0) return `changed between ${c.previousVersion} and ${c.version}; ${n} release${n === 1 ? '' : 's'} in between had no licence data`;
  return `changed at ${c.version} (previous release ${c.previousVersion})`;
}

/** True when a change moves between obligation categories (the plan's "category change"). */
export function isCategoryChange(c: Pick<LicenseChangeValue, 'fromCategory' | 'toCategory'>): boolean {
  return c.fromCategory !== c.toCategory;
}

/**
 * Where a change sits relative to the version a project uses. For a range change (releases
 * without licence data between `previousVersion` and `version`), a version in use inside the
 * range cannot be placed: it may or may not carry the new licence.
 */
export function changeRelation(
  change: Pick<LicenseChangeValue, 'version'> & Partial<Pick<LicenseChangeValue, 'previousVersion' | 'unknownBetween'>>,
  inUse: string,
): 'in_use_or_earlier' | 'after_in_use' | 'unknown' {
  const c = releaseSegments(change.version);
  const u = releaseSegments(inUse);
  if (!c || !u) return 'unknown';
  if (compareReleases(c, u) <= 0) return 'in_use_or_earlier';
  if (!isRangeChange(change) || change.previousVersion === undefined) return 'after_in_use';
  const p = releaseSegments(change.previousVersion);
  if (!p) return 'unknown';
  return compareReleases(u, p) <= 0 ? 'after_in_use' : 'unknown';
}

export type { LicenseCategory };
