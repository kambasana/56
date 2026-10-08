/** `blastradius feeds sync` runner (kept out of cli.ts so node:sqlite loads only when used). */
import { resolve } from 'node:path';
import type { FeedsSyncCliOptions } from '../cli.js';
import { liveFetcher, offlineFetcher } from './fetcher.js';
import { FeedStore } from './store.js';
import { FEED_SOURCES, syncFeeds, type FeedSourceName } from './sync.js';

export async function runFeedsSync(o: FeedsSyncCliOptions, log: (m: string) => void) {
  const sources = o.sources
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sources) if (!(FEED_SOURCES as readonly string[]).includes(s)) throw new Error(`unknown source "${s}" (allowed: ${FEED_SOURCES.join(', ')})`);
  if (!/^[A-Za-z0-9.:-]{1,40}$/.test(o.ecosystem)) throw new Error(`bad ecosystem "${o.ecosystem}"`);
  const fetcher = o.offlineFrom ? offlineFetcher(resolve(o.offlineFrom)) : liveFetcher({ gitDir: resolve(o.gitDir ?? `${o.store}.git`) });
  const store = new FeedStore(o.store);
  try {
    const r = await syncFeeds(store, fetcher, {
      eco: o.ecosystem,
      outDir: o.out,
      sources: sources as FeedSourceName[],
      kbDir: o.kb,
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      osv: { useZip: o.zip },
      log,
    });
    return {
      ecosystem: r.eco,
      ms: r.ms,
      storeChanges: r.storeChanges,
      osv: r.osv,
      datadog: r.datadog,
      bkc: r.bkc,
      kb: r.kb,
      compile: r.compile,
      written: r.emit.written,
      pack: r.emit.packFile,
      listing: r.emit.listing,
    };
  } finally {
    store.close();
  }
}
