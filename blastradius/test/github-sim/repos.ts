/**
 * Repository snapshots for the simulator: real public repos at pinned commits, recorded by
 * test/sources/equivalence.ts --record (tree as listed by git, inventory files as fetched from
 * raw.githubusercontent.com, blob ids checked). Stored in test/fixtures/sources.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { TreeEntry } from './gitobjects.js';
import type { LockedPackage } from './lockfile.js';

export const RECORDINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sources');

export interface RecordedRepo {
  /** owner/name of the real repository. */
  repo: string;
  commit: string;
  recordedAt: string;
  /** The full tree at `commit` (git ls-tree -r -t -l), in the tree API's shape. */
  tree: TreeEntry[];
  /** Contents of the inventory files (the only files whose bytes were recorded). */
  files: Record<string, string>;
  /** The clone scan's inventory, for equivalence checks. */
  cloneScan: { assets: number; components: number; edges: number; sha256: string; warnings: string[] };
}

let cache: Map<string, RecordedRepo> | null = null;

/** Every recording, keyed by the real repository's owner/name. */
export function recordedRepos(): Map<string, RecordedRepo> {
  if (!cache) {
    cache = new Map();
    for (const f of readdirSync(RECORDINGS_DIR).filter((x) => x.endsWith('.json.gz')).sort()) {
      const r = JSON.parse(gunzipSync(readFileSync(join(RECORDINGS_DIR, f))).toString('utf8')) as RecordedRepo;
      cache.set(r.repo, r);
    }
  }
  return cache;
}

export function recordedRepo(fullName: string): RecordedRepo {
  const r = recordedRepos().get(fullName);
  if (!r) throw new Error(`no recording of ${fullName} in ${RECORDINGS_DIR} (record one with: npx tsx test/sources/equivalence.ts ${fullName} <commit> --record)`);
  return r;
}

/** resolved + integrity of name@version as a recorded real lockfile pins it (v1 or v2/v3 entries). */
export function lockedFromRecordings(name: string, version: string): LockedPackage {
  for (const r of recordedRepos().values()) {
    for (const [p, text] of Object.entries(r.files)) {
      if (!p.endsWith('package-lock.json')) continue;
      let j: Record<string, any>;
      try {
        j = JSON.parse(text) as Record<string, any>;
      } catch {
        continue;
      }
      const hits = [j.packages?.[`node_modules/${name}`], j.dependencies?.[name]];
      for (const h of hits) {
        if (h?.version === version && typeof h.integrity === 'string') return { name, version, resolved: h.resolved, integrity: h.integrity };
      }
    }
  }
  return { name, version };
}
