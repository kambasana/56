/**
 * Safe, static file-system access for scanned targets.
 *
 * - Never follows symlinked directories. A symlinked file is read only when its
 *   real path stays inside the target root.
 * - Caps the number of files visited, the walk depth and every file read.
 * - Returns paths relative to the root with forward slashes.
 */
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024; // manifests, workflows, Dockerfiles
export const DEFAULT_MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 200_000;
export const DEFAULT_MAX_DEPTH = 40;

/** Directories never descended into. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'bower_components', '.yarn', '.pnpm-store']);

export interface WalkOptions {
  maxFiles?: number;
  maxDepth?: number;
}

export interface FoundFiles {
  /** package.json files (relative paths). */
  packageJsons: string[];
  /** package-lock.json / npm-shrinkwrap.json. */
  lockfiles: string[];
  /** Other lockfiles we recognise but cannot parse (yarn.lock, pnpm-lock.yaml). */
  unsupportedLockfiles: string[];
  /** .github/workflows/*.yml|yaml */
  workflows: string[];
  /** Dockerfile, Dockerfile.*, *.dockerfile, Containerfile */
  dockerfiles: string[];
  /** .blastradius.yml / .blastradius.yaml at the root, if present. */
  config?: string;
  /** Number of files visited. */
  visited: number;
  /** True when maxFiles was hit. */
  truncated: boolean;
  /** Symlinks that were not followed. */
  skippedSymlinks: string[];
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** True when `child` (absolute, resolved) is `root` or lies inside it. */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isDockerfileName(base: string): boolean {
  const b = base.toLowerCase();
  return b === 'dockerfile' || b === 'containerfile' || b.startsWith('dockerfile.') || b.endsWith('.dockerfile');
}

/** Walk `root` and collect the files ingest cares about. `root` must be a real (resolved) directory path. */
export async function walkTarget(root: string, opts: WalkOptions = {}): Promise<FoundFiles> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const out: FoundFiles = {
    packageJsons: [],
    lockfiles: [],
    unsupportedLockfiles: [],
    workflows: [],
    dockerfiles: [],
    visited: 0,
    truncated: false,
    skippedSymlinks: [],
  };

  const queue: { abs: string; depth: number }[] = [{ abs: root, depth: 0 }];
  while (queue.length > 0) {
    const { abs, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (out.visited >= maxFiles) {
        out.truncated = true;
        return out;
      }
      const childAbs = path.join(abs, ent.name);
      const rel = toPosix(path.relative(root, childAbs));
      if (ent.isSymbolicLink()) {
        // Only follow file symlinks that resolve inside the root; never directories.
        let real: string;
        try {
          real = await realpath(childAbs);
        } catch {
          out.skippedSymlinks.push(rel);
          continue;
        }
        if (!isInside(root, real)) {
          out.skippedSymlinks.push(rel);
          continue;
        }
        try {
          const st = await stat(real);
          if (!st.isFile()) {
            out.skippedSymlinks.push(rel);
            continue;
          }
        } catch {
          out.skippedSymlinks.push(rel);
          continue;
        }
        out.visited++;
        classify(out, rel, ent.name, depth === 0);
        continue;
      }
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (depth + 1 > maxDepth) continue;
        queue.push({ abs: childAbs, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      out.visited++;
      classify(out, rel, ent.name, depth === 0);
    }
  }
  return out;
}

function classify(out: FoundFiles, rel: string, base: string, atRoot: boolean): void {
  if (base === 'package.json') out.packageJsons.push(rel);
  else if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') out.lockfiles.push(rel);
  else if (base === 'yarn.lock' || base === 'pnpm-lock.yaml') out.unsupportedLockfiles.push(rel);
  else if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(rel)) out.workflows.push(rel);
  else if (isDockerfileName(base)) out.dockerfiles.push(rel);
  else if (atRoot && (base === '.blastradius.yml' || base === '.blastradius.yaml')) out.config = rel;
}

export class FileTooLargeError extends Error {
  constructor(
    readonly file: string,
    readonly size: number,
    readonly limit: number,
  ) {
    super(`${file} is ${size} bytes, over the ${limit}-byte limit; skipped`);
    this.name = 'FileTooLargeError';
  }
}

/**
 * Read a UTF-8 file under `root` (relative path), refusing anything whose real
 * path escapes the root or which exceeds `maxBytes`.
 */
export async function readTargetFile(root: string, rel: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<string> {
  const abs = path.resolve(root, rel);
  const real = await realpath(abs);
  if (!isInside(root, real)) throw new Error(`${rel} resolves outside the scan root; skipped`);
  const fh = await open(real, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`${rel} is not a regular file`);
    if (st.size > maxBytes) throw new FileTooLargeError(rel, st.size, maxBytes);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Cap an untrusted string for storage in the inventory. */
export function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Own-property lookup on untrusted JSON objects (ignores prototype keys). */
export function own<T = unknown>(obj: unknown, key: string): T | undefined {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return Object.hasOwn(obj, key) ? ((obj as Record<string, unknown>)[key] as T) : undefined;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Entries of an untrusted string→string map, dropping non-string values. */
export function stringEntries(v: unknown): [string, string][] {
  if (!isRecord(v)) return [];
  const out: [string, string][] = [];
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out.push([k, val]);
  return out;
}
