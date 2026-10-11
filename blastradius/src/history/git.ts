/**
 * Git history collector (docs/WHO-BEHIND-PLAN.md P2): a cache of blobless bare clones, read with
 * `git log` / `git for-each-ref` in fixed formats. Nothing from the repository is ever executed.
 *
 * Safety, as for scan clones (src/ingest/git.ts):
 *   - only https/ssh URLs (checkGitUrl), arguments as an array (no shell), the URL after `--`;
 *   - hooks off (`core.hooksPath=/dev/null`, empty `--template=`), no submodules, no credential
 *     helpers or prompts, `protocol.file`/`protocol.ext` refused, minimal environment (cloneEnv);
 *   - a bare clone has no working tree, so no checkout, no LFS smudge, no filters run;
 *   - `--filter=blob:none` (git partial clone, https://git-scm.com/docs/partial-clone): commits,
 *     trees and tags only. Reads run with `protocol.allow=never`, so a command that would need a
 *     missing blob fails instead of fetching it (the only blob fetched on purpose is `.mailmap`);
 *   - a size cap (the clone directory is measured while git runs and the process is killed when
 *     it grows past the cap) and a timeout per git command.
 *
 * Formats (https://git-scm.com/docs/pretty-formats, https://git-scm.com/docs/git-for-each-ref):
 *   pass 1, people:      %H %P %aN %aE %ct %cN %cE %s  (mailmap applied, no time zone read)
 *   pass 2, signatures:  --pretty=raw, only the `commit` and `gpgsig`/`gpgsig-sha256` header lines kept
 *   pass 3, time zones:  %H %ct %ad with --date=raw, no person fields; aggregated per month at once
 *   tags:                refname, type, tagger (mailmap), tagger date, target, signature present
 * So a person and a time zone are never in the same record, even in memory.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { checkGitUrl, cloneEnv } from '../ingest/git.js';
import { isBot, isPlatformCommitter, localIdentity } from './identity.js';
import type { HistoryRecord, HistoryCommit, HistoryTag, TzMonth } from './record.js';

/** Config every git command runs with. */
export const SAFE_CONFIG: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.symlinks=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
  '-c', 'submodule.recurse=false',
  '-c', 'credential.helper=',
  '-c', 'log.showSignature=false',
  '-c', 'gc.auto=0',
];

/** Extra config for reads: no network at all (no lazy blob fetches). */
const READ_CONFIG: readonly string[] = ['-c', 'protocol.allow=never'];

export interface HistoryCacheOptions {
  /** Cache directory for bare clones (one per repo URL). */
  dir: string;
  /** Largest clone kept, in bytes (default 300 MB). */
  maxBytes?: number;
  /** Timeout per git command (default 180 s). */
  timeoutMs?: number;
  /** Clones not refreshed for this long are deleted on prune (default 30 days, plan §5 retention). */
  retentionMs?: number;
  /** A clone fetched less than this long ago is read as is (default 12 h). */
  refreshMs?: number;
  /** Only read history newer than this (git --shallow-since); default: whole history. */
  shallowSince?: Date;
}

export interface GitRun {
  (args: string[], opts: { cwd?: string; timeoutMs: number; onLine?: (line: string) => void; watchDir?: string; maxBytes?: number }): Promise<void>;
}

/** Run git, streaming stdout lines to onLine; kills it on timeout or when watchDir exceeds maxBytes. */
export const runGit: GitRun = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd, env: cloneEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let failure: Error | undefined;
    const kill = (err: Error) => {
      failure ??= err;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill(new Error(`git timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
    let watching = false;
    const watcher =
      opts.watchDir && opts.maxBytes
        ? setInterval(() => {
            if (watching) return;
            watching = true;
            void dirSize(opts.watchDir!)
              .then((n) => {
                if (n > opts.maxBytes!) kill(new Error(`clone larger than the cap of ${(opts.maxBytes! / 1e6).toFixed(1)} MB`));
              })
              .finally(() => (watching = false));
          }, 500)
        : undefined;
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString('utf8');
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => opts.onLine?.(line));
    child.on('error', (e) => kill(e));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (watcher) clearInterval(watcher);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed: ${stderr.replace(/\s+/g, ' ').trim().slice(0, 300)}`));
      else resolve();
    });
  });

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Argument vector of the blobless bare clone (exported for tests). */
export function historyCloneArgs(url: string, dest: string, shallowSince?: Date): string[] {
  return [
    ...SAFE_CONFIG,
    'clone',
    '--bare',
    '--filter=blob:none',
    '--single-branch',
    '--no-recurse-submodules',
    '--template=',
    '--quiet',
    ...(shallowSince ? [`--shallow-since=${shallowSince.toISOString().slice(0, 10)}`] : []),
    '--',
    url,
    dest,
  ];
}

export function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

