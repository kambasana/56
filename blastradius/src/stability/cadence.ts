/**
 * S4 release regularity and the npm publisher timeline (S5a input), from a package's publish
 * history (npm `time` and `_npmUser`). Pure; used by the npm enricher (src/enrich/npm/packument.ts).
 *
 * S4 follows CHAOSS Release Frequency (https://chaoss.community/kb/metric-release-frequency/): the
 * median gap between the last 10 stable releases and the coefficient of variation of those gaps;
 * "irregular" when CV > 1.5 and the latest gap > 3 × the median (plan S4, STABILITY_RULES).
 */
import type { ReleaseCadenceValue, ReleasePublishersValue } from '../core/types.js';
import { STABILITY_RULES } from './rules.js';

const DAY_MS = 86_400_000;

/** The fields of a publish-history record these functions read (npm VersionRecord). */
export interface ReleaseRecord {
  version: string;
  publishedAt: string;
  publishedMs: number;
  publisher?: string;
  trustedPublisher: boolean;
}

const isPrerelease = (v: string) => v.includes('-');
const round2 = (n: number) => Math.round(n * 100) / 100;

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Coefficient of variation (population standard deviation / mean); 0 for an empty or all-zero list. */
export function coefficientOfVariation(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

/**
 * S4 over a publish history sorted oldest first (versions after `asOf` already removed).
 * Undefined below STABILITY_RULES.cadenceMinReleases stable releases.
 */
export function releaseCadence(history: readonly ReleaseRecord[], asOf: Date, isPre: (version: string) => boolean = isPrerelease): ReleaseCadenceValue | undefined {
  const R = STABILITY_RULES;
  const upTo = history.filter((h) => h.publishedMs <= asOf.getTime());
  const stable = upTo.filter((h) => !isPre(h.version));
  if (stable.length < R.cadenceMinReleases) return undefined;
  const last = stable.slice(-R.cadenceReleases);
  const gaps: number[] = [];
  for (let i = 1; i < last.length; i++) gaps.push((last[i]!.publishedMs - last[i - 1]!.publishedMs) / DAY_MS);
  const med = median(gaps);
  const cv = coefficientOfVariation(gaps);
  const latestGap = gaps[gaps.length - 1] ?? 0;
  const newest = upTo[upTo.length - 1]!;
  const lastStable = stable[stable.length - 1]!;
  return {
    releases: last.length,
    medianDays: round2(med),
    cv: round2(cv),
    latestGapDays: round2(latestGap),
    irregular: cv > R.irregularCv && latestGap > R.irregularGapFactor * med,
    dates: last.map((h) => h.publishedAt.slice(0, 10)),
    totalReleases: stable.length,
    lastRelease: { version: lastStable.version, date: lastStable.publishedAt.slice(0, 10) },
    daysSinceLastRelease: Math.max(0, Math.floor((asOf.getTime() - newest.publishedMs) / DAY_MS)),
  };
}

/** Per npm account: its first release, position and count (versions after `asOf` removed). */
export function releasePublishers(history: readonly ReleaseRecord[], asOf: Date): ReleasePublishersValue | undefined {
  const upTo = history.filter((h) => h.publishedMs <= asOf.getTime());
  if (upTo.length === 0) return undefined;
  const byName = new Map<string, ReleasePublishersValue['accounts'][number]>();
  upTo.forEach((h, index) => {
    if (!h.publisher) return;
    const a = byName.get(h.publisher);
    const stable = !isPrerelease(h.version);
    if (a) {
      a.releases++;
      if (stable && a.firstStableVersion === undefined) Object.assign(a, { firstStableVersion: h.version, firstStableAt: h.publishedAt, firstStableIndex: index });
      return;
    }
    byName.set(h.publisher, { name: h.publisher, firstVersion: h.version, firstAt: h.publishedAt, index, releases: 1, trusted: h.trustedPublisher, ...(stable ? { firstStableVersion: h.version, firstStableAt: h.publishedAt, firstStableIndex: index } : {}) });
  });
  const out: ReleasePublishersValue = { releases: upTo.length, accounts: [...byName.values()].sort((a, b) => a.index - b.index) };
  const trusted = upTo.filter((h) => h.trustedPublisher).map((h) => h.version);
  if (trusted.length) out.trustedVersions = trusted.slice(-500);
  const since = asOf.getTime() - 3 * 365 * DAY_MS;
  const recent = upTo.filter((h) => h.publisher && h.publishedMs >= since).slice(-500);
  if (recent.length) {
    out.publisherByVersion = Object.fromEntries(recent.map((h) => [h.version, h.publisher!]));
    out.publisherSince = recent[0]!.publishedAt.slice(0, 10);
  }
  return out;
}
