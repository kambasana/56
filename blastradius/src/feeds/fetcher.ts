/**
 * Where feed bytes come from. `liveFetcher` reads the network (HTTPS and `git fetch`);
 * `offlineFetcher` reads a recorded directory with the same layout, so the whole sync is
 * testable without a network:
 *
 *   <dir>/osv/<eco>/modified_id.csv, <dir>/osv/<eco>/<id>.json, optional <dir>/osv/<eco>/all.zip
 *   <dir>/git/<owner>__<repo>/HEAD.json   ({ "commit": "...", "date": "ISO" })
 *   <dir>/git/<owner>__<repo>/<path>      (the file at that commit)
 *
 * Everything read is untrusted data: parsed with JSON.parse / string splitting only.
 */
import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const OSV_BASE = 'https://osv-vulnerabilities.storage.googleapis.com';

export interface GitFile {
  commit: string;
  /** Commit date, ISO. */
  date: string;
  text: string;
}

export interface FeedFetcher {
  /** Bytes at an OSV bucket path (e.g. "npm/MAL-2026-1.json"), or null when absent (404). */
  osv(path: string): Promise<Buffer | null>;
  /** Lines of an OSV bucket text file, streamed; the caller may stop early. */
  osvLines(path: string): AsyncIterable<string>;
  /** One file at the head of a git repository's default branch. */
  gitFile(repo: string, path: string): Promise<GitFile>;
}

/** "https://github.com/DataDog/x.git" → "DataDog__x" */
export function repoKey(repo: string): string {
  const m = /github\.com\/([^/]+)\/([^/.]+)(?:\.git)?\/?$/.exec(repo);
  if (!m) throw new Error(`unsupported repository URL ${repo}`);
  return `${m[1]}__${m[2]}`;
}

export function offlineFetcher(dir: string): FeedFetcher {
  return {
    async osv(path) {
      const f = join(dir, 'osv', path);
      return existsSync(f) ? readFile(f) : null;
    },
    async *osvLines(path) {
      const f = join(dir, 'osv', path);
      if (!existsSync(f)) return;
      const rl = createInterface({ input: createReadStream(f, 'utf8'), crlfDelay: Infinity });
      try {
        for await (const line of rl) yield line;
      } finally {
        rl.close();
      }
    },
    async gitFile(repo, path) {
      const base = join(dir, 'git', repoKey(repo));
      const head = JSON.parse(await readFile(join(base, 'HEAD.json'), 'utf8')) as { commit: string; date: string };
      return { commit: head.commit, date: head.date, text: await readFile(join(base, path), 'utf8') };
    },
  };
}

async function withRetry<T>(what: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let delay = 1000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw new Error(`${what}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

export interface LiveFetcherOptions {
  /** Directory for the git mirrors (partial, blob-less clones). */
  gitDir: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export function liveFetcher(opts: LiveFetcherOptions): FeedFetcher {
  const f = opts.fetchImpl ?? fetch;
  const headers = { 'user-agent': opts.userAgent ?? 'blastradius-feeds' };
  return {
    osv: (path) =>
      withRetry(`GET ${OSV_BASE}/${path}`, async () => {
        const res = await f(`${OSV_BASE}/${path}`, { headers, signal: AbortSignal.timeout(path.endsWith('.zip') ? 600_000 : 30_000) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      }),
    async *osvLines(path) {
      const res = await withRetry(`GET ${OSV_BASE}/${path}`, async () => {
        const r = await f(`${OSV_BASE}/${path}`, { headers, signal: AbortSignal.timeout(120_000) });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        return r;
      });
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            yield buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
          }
        }
        if (buf) yield buf;
      } finally {
        // Stopping early (high-water mark reached) cancels the rest of the download.
        await reader.cancel().catch(() => {});
      }
    },
    async gitFile(repo, path) {
      const dir = join(opts.gitDir, repoKey(repo));
      const git = (...args: string[]) => run('git', ['-C', dir, ...args], { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      await withRetry(`git fetch ${repo}`, async () => {
        if (!existsSync(join(dir, '.git'))) {
          await mkdir(opts.gitDir, { recursive: true });
          // Blob-less and shallow: only the files we read are downloaded (the Datadog repo holds
          // thousands of sample archives we never need).
          await run('git', ['clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', repo, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        } else {
          await git('fetch', '-q', '--depth', '1', 'origin', 'HEAD');
          await git('update-ref', 'refs/heads/feeds-head', 'FETCH_HEAD');
        }
      });
      const rev = existsSync(join(dir, '.git', 'refs', 'heads', 'feeds-head')) ? 'feeds-head' : 'HEAD';
      const commit = (await git('rev-parse', rev)).stdout.trim();
      const date = (await git('log', '-1', '--format=%cI', rev)).stdout.trim();
      const text = (await withRetry(`git show ${repo}:${path}`, () => git('show', `${commit}:${path}`))).stdout;
      return { commit, date: new Date(date).toISOString(), text };
    },
  };
}