/** Make sure a fresh enough bare clone of `url` is in the cache; returns its directory. */
export async function ensureClone(url: string, opts: HistoryCacheOptions, git: GitRun = runGit): Promise<string> {
  const problem = checkGitUrl(url);
  if (problem) throw new Error(`refusing to clone: ${problem}`);
  const maxBytes = opts.maxBytes ?? 300e6;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  await mkdir(opts.dir, { recursive: true, mode: 0o700 });
  const dest = path.join(opts.dir, `${cacheKey(url)}.git`);
  const st = await stat(dest).catch(() => undefined);
  if (st) {
    if (Date.now() - st.mtimeMs < (opts.refreshMs ?? 12 * 3600e3)) return dest;
    try {
      await git([...SAFE_CONFIG, 'fetch', '--quiet', '--filter=blob:none', '--prune', '--tags', 'origin'], { cwd: dest, timeoutMs, watchDir: dest, maxBytes });
      const now = new Date();
      await utimes(dest, now, now);
      return dest;
    } catch {
      await rm(dest, { recursive: true, force: true });
    }
  }
  try {
    await git(historyCloneArgs(url, dest, opts.shallowSince), { timeoutMs, watchDir: dest, maxBytes });
    // --single-branch brings only tags inside the default branch; release tags on maintenance
    // branches (e.g. v5.4.x) are fetched with their commits, still without blobs.
    await git([...SAFE_CONFIG, 'fetch', '--quiet', '--filter=blob:none', '--tags', 'origin'], { cwd: dest, timeoutMs, watchDir: dest, maxBytes });
  } catch (err) {
    await rm(dest, { recursive: true, force: true });
    throw err;
  }
  return dest;
}

