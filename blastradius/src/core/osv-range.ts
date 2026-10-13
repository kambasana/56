/**
 * OSV affected-range semantics, shared by the knowledge pack (build and load), org-wide matching
 * and the replay recorder: affected from an "introduced" event up to (not including) the next
 * "fixed" or "limit", or up to and including a "last_affected"; an "introduced" with no end is open.
 * A "limit" is also an upper bound for the whole range: no version at or above it is affected
 * (OSV schema). Versions compare loosely (semver-like).
 */
import { compareVersions } from '../enrich/npm/packument.js';

export interface OsvRange {
  events?: Record<string, string>[];
}

export function inRanges(version: string, ranges: readonly OsvRange[]): boolean {
  const atLeast = (v: string, floor: string) => floor === '0' || compareVersions(v, floor) >= 0;
  for (const r of ranges) {
    const events = r.events ?? [];
    // Any limit caps the range: at or above it nothing is affected.
    if (events.some((e) => e.limit !== undefined && e.limit !== '*' && compareVersions(version, e.limit) >= 0)) continue;
    let open: string | null = null;
    for (const e of events) {
      if (e.introduced !== undefined) open = e.introduced;
      else if (open !== null && (e.fixed !== undefined || e.limit !== undefined)) {
        const end = (e.fixed ?? e.limit)!;
        if (atLeast(version, open) && (end === '*' || compareVersions(version, end) < 0)) return true;
        open = null;
      } else if (open !== null && e.last_affected !== undefined) {
        if (atLeast(version, open) && compareVersions(version, e.last_affected) <= 0) return true;
        open = null;
      }
    }
    if (open !== null && atLeast(version, open)) return true;
  }
  return false;
}

/** Every version: a range that starts at 0 and is never closed (a "*" limit closes nothing). */
export function coversAllVersions(ranges: readonly OsvRange[]): boolean {
  return ranges.some((r) => {
    const ev = r.events ?? [];
    return ev.some((e) => e.introduced === '0') && !ev.some((e) => 'fixed' in e || 'last_affected' in e || ('limit' in e && e.limit !== '*'));
  });
}
