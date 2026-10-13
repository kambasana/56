/**
 * Where Blastradius keeps its on-disk state (HTTP cache, npm snapshots).
 *
 * The default is a per-user cache directory, never the current working directory:
 * a scanned checkout must not be able to ship its own ".blastradius-cache" with forged
 * API responses or snapshots (the common `blastradius scan .` runs with cwd = target).
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** $BLASTRADIUS_CACHE_DIR, else $XDG_CACHE_HOME/blastradius, else ~/.cache/blastradius. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.BLASTRADIUS_CACHE_DIR;
  if (explicit && explicit.trim()) return resolve(explicit);
  const xdg = env.XDG_CACHE_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, 'blastradius');
  return join(homedir(), '.cache', 'blastradius');
}

/** True when `child` is `root` or inside it (after resolving both). */
export function isPathInside(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