/** Delete cached clones older than the retention period. Returns how many were removed. */
export async function pruneCache(opts: Pick<HistoryCacheOptions, 'dir' | 'retentionMs'>, now = Date.now()): Promise<number> {
  let removed = 0;
  const entries = await readdir(opts.dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('.git')) continue;
    const p = path.join(opts.dir, e.name);
    const st = await stat(p).catch(() => undefined);
    if (st && now - st.mtimeMs > (opts.retentionMs ?? 30 * 86400e3)) {
      await rm(p, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

const SEP = '\x1f';
const VERSION_SUBJECT_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
/** Tags that look like releases: v1.2, 1.2.3, xz-5.2, release-1.0, rel_1_0 … */
const RELEASE_TAG_RE = /^(?:[A-Za-z][A-Za-z0-9_-]*?[-_])?v?\d+(?:[._]\d+)+(?:[._-]?[0-9A-Za-z.]+)?$/;

export function isReleaseTag(name: string): boolean {
  return RELEASE_TAG_RE.test(name);
}

/** Midnight UTC of an epoch-seconds timestamp, as epoch seconds (history is kept at day precision). */
export function toDay(epochSeconds: number): number {
  return Math.floor(epochSeconds / 86400) * 86400;
}

export function monthKey(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 7);
}

/** Monday 00:00 UTC = 0 … Sunday 23:00 UTC = 167. */
export function hourOfWeekUtc(epochSeconds: number): number {
  const d = new Date(epochSeconds * 1000);
  return ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours();
}

/**
 * Read a bare clone into a HistoryRecord. Emails are turned into ids here (salted hash or
 * no-reply login) and dropped; `emailsOf` receives, per hashed id, the latest commit oid so the
 * GraphQL mapper can ask GitHub for that commit's login.
 */
export async function readHistory(
  dir: string,
  meta: { repo: string; salt: Buffer | string; timeoutMs?: number },
  git: GitRun = runGit,
): Promise<HistoryRecord> {
  const timeoutMs = meta.timeoutMs ?? 180_000;
  let head = '';
  await git([...SAFE_CONFIG, ...READ_CONFIG, 'rev-parse', 'HEAD'], { cwd: dir, timeoutMs, onLine: (l) => (head ||= l.trim()) });

  // .mailmap: the one blob fetched on purpose (git's own alias file). Network is allowed for this
  // single object; everything after runs with protocol.allow=never.
  let mailmapBlob = '';
  await git([...SAFE_CONFIG, 'ls-tree', 'HEAD', '--', '.mailmap'], { cwd: dir, timeoutMs, onLine: (l) => {
    const m = /^100644 blob ([0-9a-f]{40,64})\t\.mailmap$/.exec(l);
    if (m) mailmapBlob = m[1]!;
  } });
  if (mailmapBlob) {
    try {
      await git([...SAFE_CONFIG, 'cat-file', 'blob', mailmapBlob], { cwd: dir, timeoutMs, onLine: () => undefined });
    } catch {
      mailmapBlob = '';
    }
  }
  const mailmapCfg = ['-c', `mailmap.blob=${mailmapBlob}`, '-c', 'mailmap.file='];

  const commits: HistoryCommit[] = [];
  const botOids = new Set<string>();
  let bots = 0;
  const latestOidById = new Map<string, string>();
  const idOf = (email: string) => localIdentity(email, meta.salt);
  await git([...SAFE_CONFIG, ...READ_CONFIG, ...mailmapCfg, 'log', '--no-color', '--use-mailmap', `--format=%H${SEP}%P${SEP}%aN${SEP}%aE${SEP}%ct${SEP}%cN${SEP}%cE${SEP}%s`, 'HEAD', '--'], {
    cwd: dir,
    timeoutMs,
    onLine: (line) => {
      const f = line.split(SEP);
      if (f.length < 8) return;
      const [oid, parents, aName, aEmail, ct, cName, cEmail] = f as [string, string, string, string, string, string, string];
      const subject = f.slice(7).join(SEP);
      if (isBot(aName, aEmail)) {
        bots++;
        botOids.add(oid);
        return;
      }
      const author = idOf(aEmail);
      // GitHub's web-flow committer (noreply@github.com) is the platform, not a person.
      const committer = isBot(cName, cEmail) || isPlatformCommitter(cEmail) ? author : idOf(cEmail);
      if (!latestOidById.has(author)) latestOidById.set(author, oid);
      const c: HistoryCommit = { oid, parents: parents ? parents.split(' ').length : 0, author, committer, at: toDay(Number(ct)), signed: false };
      const v = VERSION_SUBJECT_RE.exec(subject.trim());
      if (v) c.version = v[1]!;
      commits.push(c);
    },
  });

  const signed = new Set<string>();
  let current = '';
  await git([...SAFE_CONFIG, ...READ_CONFIG, 'log', '--no-color', '--pretty=raw', 'HEAD', '--'], {
    cwd: dir,
    timeoutMs,
    onLine: (line) => {
      if (line.startsWith('commit ')) current = line.slice(7).trim().split(' ')[0]!;
      else if (line.startsWith('gpgsig ') || line.startsWith('gpgsig-sha256 ')) signed.add(current);
    },
  });
  for (const c of commits) if (signed.has(c.oid)) c.signed = true;

  const tzMonths: Record<string, TzMonth> = {};
  await git([...SAFE_CONFIG, ...READ_CONFIG, 'log', '--no-color', '--date=raw', `--format=%H${SEP}%ct${SEP}%ad`, 'HEAD', '--'], {
    cwd: dir,
    timeoutMs,
    onLine: (line) => {
      const [oid, ct, ad] = line.split(SEP) as [string, string, string];
      if (!ad || botOids.has(oid)) return;
      const [epoch, offset] = ad.split(' ') as [string, string];
      if (!/^[+-]\d{4}$/.test(offset ?? '')) return;
      const m = (tzMonths[monthKey(Number(ct))] ??= { offsets: {}, how: new Array<number>(168).fill(0) });
      m.offsets[offset] = (m.offsets[offset] ?? 0) + 1;
      m.how[hourOfWeekUtc(Number(epoch))]!++;
    },
  });

  const tags: HistoryTag[] = [];
  const commitByOid = new Map(commits.map((c) => [c.oid, c]));
  await git(
    [...SAFE_CONFIG, ...READ_CONFIG, ...mailmapCfg, 'for-each-ref', 'refs/tags',
      `--format=${['%(refname:strip=2)', '%(objecttype)', '%(taggername:mailmap)', '%(taggeremail:mailmap,trim)', '%(taggerdate:unix)', '%(*objectname)', '%(objectname)', '%(if)%(contents:signature)%(then)1%(else)0%(end)', '%(committername:mailmap)', '%(committeremail:mailmap,trim)', '%(committerdate:unix)'].join('%1f')}`],
    {
      cwd: dir,
      timeoutMs,
      onLine: (line) => {
        const [name, type, tName, tEmail, tDate, peeled, oid, sig, cName, cEmail, cDate] = line.split(SEP) as string[];
        if (!name || !isReleaseTag(name)) return;
        const target = type === 'tag' ? peeled! : oid!;
        const commit = commitByOid.get(target);
        if (type === 'tag' && tEmail && tDate) {
          if (isBot(tName ?? '', tEmail)) return;
          tags.push({ name, commit: target, by: idOf(tEmail), at: toDay(Number(tDate)), signed: sig === '1', annotated: true });
        } else if (type === 'commit') {
          // Lightweight tag: the commit's committer made the release point.
          if (commit) tags.push({ name, commit: target, by: commit.committer, at: commit.at, signed: commit.signed, annotated: false });
          else if (cEmail && cDate && !isBot(cName ?? '', cEmail) && !isPlatformCommitter(cEmail)) tags.push({ name, commit: target, by: idOf(cEmail), at: toDay(Number(cDate)), signed: false, annotated: false });
        }
      },
    },
  );
  tags.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));

  return {
    repo: meta.repo,
    head,
    mailmap: mailmapBlob !== '',
    bots,
    commits,
    tags,
    tzMonths,
    lookup: [...latestOidById].filter(([id]) => id.startsWith('hash:')).map(([id, oid]) => ({ id, oid })),
  };
}
