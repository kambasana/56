/**
 * Shallow, hook-free, sparse clone of a public GitHub repository at a pinned commit into the
 * hammer cache. Only the files the engine reads are checked out (manifests, lockfiles,
 * workflows, Dockerfiles, config). Nothing from the repository is ever executed.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './util.js';

export const SPARSE_PATTERNS = [
  '/.github/workflows/',
  '/.blastradius.yml',
  '/.blastradius.yaml',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '[Dd]ockerfile*',
  '*.[Dd]ockerfile',
  '[Cc]ontainerfile',
];

export interface CloneResult {
  ok: boolean;
  dir: string;
  head: string | null;
  reused: boolean;
  ms: number;
  error?: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function cloneAt(cacheDir: string, repo: string, commit: string): Promise<CloneResult> {
  const t0 = Date.now();
  if (!REPO_RE.test(repo) || !SHA_RE.test(commit)) {
    return { ok: false, dir: '', head: null, reused: false, ms: 0, error: `bad repo/commit ${repo}@${commit}` };
  }
  const dir = path.join(cacheDir, `${repo.replace('/', '__')}@${commit.slice(0, 12)}`);
  const marker = path.join(dir, '.git', 'hammer-ok');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === commit) {
    const head = await git(['rev-parse', 'HEAD'], dir);
    if (head.ok && head.out.trim() === commit) return { ok: true, dir, head: commit, reused: true, ms: Date.now() - t0 };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const steps: string[][] = [
    ['init', '-q', '--template='],
    ['remote', 'add', 'origin', `https://github.com/${repo}`],
    ['-c', 'http.followRedirects=false', 'fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', 'origin', commit],
    ['sparse-checkout', 'set', '--no-cone', ...SPARSE_PATTERNS],
    ['-c', 'advice.detachedHead=false', '-c', 'core.symlinks=false', 'checkout', '-q', 'FETCH_HEAD'],
  ];
  for (const args of steps) {
    const r = await git(args, dir, 600_000);
    if (!r.ok) return { ok: false, dir, head: null, reused: false, ms: Date.now() - t0, error: `git ${args.filter((a) => !a.startsWith('-c') && !a.includes('=')).slice(0, 2).join(' ')}: ${r.err.slice(0, 400)}` };
  }
  const head = await git(['rev-parse', 'HEAD'], dir);
  const sha = head.ok ? head.out.trim() : null;
  if (sha === commit) writeFileSync(marker, commit);
  return { ok: sha === commit, dir, head: sha, reused: false, ms: Date.now() - t0, ...(sha === commit ? {} : { error: `HEAD is ${sha}, expected ${commit}` }) };
}
