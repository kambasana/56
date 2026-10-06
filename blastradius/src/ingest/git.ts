/**
 * Shallow, hook-free git clone of a remote target into a temp directory.
 *
 * - Only https:// and ssh:// (or scp-like git@host:path) URLs are accepted.
 * - Arguments are passed as an array (no shell); the URL follows `--`.
 * - Hooks, templates, submodules, LFS smudging, symlinks and credential prompts are disabled.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type GitRunner = (args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<void>;

const SCP_LIKE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[A-Za-z0-9._~\/-]+$/;

/** True when `target` looks like a remote git URL rather than a local path. */
export function looksLikeGitUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || SCP_LIKE_RE.test(target) || /^[a-z][a-z0-9+.-]*::/i.test(target);
}

/** Validate a clone URL. Returns an error message, or null when allowed. */
export function checkGitUrl(url: string): string | null {
  if (url.length > 2048) return 'URL too long';
  if (url.startsWith('-')) return 'URL must not start with "-"';
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return 'URL contains whitespace or control characters';
  if (SCP_LIKE_RE.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'ssh:') return `scheme "${u.protocol.replace(/:$/, '')}" is not allowed (use https or ssh)`;
  if (!u.hostname) return 'URL has no host';
  if (u.protocol === 'https:' && u.password) return 'credentials in the URL are not allowed';
  return null;
}

export const defaultGitRunner: GitRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`git clone failed: ${String(stderr || err.message).slice(0, 500)}`));
      else resolve();
    });
  });

/** The exact git argument vector used for a clone (exported for tests). */
export function cloneArgs(url: string, dest: string): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.symlinks=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'submodule.recurse=false',
    '-c', 'credential.helper=',
    'clone',
    '--depth', '1',
    '--single-branch',
    '--no-tags',
    '--no-recurse-submodules',
    '--template=',
    '--quiet',
    '--',
    url,
    dest,
  ];
}

export function cloneEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Keep only what git needs to find itself, the proxy and CA bundle.
  for (const k of ['PATH', 'HOME', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE', 'SSH_AUTH_SOCK']) {
    const v = base[k];
    if (v !== undefined) env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
  return env;
}

export interface CloneResult {
  dir: string;
  cleanup: () => Promise<void>;
}

/** Shallow-clone `url` into a fresh temp directory. Throws on a refused URL or clone failure. */
export async function cloneRepo(url: string, opts: { runner?: GitRunner; tmpDir?: string; timeoutMs?: number } = {}): Promise<CloneResult> {
  const problem = checkGitUrl(url);
  if (problem) throw new Error(`refusing to clone: ${problem}`);
  const parent = await mkdtemp(path.join(opts.tmpDir ?? os.tmpdir(), 'blastradius-'));
  const dir = path.join(parent, 'repo');
  const cleanup = () => rm(parent, { recursive: true, force: true });
  try {
    await (opts.runner ?? defaultGitRunner)(cloneArgs(url, dir), { env: cloneEnv(), timeoutMs: opts.timeoutMs ?? 120_000 });
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { dir, cleanup };
}
