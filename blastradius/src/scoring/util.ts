import type { Reason } from '../core/types.js';

export const DAY_MS = 86_400_000;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Round to `digits` decimals (deterministic output, avoids float noise in reports). */
export function round(x: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Days from an ISO timestamp/date to `now`; undefined when unparsable. Negative values clamp to 0. */
export function daysSince(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, (now.getTime() - t) / DAY_MS);
}

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deduplicate + sort evidence URLs; keep only http(s) URLs, capped in length and count. */
export function cleanEvidence(urls: Iterable<string | undefined>, max = 20): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (typeof u !== 'string') continue;
    const s = u.trim();
    if (s.length === 0 || s.length > 2048 || !/^https?:\/\//i.test(s)) continue;
    out.add(s);
  }
  return [...out].sort(cmpStr).slice(0, max);
}

/** Truncate an untrusted string for use inside a `detail`. */
export function short(s: string, n = 120): string {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Noisy-OR over (weight, value) terms. Contributions are attributed in the order given
 * (callers sort by w·f desc) so they sum exactly to the combined value.
 */
export function noisyOr(terms: { weight: number; value: number }[]): { total: number; contributions: number[] } {
  let remaining = 1;
  const contributions: number[] = [];
  for (const t of terms) {
    const p = clamp01(t.weight * t.value);
    contributions.push(remaining * p);
    remaining *= 1 - p;
  }
  return { total: 1 - remaining, contributions };
}

export function sortReasons(reasons: Reason[]): Reason[] {
  return reasons.sort((a, b) => b.contribution - a.contribution || cmpStr(a.factor, b.factor) || cmpStr(a.detail, b.detail));
}
