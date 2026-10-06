/**
 * Dated packument summaries, one JSON file per package, so later scans can
 * detect changes (maintainers added/removed, latest publisher changed) that
 * version history alone does not show.
 *
 * Layout: <dir>/npm/<encoded-name>.json = { name, snapshots: NpmSnapshot[] } (oldest first).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultCacheDir } from '../../core/paths.js';
import type { PackumentSummary } from './packument.js';
import { isValidNpmName } from './registry.js';

/** Per-user cache dir (never the cwd, which may be the scanned checkout). Resolved at import time. */
export const DEFAULT_SNAPSHOT_DIR = join(defaultCacheDir(), 'snapshots');

export interface NpmSnapshot extends PackumentSummary {
  takenAt: string;
}

interface SnapshotFile {
  name: string;
  snapshots: NpmSnapshot[];
}

export interface SnapshotChange {
  added: string[];
  removed: string[];
  previousSnapshotAt: string;
}

export class NpmSnapshotStore {
  constructor(
    readonly dir: string = DEFAULT_SNAPSHOT_DIR,
    /** Snapshots kept per package (oldest dropped). */
    readonly maxPerPackage = 30,
  ) {}

  /** File path for a package; names are validated, then percent-encoded (no path traversal). */
  pathFor(name: string): string {
    if (!isValidNpmName(name)) throw new Error(`Invalid npm package name for snapshot: ${JSON.stringify(name.slice(0, 220))}`);
    return join(this.dir, 'npm', `${encodeURIComponent(name)}.json`);
  }

  async list(name: string): Promise<NpmSnapshot[]> {
    try {
      const data = JSON.parse(await readFile(this.pathFor(name), 'utf8')) as Partial<SnapshotFile>;
      return Array.isArray(data.snapshots)
        ? data.snapshots.filter((s): s is NpmSnapshot => typeof s?.takenAt === 'string' && Array.isArray(s.maintainers))
        : [];
    } catch {
      return [];
    }
  }

  /** Most recent snapshot taken strictly before `before`. */
  async latestBefore(name: string, before: Date): Promise<NpmSnapshot | undefined> {
    const t = before.getTime();
    const older = (await this.list(name)).filter((s) => Date.parse(s.takenAt) < t);
    return older.sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt))[older.length - 1];
  }

  async record(snapshot: NpmSnapshot): Promise<void> {
    const path = this.pathFor(snapshot.name);
    const existing = (await this.list(snapshot.name)).filter((s) => s.takenAt !== snapshot.takenAt);
    existing.push(snapshot);
    existing.sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
    const file: SnapshotFile = { name: snapshot.name, snapshots: existing.slice(-this.maxPerPackage) };
    await mkdir(join(this.dir, 'npm'), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 1));
    await rename(tmp, path);
  }
}

/** Maintainer-set difference between an earlier snapshot and the current summary (undefined if equal). */
export function diffSnapshots(previous: NpmSnapshot, current: PackumentSummary): SnapshotChange | undefined {
  const before = new Set(previous.maintainers);
  const after = new Set(current.maintainers);
  const added = [...after].filter((m) => !before.has(m)).sort();
  const removed = [...before].filter((m) => !after.has(m)).sort();
  if (added.length === 0 && removed.length === 0) return undefined;
  return { added, removed, previousSnapshotAt: previous.takenAt };
}
