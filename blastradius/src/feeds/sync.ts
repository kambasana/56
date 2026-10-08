/**
 * `blastradius feeds sync`: pull every known-bad source into the raw store, compile the match
 * index and emit the versioned pack with its listing (docs/FEEDS-AND-DETECTORS.md §2, step 1).
 */
import type { Incident } from '../core/types.js';
import { loadIncidents } from '../incidents/loader.js';
import { compileIndex, kbSnapshot, type CompileStats } from './compile.js';
import { syncBkc, syncDatadog, type SnapshotStats } from './datasets.js';
import { emitPack, type EmitResult } from './emit.js';
import type { FeedFetcher } from './fetcher.js';
import { syncOsv, type OsvSyncOptions, type OsvSyncStats } from './osv.js';
import type { FeedStore } from './store.js';

export const FEED_SOURCES = ['osv', 'datadog', 'bkc', 'kb'] as const;
export type FeedSourceName = (typeof FEED_SOURCES)[number];

export interface FeedSyncOptions {
  eco?: string;
  outDir: string;
  sources?: readonly FeedSourceName[];
  /** KB directory (curated incidents); omitted with the "kb" source off. */
  kbDir?: string;
  baseUrl?: string;
  osv?: OsvSyncOptions;
  log?: (m: string) => void;
}

export interface FeedSyncReport {
  eco: string;
  osv?: OsvSyncStats;
  datadog?: SnapshotStats;
  bkc?: SnapshotStats;
  kb?: { incidents: number; errors: number };
  compile: CompileStats & { ms: number };
  emit: EmitResult;
  /** Store rows written by this run (0 on a no-op re-run). */
  storeChanges: number;
  ms: number;
}

export async function syncFeeds(store: FeedStore, fetcher: FeedFetcher, opts: FeedSyncOptions): Promise<FeedSyncReport> {
  const t0 = Date.now();
  const eco = opts.eco ?? 'npm';
  const on = new Set(opts.sources ?? FEED_SOURCES);
  const log = opts.log ?? (() => {});
  const changes0 = store.totalChanges();
  const report: Partial<FeedSyncReport> = { eco };

  if (on.has('osv')) {
    report.osv = await syncOsv(store, fetcher, eco, { ...opts.osv, log });
    log(`osv ${eco}: ${report.osv.mode}, ${report.osv.inserted} new, ${report.osv.updated} updated, ${report.osv.fetched} fetched, ${report.osv.ms} ms`);
  }
  if (on.has('datadog')) {
    report.datadog = await syncDatadog(store, fetcher, eco);
    log(`datadog ${eco}: ${report.datadog.changed ? `${report.datadog.entries} entries` : 'unchanged'} at ${report.datadog.commit.slice(0, 12)}`);
  }
  if (on.has('bkc')) {
    report.bkc = await syncBkc(store, fetcher, eco);
    log(`bkc ${eco}: ${report.bkc.changed ? `${report.bkc.entries} names` : 'unchanged'} at ${report.bkc.commit.slice(0, 12)}`);
  }
  let incidents: Incident[] = [];
  if (on.has('kb') && opts.kbDir) {
    const kb = await loadIncidents(opts.kbDir);
    incidents = kb.incidents;
    report.kb = { incidents: kb.incidents.length, errors: kb.errors.length };
    if (kb.errors.length) log(`kb: ${kb.errors.length} invalid record(s) skipped`);
  }

  const tc = Date.now();
  const compiled = compileIndex(store, { eco, kbIncidents: incidents });
  report.compile = { ...compiled.stats, ms: Date.now() - tc };
  report.emit = await emitPack(opts.outDir, compiled.pack, { stats: compiled.stats, highWater: { ...store.marks(), ...(report.kb ? { kb: kbSnapshot(incidents) } : {}) }, newestModified: compiled.newestModified, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
  report.storeChanges = store.totalChanges() - changes0;
  report.ms = Date.now() - t0;
  return report as FeedSyncReport;
}
