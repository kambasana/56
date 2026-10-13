/**
 * The hand-review sample (docs/WHO-BEHIND-PLAN.md §10 P3): 30 Fragile/Watch labels drawn at random,
 * with a fixed seed, from the production dependencies of the control repositories (one label per
 * package). The review itself (each fact checked against its primary source) is in the plan.
 */
import type { StabilityEntry, StabilityReport } from '../../src/core/types.js';

/** mulberry32: a small seeded PRNG, so the sample is the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const REVIEW_SEED = 20261011;
export const REVIEW_SIZE = 30;

/**
 * Unique production packages labelled Fragile or Watch, by name. Labels that only the Tier 0
 * no-clone fallback gives (watch_no_recent_release: these were Unknown in P3) are left out, so the
 * P3 sample and its hand review stay reproducible.
 */
export function reviewPopulation(reports: readonly { report: StabilityReport }[]): StabilityEntry[] {
  const byName = new Map<string, StabilityEntry>();
  const p3 = (p: StabilityEntry) => p.rules.some((r) => r.rule !== 'watch_no_recent_release');
  for (const r of reports) for (const p of r.report.packages) if (p.production && (p.label === 'fragile' || p.label === 'watch') && p3(p) && !byName.has(p.name)) byName.set(p.name, p);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Fisher–Yates with the seeded PRNG; the first `n`. */
export function reviewSample(population: readonly StabilityEntry[], n = REVIEW_SIZE, seed = REVIEW_SEED): StabilityEntry[] {
  const rnd = mulberry32(seed);
  const a = [...population];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, Math.min(n, a.length));
}
