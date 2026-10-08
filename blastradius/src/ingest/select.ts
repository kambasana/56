/**
 * Which repository files the inventory is built from, decided from a path alone.
 *
 * One rule set for both ways of reading a repository:
 *  - walking a directory (fs.ts walkTarget classifies every file it visits with this), and
 *  - listing a remote tree through a code host's API (server/sources): only the files selected
 *    here are fetched, written to a temp dir and ingested, so the inventory equals a clone scan.
 * Push events use the same rules to decide whether a push can change the inventory.
 */

export type InventoryFileKind =
  /** package.json (any depth). */
  | 'package_json'
  /** package-lock.json / npm-shrinkwrap.json (any depth: every workspace root). */
  | 'lockfile'
  /** yarn.lock / pnpm-lock.yaml: recognised, not parsed (only their presence is reported). */
  | 'unsupported_lockfile'
  /** .github/workflows/*.yml|yaml at the repository root. */
  | 'workflow'
  /** Dockerfile, Dockerfile.*, *.dockerfile, Containerfile */
  | 'dockerfile'
  /** .blastradius.yml / .blastradius.yaml at the root. */
  | 'config';

/** Directories never descended into (walkTarget skips them too). */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.svn', 'bower_components', '.yarn', '.pnpm-store']);

/** Deepest directory level the walk enters (walkTarget's default maxDepth). */
export const DEFAULT_MAX_DEPTH = 40;

export function isDockerfileName(base: string): boolean {
  const b = base.toLowerCase();
  return b === 'dockerfile' || b === 'containerfile' || b.startsWith('dockerfile.') || b.endsWith('.dockerfile');
}

/** The kind of a file by its relative POSIX path, ignoring where it sits (see isWalkedPath). */
export function inventoryFileKind(rel: string): InventoryFileKind | null {
  const slash = rel.lastIndexOf('/');
  const base = slash === -1 ? rel : rel.slice(slash + 1);
  const atRoot = slash === -1;
  if (base === 'package.json') return 'package_json';
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'lockfile';
  if (base === 'yarn.lock' || base === 'pnpm-lock.yaml') return 'unsupported_lockfile';
  // GitHub only runs workflows from the repository root's .github/workflows (not subdirectories).
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(rel)) return 'workflow';
  if (isDockerfileName(base)) return 'dockerfile';
  if (atRoot && (base === '.blastradius.yml' || base === '.blastradius.yaml')) return 'config';
  return null;
}

/** True when a directory walk reaches this file: no skipped directory on the way, not too deep. */
export function isWalkedPath(rel: string, maxDepth = DEFAULT_MAX_DEPTH): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  const dirs = parts.slice(0, -1);
  if (dirs.length > maxDepth) return false;
  return !dirs.some((d) => SKIP_DIRS.has(d));
}

/** The kind of `rel` when the inventory reads it, else null. */
export function selectInventoryFile(rel: string, maxDepth = DEFAULT_MAX_DEPTH): InventoryFileKind | null {
  return isWalkedPath(rel, maxDepth) ? inventoryFileKind(rel) : null;
}

/** Inventory files among `paths` (sorted, de-duplicated). */
export function selectInventoryFiles(paths: Iterable<string>): { path: string; kind: InventoryFileKind }[] {
  const out = new Map<string, InventoryFileKind>();
  for (const p of paths) {
    const kind = selectInventoryFile(p);
    if (kind) out.set(p, kind);
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, kind]) => ({ path, kind }));
}

/** True when any changed path is a manifest, lockfile, workflow, Dockerfile or the config. */
export function touchesInventory(changedPaths: Iterable<string>): boolean {
  for (const p of changedPaths) if (selectInventoryFile(p) !== null) return true;
  return false;
}
