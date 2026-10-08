/**
 * OSV sync for one ecosystem (docs/FEEDS-AND-DETECTORS.md §2.1).
 *
 * - Bootstrap (no high-water mark yet): read `<eco>/all.zip`; the mark becomes the newest
 *   `modified` in it. Without an all.zip (offline fixtures), the full `modified_id.csv` is walked.
 * - Incremental: read `<eco>/modified_id.csv` (`timestamp,id`, newest first) until the mark minus
 *   a small overlap, and fetch only `<eco>/<id>.json` for ids whose stored `modified` is older
 *   than the row. The overlap catches rows published to the CSV late; it costs no fetches, since
 *   ids already stored at that `modified` are skipped.
 * Cost is proportional to what changed, not to the size of the database.
 */
import { isMalwareAdvisory, type OsvRecord } from '../pack/build.js';
import type { FeedFetcher } from './fetcher.js';
import { normTs, type FeedStore, type UpsertResult } from './store.js';
import { zipEntries, zipRead } from './zip.js';

export const osvSource = (eco: string) => `osv:${eco}`;

export interface OsvSyncStats {
  mode: 'bootstrap-zip' | 'bootstrap-csv' | 'incremental';
  csvRowsRead: number;
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Records stored as withdrawn by this run (tombstones). */
  withdrawn: number;
  highWater: string | null;
  ms: number;
}

export interface OsvSyncOptions {
  /** CSV overlap behind the mark (default 2 h). */
  overlapMs?: number;
  concurrency?: number;
  log?: (m: string) => void;
  /** Bootstrap from all.zip (default true); false walks the whole CSV instead. */
  useZip?: boolean;
}

interface ParsedRecord {
  id: string;
  modified: string;
  withdrawnAt: string | null;
  relevant: boolean;
  json: string;
}

/** Parse one OSV record; null when it is not usable (no id/modified). */
export function parseOsvRecord(text: string, eco: string): ParsedRecord | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!rec || typeof rec.id !== 'string' || typeof rec.modified !== 'string') return null;
  let modified: string;
  let withdrawnAt: string | null = null;
  try {
    modified = normTs(rec.modified);
    if (typeof rec.withdrawn === 'string') withdrawnAt = normTs(rec.withdrawn);
  } catch {
    return null;
  }
  const affected = Array.isArray(rec.affected) ? (rec.affected as { package?: { ecosystem?: unknown } }[]) : [];
  const relevant = isMalwareAdvisory(rec as OsvRecord) && affected.some((a) => a?.package?.ecosystem === eco);
  // Canonical text (as parsed, re-serialised): the bulk export and single files may differ in
  // whitespace; the hash must not.
  return { id: rec.id, modified, withdrawnAt, relevant, json: JSON.stringify(rec) };
}

function tally(stats: OsvSyncStats, r: UpsertResult, p: ParsedRecord): void {
  stats[r]++;
  if (r !== 'unchanged' && p.withdrawnAt) stats.withdrawn++;
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

export async function syncOsv(store: FeedStore, fetcher: FeedFetcher, eco: string, opts: OsvSyncOptions = {}): Promise<OsvSyncStats> {
  const t0 = Date.now();
  const source = osvSource(eco);
  const log = opts.log ?? (() => {});
  let mark = store.getMark(source);
  const stats: OsvSyncStats = { mode: mark ? 'incremental' : 'bootstrap-csv', csvRowsRead: 0, fetched: 0, inserted: 0, updated: 0, unchanged: 0, withdrawn: 0, highWater: mark, ms: 0 };

  if (!mark && opts.useZip !== false) {
    const zip = await fetcher.osv(`${eco}/all.zip`);
    if (zip) {
      stats.mode = 'bootstrap-zip';
      log(`osv ${eco}: bootstrap from all.zip (${(zip.length / 1e6).toFixed(1)} MB)`);
      let newest = '';
      const entries = zipEntries(zip).filter((e) => e.name.endsWith('.json') && !e.name.includes('/'));
      for (let i = 0; i < entries.length; i += 5000) {
        store.tx(() => {
          for (const e of entries.slice(i, i + 5000)) {
            const bytes = zipRead(zip, e);
            const p = bytes && parseOsvRecord(bytes.toString('utf8'), eco);
            if (!p) continue;
            if (p.modified > newest) newest = p.modified;
            tally(stats, store.upsert({ source, ...p }), p);
          }
        });
      }
      if (newest) {
        mark = newest;
        store.setMark(source, newest);
      }
    }
  }

  // CSV pass: everything newer than (mark - overlap); the whole file when there is no mark.
  const stopAt = mark ? normTs(new Date(Date.parse(mark.slice(0, 23) + 'Z') - (opts.overlapMs ?? 2 * 3600_000)).toISOString()) : null;
  const todo: { id: string; ts: string }[] = [];
  let newestRow: string | null = null;
  for await (const line of fetcher.osvLines(`${eco}/modified_id.csv`)) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    let ts: string;
    try {
      ts = normTs(line.slice(0, comma));
    } catch {
      continue;
    }
    const id = line.slice(comma + 1).trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) continue;
    if (stopAt && ts < stopAt) break;
    stats.csvRowsRead++;
    if (!newestRow || ts > newestRow) newestRow = ts;
    const have = store.modifiedOf(source, id);
    if (have && have >= ts) continue;
    todo.push({ id, ts });
  }
  if (todo.length) log(`osv ${eco}: ${todo.length} changed record(s) to fetch`);
  const fetched: ParsedRecord[] = [];
  await pool(todo, opts.concurrency ?? 16, async ({ id }) => {
    const bytes = await fetcher.osv(`${eco}/${id}.json`);
    stats.fetched++;
    if (!bytes) return log(`osv ${eco}: ${id} listed but not found (skipped)`);
    const p = parseOsvRecord(bytes.toString('utf8'), eco);
    if (p && p.id === id) fetched.push(p);
  });
  // Apply in a fixed order so the store's history does not depend on fetch timing.
  fetched.sort((a, b) => a.id.localeCompare(b.id));
  store.tx(() => {
    for (const p of fetched) tally(stats, store.upsert({ source, ...p }), p);
  });
  const hw = [mark, newestRow].filter((x): x is string => !!x).sort().pop() ?? null;
  if (hw) store.setMark(source, hw);
  stats.highWater = hw;
  stats.ms = Date.now() - t0;
  return stats;
}
