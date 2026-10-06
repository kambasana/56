/**
 * Scan target safety (docs/WEB-API.md "Scan targets").
 *
 *  - Git: an https:// URL on an allow-listed host, without credentials, port, query or fragment.
 *    Cloned shallow into a fresh temp directory with hooks, submodules, LFS smudging and
 *    redirects disabled (see cloneTarget). The clone is never executed.
 *  - Local: an existing directory under one of the allowed roots, checked again after every
 *    symlink is resolved (realpath), so a link cannot escape the root.
 */
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPathInside } from '../core/paths.js';
import { cloneArgs, cloneEnv, defaultGitRunner, type GitRunner } from '../ingest/git.js';
import { badRequest } from './errors.js';

export const ALLOWED_GIT_HOSTS: readonly string[] = ['github.com', 'gitlab.com', 'bitbucket.org'];

export type CheckedTarget = { kind: 'git'; url: string } | { kind: 'local'; path: string };

const GIT_PATH_RE = /^(\/[A-Za-z0-9._-]+){2,8}\/?$/;

/** Validate an https git URL. Returns the normalised URL or throws bad_request. */
export function checkGitTarget(input: string, hosts: readonly string[] = ALLOWED_GIT_HOSTS): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw badRequest('Target is not a valid URL', ['target']);
  }
  if (u.protocol !== 'https:') throw badRequest('Git targets must use https://', ['target']);
  if (u.username || u.password) throw badRequest('Credentials in the URL are not allowed', ['target']);
  if (u.port) throw badRequest('A port in the URL is not allowed', ['target']);
  if (u.search || u.hash || input.includes('?') || input.includes('#')) throw badRequest('Query strings and fragments are not allowed', ['target']);
  // Judge the URL as typed: no dot segments, escapes or backslashes for the parser to rewrite.
  if (/(^|\/)\.{1,2}(\/|$)|%|\\/.test(input.replace(/^https:\/\//i, ''))) throw badRequest('Git URL path must look like /owner/repo', ['target']);
  const host = u.hostname.toLowerCase();
  if (!hosts.includes(host)) throw badRequest(`Git host is not allowed (allowed: ${hosts.join(', ')})`, ['target']);
  if (!GIT_PATH_RE.test(u.pathname) || u.pathname.split('/').some((seg) => seg === '.' || seg === '..' || seg.startsWith('-'))) {
    throw badRequest('Git URL path must look like /owner/repo', ['target']);
  }
  return `https://${host}${u.pathname.replace(/\/$/, '')}`;
}

/** Resolve a local directory under one of `roots` (after realpath). Throws bad_request. */
export function checkLocalTarget(input: string, roots: readonly string[]): string {
  if (input.includes('\0')) throw badRequest('Invalid path', ['target']);
  if (roots.length === 0) throw badRequest('Local paths are not allowed on this server', ['target']);
  const realRoots = roots.flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
  const candidates = path.isAbsolute(input) ? [input] : realRoots.map((r) => path.resolve(r, input));
  for (const candidate of candidates) {
    // Lexical check first: never even stat a path outside the roots.
    if (!roots.some((r) => isPathInside(candidate, r)) && !realRoots.some((r) => isPathInside(candidate, r))) continue;
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!realRoots.some((r) => isPathInside(real, r))) continue;
    let isDir = false;
    try {
      isDir = statSync(real).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    return real;
  }
  throw badRequest('Local path must be an existing directory under the allowed scan root', ['target']);
}

/** Classify and validate a project target. https:// is git; anything else is a local path. */
export function checkTarget(input: string, roots: readonly string[]): CheckedTarget {
  const t = input.trim();
  if (!t || t.length > 2048 || /[\u0000-\u001f\u007f]/.test(t)) throw badRequest('Invalid target', ['target']);
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) {
    if (!/^https:\/\//i.test(t)) throw badRequest('Git targets must use https://', ['target']);
    return { kind: 'git', url: checkGitTarget(t) };
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(t)) throw badRequest('Git targets must use https://', ['target']);
  return { kind: 'local', path: checkLocalTarget(t, roots) };
}

const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/** Branch or tag name for --branch. Throws bad_request. */
export function checkGitRef(ref: string): string {
  if (!REF_RE.test(ref) || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.lock') || ref.includes('..') || ref.includes('//')) {
    throw badRequest('Invalid git ref', ['ref']);
  }
  return ref;
}

export interface CloneOptions {
  ref?: string;
  runner?: GitRunner;
  tmpDir?: string;
  timeoutMs?: number;
}

/** Exact clone argv (exported for tests): the engine's hook-free clone plus no redirects and an optional branch. */
export function serverCloneArgs(url: string, dest: string, ref?: string): string[] {
  const base = cloneArgs(url, dest);
  const sep = base.indexOf('--');
  const extra = ref ? ['--branch', checkGitRef(ref)] : [];
  return ['-c', 'http.followRedirects=false', '-c', 'lfs.fetchexclude=*', ...base.slice(0, sep), ...extra, ...base.slice(sep)];
}

/** Shallow clone of an allow-listed https URL into a fresh temp dir. */
export async function cloneTarget(url: string, opts: CloneOptions = {}): Promise<{ dir: string; commit: string | null; cleanup: () => Promise<void> }> {
  const checked = checkGitTarget(url);
  const parent = await mkdtemp(path.join(opts.tmpDir ?? os.tmpdir(), 'blastradius-scan-'));
  const dir = path.join(parent, 'repo');
  const cleanup = () => rm(parent, { recursive: true, force: true });
  try {
    await (opts.runner ?? defaultGitRunner)(serverCloneArgs(checked, dir, opts.ref), { env: cloneEnv(), timeoutMs: opts.timeoutMs ?? 120_000 });
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { dir, commit: await headCommit(dir), cleanup };
}

/** The checked-out commit sha, or null. Reads only; runs no repository code. */
function headCommit(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', dir, 'rev-parse', '--verify', 'HEAD'],
      { env: cloneEnv(), timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        const sha = String(stdout ?? '').trim();
        resolve(!err && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null);
      },
    );
  });
}
