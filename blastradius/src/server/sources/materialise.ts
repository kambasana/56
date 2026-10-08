/**
 * Fetch-only scanning (docs/CONNECTORS.md §2): list the repository tree through the host API,
 * fetch only the files the inventory is built from (select.ts) at one commit, and write them
 * into a fresh temp directory laid out like a checkout. The existing ingest then runs on it, so
 * a connected repo gives the same inventory as a clone of the same commit, without cloning.
 *
 * - yarn.lock / pnpm-lock.yaml are only reported by ingest, never parsed: an empty placeholder
 *   is written instead of downloading them.
 * - Files over ingest's read caps are not downloaded: a sparse file of the listed size makes
 *   ingest skip them with the same warning a checkout gives.
 * - Paths from the host are untrusted: anything that would land outside the temp dir is refused.
 */
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_LOCKFILE_BYTES, isInside } from '../../ingest/fs.js';
import { SafeScanError } from '../jobs.js';
import type { InventoryFileRef, SourceAdapter } from './types.js';

export interface MaterialiseOptions {
  tmpDir?: string;
  maxFileBytes?: number;
  maxLockfileBytes?: number;
  /** Cap on the bytes downloaded for one repository (default 256 MB). */
  maxTotalBytes?: number;
}

export interface MaterialisedRepo {
  /** Checkout-like directory (basename "repo", as a server clone). */
  dir: string;
  commit: string;
  /** The inventory files found in the tree (including ones written as placeholders). */
  files: InventoryFileRef[];
  /** Paths actually downloaded. */
  fetched: string[];
  cleanup: () => Promise<void>;
}

const SAFE_SEGMENT = /^[^\u0000/]+$/;

/** Reject tree paths that are absolute, contain dot segments or NUL, or are too long. */
export function checkTreePath(p: string): boolean {
  if (!p || p.length > 4096 || p.startsWith('/')) return false;
  return p.split('/').every((seg) => SAFE_SEGMENT.test(seg) && seg !== '.' && seg !== '..');
}

export async function materialiseRepo(
  adapter: SourceAdapter,
  scope: string,
  fullName: string,
  ref: string,
  opts: MaterialiseOptions = {},
): Promise<MaterialisedRepo> {
  const listing = await adapter.findLockfiles(scope, fullName, ref);
  if (listing.truncated) {
    throw new SafeScanError('Repository tree is too large to list through the API; add it as a git URL project instead');
  }
  const maxFile = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxLock = opts.maxLockfileBytes ?? DEFAULT_MAX_LOCKFILE_BYTES;
  const maxTotal = opts.maxTotalBytes ?? 256 * 1024 * 1024;
  const files = listing.files.filter((f) => checkTreePath(f.path));

  const toFetch: string[] = [];
  const oversized: InventoryFileRef[] = [];
  const placeholders: InventoryFileRef[] = [];
  let total = 0;
  for (const f of files) {
    if (f.kind === 'unsupported_lockfile') placeholders.push(f);
    else if (f.size > (f.kind === 'lockfile' ? maxLock : maxFile)) oversized.push(f);
    else {
      total += f.size;
      toFetch.push(f.path);
    }
  }
  if (total > maxTotal) throw new SafeScanError(`Manifests and lockfiles add up to more than ${Math.round(maxTotal / 1048576)} MB; not fetched`);

  const parent = await mkdtemp(path.join(opts.tmpDir ?? os.tmpdir(), 'blastradius-fetch-'));
  const dir = path.join(parent, 'repo');
  const cleanup = () => rm(parent, { recursive: true, force: true });
  try {
    await mkdir(dir, { mode: 0o700 });
    const contents = toFetch.length > 0 ? await adapter.readFiles(scope, fullName, listing.commit, toFetch) : new Map<string, Uint8Array>();
    const place = async (rel: string): Promise<string> => {
      const abs = path.resolve(dir, rel);
      if (!isInside(dir, abs) || abs === dir) throw new SafeScanError('Refused a repository path outside the scan directory');
      await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
      return abs;
    };
    const fetched: string[] = [];
    for (const rel of toFetch) {
      const body = contents.get(rel);
      if (!body) continue; // gone between listing and read: ingest simply does not see it
      await writeFile(await place(rel), body, { mode: 0o600, flag: 'wx' });
      fetched.push(rel);
    }
    for (const f of placeholders) await writeFile(await place(f.path), '', { mode: 0o600, flag: 'wx' });
    for (const f of oversized) {
      const abs = await place(f.path);
      await writeFile(abs, '', { mode: 0o600, flag: 'wx' });
      await truncate(abs, f.size);
    }
    return { dir, commit: listing.commit, files, fetched, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
