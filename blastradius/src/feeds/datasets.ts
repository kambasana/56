/**
 * Snapshot sources read from git (docs/FEEDS-AND-DETECTORS.md §2.1):
 *
 * - Datadog malicious-software-packages-dataset, `samples/<eco>/manifest.json`:
 *   name → null (every version is malicious) or a list of compromised versions. Apache-2.0.
 * - Backstabber's Knife Collection, `data/packages.json`: ecosystem → package names. It carries
 *   no versions and lists compromised legitimate packages too (chalk, debug, event-stream are in
 *   it), so a name there is NOT evidence that every version is bad. It is stored as a
 *   lower-confidence label ("named in a known attack dataset") and never enters the match index.
 *
 * One store row per package name; the high-water mark is the commit. Re-running on the same
 * commit writes nothing; names that disappear become tombstones.
 */
import type { FeedFetcher } from './fetcher.js';
import { normTs, type FeedStore } from './store.js';

export const DATADOG_REPO = 'https://github.com/DataDog/malicious-software-packages-dataset.git';
export const BKC_REPO = 'https://github.com/dasfreak/Backstabbers-Knife-Collection.git';

export const datadogSource = (eco: string) => `datadog:${eco}`;
export const bkcSource = (eco: string) => `bkc:${eco}`;

export interface SnapshotStats {
  commit: string;
  /** False when the commit equals the stored mark (nothing read or written). */
  changed: boolean;
  entries: number;
  inserted: number;
  updated: number;
  withdrawn: number;
}

const NAME_RE = /^(@[a-z0-9][\w.-]*\/)?[\w.][\w.-]{0,213}$/i;
const VERSION_RE = /^[\w.+-]{1,128}$/;

/** Datadog manifest → name → null | sorted versions. Malformed entries are dropped. */
export function parseDatadogManifest(text: string): Map<string, string[] | null> {
  const doc = JSON.parse(text) as unknown;
  const out = new Map<string, string[] | null>();
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Datadog manifest: expected an object');
  for (const [name, v] of Object.entries(doc as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) continue;
    if (v === null) out.set(name, null);
    else if (Array.isArray(v)) {
      const vs = [...new Set(v.filter((x): x is string => typeof x === 'string' && VERSION_RE.test(x)))].sort();
      if (vs.length) out.set(name, vs);
    }
  }
  return out;
}

/** BKC packages.json → names for one ecosystem (BKC's keys: npm, pypi, gem, ...). */
export function parseBkcPackages(text: string, eco: string): string[] {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const list = doc && typeof doc === 'object' ? doc[eco.toLowerCase()] : undefined;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x): x is string => typeof x === 'string' && NAME_RE.test(x)))].sort();
}

function applySnapshot(store: FeedStore, source: string, commit: string, date: string, rows: Map<string, string>): SnapshotStats {
  const stats: SnapshotStats = { commit, changed: true, entries: rows.size, inserted: 0, updated: 0, withdrawn: 0 };
  const modified = normTs(date);
  store.tx(() => {
    for (const [id, json] of rows) {
      const r = store.upsert({ source, id, modified, json, relevant: true });
      if (r !== 'unchanged') stats[r]++;
    }
    store.touch(source, rows.keys());
    stats.withdrawn = store.tombstoneMissing(source, new Set(rows.keys()), modified);
    store.setMark(source, `${commit} ${modified}`);
  });
  return stats;
}

const unchanged = (store: FeedStore, source: string, commit: string): SnapshotStats | null =>
  store.getMark(source)?.split(' ')[0] === commit ? { commit, changed: false, entries: store.count(source).live, inserted: 0, updated: 0, withdrawn: 0 } : null;

export async function syncDatadog(store: FeedStore, fetcher: FeedFetcher, eco: string): Promise<SnapshotStats> {
  const source = datadogSource(eco);
  const f = await fetcher.gitFile(DATADOG_REPO, `samples/${eco.toLowerCase()}/manifest.json`);
  const same = unchanged(store, source, f.commit);
  if (same) return same;
  const rows = new Map<string, string>();
  for (const [name, versions] of parseDatadogManifest(f.text)) rows.set(name, JSON.stringify({ name, versions }));
  return applySnapshot(store, source, f.commit, f.date, rows);
}

export async function syncBkc(store: FeedStore, fetcher: FeedFetcher, eco: string): Promise<SnapshotStats> {
  const source = bkcSource(eco);
  const f = await fetcher.gitFile(BKC_REPO, 'data/packages.json');
  const same = unchanged(store, source, f.commit);
  if (same) return same;
  const rows = new Map<string, string>();
  for (const name of parseBkcPackages(f.text, eco)) rows.set(name, JSON.stringify({ name }));
  return applySnapshot(store, source, f.commit, f.date, rows);
}
