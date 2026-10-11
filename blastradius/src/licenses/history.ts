/**
 * Licence changes across a package's release history (docs/WHO-BEHIND-PLAN.md L2).
 *
 * Input: every release with its declared licences (deps.dev GetVersionBatch). Releases are put in
 * version order (numeric dot segments, the precedence semver and Maven share for plain releases;
 * pre-releases are left out), and each release with a known licence is compared with the
 * previous release with a known licence. Releases without licence data are gaps, never changes.
 * Two declarations are the same when their sorted sets of normalised SPDX expressions are equal,
 * so a re-ordered list ("Elastic-2.0, SSPL-1.0" vs "SSPL-1.0, Elastic-2.0") is not a change.
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

/** Every licence change in version order (oldest first). */
export function detectLicenseChanges(releases: readonly ReleaseLicense[]): LicenseChangeValue[] {
  const out: LicenseChangeValue[] = [];
  let prev: { r: ReleaseLicense; v: { list: string[]; key: string } } | undefined;
  let gap = 0;
  const categoryOf = (r: ReleaseLicense): LicenseCategory =>
    r.status === 'unlicensed' ? 'proprietary' : r.status === 'spdx' || r.status === 'corrected' ? categoryOfSet(r.expressions) : 'unknown';
  for (const r of sortReleases(releases)) {
    const v = valueOf(r);
    if (!v) {
      if (prev) gap++;
      continue;
    }
    if (prev && prev.v.key !== v.key) {
      const before = new Set(prev.r.expressions.flatMap(licenseIds));
      const after = new Set(r.expressions.flatMap(licenseIds));
      const change: LicenseChangeValue = {
        version: r.version,
        previousVersion: prev.r.version,
        from: prev.v.list,
        to: v.list,
        fromStatus: prev.r.status,
        toStatus: r.status,
        fromCategory: categoryOf(prev.r),
        toCategory: categoryOf(r),
        added: [...after].filter((id) => !before.has(id)).sort(),
        removed: [...before].filter((id) => !after.has(id)).sort(),
      };
      if (r.publishedAt) change.date = r.publishedAt;
      if (gap > 0) change.unknownBetween = gap;
      out.push(change);
    }
    prev = { r, v };
    gap = 0;
  }
  return out;
}

/** True when a change moves between obligation categories (the plan's "category change"). */
export function isCategoryChange(c: Pick<LicenseChangeValue, 'fromCategory' | 'toCategory'>): boolean {
  return c.fromCategory !== c.toCategory;
}

/** Where a change sits relative to the version a project uses. */
export function changeRelation(change: Pick<LicenseChangeValue, 'version'>, inUse: string): 'in_use_or_earlier' | 'after_in_use' | 'unknown' {
  const c = releaseSegments(change.version);
  const u = releaseSegments(inUse);
  if (!c || !u) return 'unknown';
  return compareReleases(c, u) <= 0 ? 'in_use_or_earlier' : 'after_in_use';
}

export type { LicenseCategory };
