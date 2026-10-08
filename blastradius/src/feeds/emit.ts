/**
 * Versioned artifact (docs/FEEDS-AND-DETECTORS.md §2.3): `pack-<UTC ts>.json.gz`, its `.sha256`
 * and a `listing.json` that servers poll (the Grype listing pattern). The timestamp is the
 * pack's builtAt (the newest source timestamp), so the same inputs give the same file names and
 * bytes, and a re-run with nothing new writes nothing.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { KnowledgePack, PackSource } from '../pack/types.js';
import type { CompileStats } from './compile.js';
import { sha256 } from './store.js';

export const LISTING_SCHEMA = 1;

export interface Listing {
  schema: typeof LISTING_SCHEMA;
  /** Pack version: its UTC timestamp, e.g. 20261008T104509Z. */
  version: string;
  packSchema: number;
  builtAt: string;
  /** Pack file name, or an absolute URL when a base URL is given. */
  url: string;
  sha256: string;
  bytes: number;
  counts: KnowledgePack['counts'] & { conflicts: number; labels: number; datasetOnly: number; corroborated: number; records: CompileStats['records'] };
  /** Per-source high-water marks (OSV: newest modified synced; git sources: commit and date). */
  highWater: Record<string, string>;
  /** Newest `modified` of a record in the index (freshness is measured from it). */
  newestModified: string | null;
  /** NOTICE: source, licence, snapshot. */
  notice: Pick<PackSource, 'name' | 'url' | 'licence' | 'snapshot'>[];
}

export const packVersion = (builtAt: string) => builtAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Canonical bytes of a pack: JSON then gzip level 9 (no file name or mtime in the header). */
export function packBytes(pack: KnowledgePack): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(pack)), { level: 9 });
}

async function writeIfChanged(path: string, data: Buffer | string): Promise<boolean> {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  if (existsSync(path) && (await readFile(path)).equals(buf)) return false;
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, buf);
  await rename(tmp, path);
  return true;
}

export interface EmitResult {
  listing: Listing;
  packFile: string;
  /** Files actually written (empty on a no-op re-run). */
  written: string[];
}

export async function emitPack(
  outDir: string,
  pack: KnowledgePack,
  meta: { stats: CompileStats; highWater: Record<string, string>; newestModified: string | null; baseUrl?: string },
): Promise<EmitResult> {
  await mkdir(outDir, { recursive: true });
  const version = packVersion(pack.builtAt);
  const bytes = packBytes(pack);
  const sha = sha256(bytes);
  // Same timestamp, different content (e.g. only the KB changed): never overwrite a published pack.
  let name = `pack-${version}.json.gz`;
  if (existsSync(join(outDir, name)) && sha256(await readFile(join(outDir, name))) !== sha) name = `pack-${version}-${sha.slice(0, 8)}.json.gz`;
  const s = meta.stats;
  const listing: Listing = {
    schema: LISTING_SCHEMA,
    version,
    packSchema: pack.schema,
    builtAt: pack.builtAt,
    url: meta.baseUrl ? `${meta.baseUrl.replace(/\/$/, '')}/${name}` : name,
    sha256: sha,
    bytes: bytes.length,
    counts: { ...pack.counts, conflicts: s.conflicts, labels: s.labels, datasetOnly: s.datasetOnly, corroborated: s.corroborated, records: s.records },
    highWater: meta.highWater,
    newestModified: meta.newestModified,
    notice: pack.sources.map(({ name: n, url, licence, snapshot }) => ({ name: n, url, licence, snapshot })),
  };
  const written: string[] = [];
  // Pack first, listing last: a poller never sees a listing that points at a missing pack.
  const files: [string, Buffer | string][] = [
    [name, bytes],
    [`${name}.sha256`, `${sha}  ${name}\n`],
    ['listing.json', `${JSON.stringify(listing, null, 2)}\n`],
  ];
  for (const [f, data] of files) if (await writeIfChanged(join(outDir, f), data)) written.push(f);
  return { listing, packFile: join(outDir, name), written };
}
