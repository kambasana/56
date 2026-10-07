/**
 * As-of download features from a daily download series (api.npmjs.org/downloads/range). The
 * series is history, so a release in 2019 gets the downloads of the weeks before it, not today's.
 *
 * Window (no hindsight): npm publishes a day's count after the day ends, so at release + 1 h the
 * count for the release day and possibly the day before may not exist yet. The last day used is
 * the release's UTC day minus 2.
 *   weekly = sum of the 7 days ending there (all 7 must be known)
 *   trend  = weekly / mean weekly sum of the 12 weeks before that (all 84 days known, mean > 0)
 * Missing data gives undefined (NaN in the vector), never zero.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 86_400_000;
export const DOWNLOADS_LAG_DAYS = 2;
const TRAILING_WEEKS = 12;

/** Daily counts from `from` (YYYY-MM-DD, UTC) onwards; null for a day with no data. */
export interface DownloadSeries {
  from: string;
  counts: (number | null)[];
}

function sum(s: DownloadSeries, start: number, end: number): number | undefined {
  // [start, end] inclusive, as day indexes into s.counts
  if (start < 0 || end >= s.counts.length) return undefined;
  let n = 0;
  for (let i = start; i <= end; i++) {
    const c = s.counts[i];
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) return undefined;
    n += c;
  }
  return n;
}

export function downloadsAsOf(s: DownloadSeries | undefined, releaseMs: number): { weekly?: number; trend?: number } {
  if (!s || !Number.isFinite(releaseMs)) return {};
  const from = Date.parse(`${s.from}T00:00:00Z`);
  if (!Number.isFinite(from)) return {};
  const releaseDay = Math.floor(releaseMs / DAY) * DAY;
  const last = Math.round((releaseDay - from) / DAY) - DOWNLOADS_LAG_DAYS;
  const weekly = sum(s, last - 6, last);
  if (weekly === undefined) return {};
  const trailing = sum(s, last - 7 - 7 * TRAILING_WEEKS + 1, last - 7);
  const mean = trailing === undefined ? undefined : trailing / TRAILING_WEEKS;
  return mean && mean > 0 ? { weekly, trend: weekly / mean } : { weekly };
}

export function downloadsFile(dir: string, name: string): string {
  return join(dir, `${name.replace('/', '__')}.json`);
}

export function readDownloadSeries(dir: string, name: string): DownloadSeries | undefined {
  const f = downloadsFile(dir, name);
  if (!existsSync(f)) return undefined;
  try {
    const d = JSON.parse(readFileSync(f, 'utf8')) as Partial<DownloadSeries>;
    return typeof d.from === 'string' && Array.isArray(d.counts) ? { from: d.from, counts: d.counts } : undefined;
  } catch {
    return undefined;
  }
}
