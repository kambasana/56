/**
 * Connector proof 1 (docs/CONNECTORS.md §4): a fetch-only scan gives the same inventory as a
 * clone scan of the same commit. Live, against a real public repository:
 *
 *   npx tsx test/sources/equivalence.ts [owner/repo] [commit] [--record]
 *
 * 1. Clone scan: a hook-free shallow fetch of the commit, checked out with the server's clone
 *    settings, ingested as the scan job does.
 * 2. Fetch-only scan: the tree listing (GitHub's tree API when reachable, else `git ls-tree` of a
 *    blob-less fetch: names only, no file contents), then only the selected files read from
 *    raw.githubusercontent.com, written by materialiseRepo and ingested.
 * 3. The two inventories (and ingest warnings) must be identical.
 *
 * --record writes test/fixtures/sources/<owner>-<repo>-<sha7>.json.gz: the tree in GitHub's API
 * format and the fetched files, with the clone scan's inventory hash, for the offline test.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { installEnvProxy } from '../../src/core/proxy.js';
import { cloneEnv } from '../../src/ingest/git.js';
import { ingestDetailed } from '../../src/ingest/index.js';
import { selectInventoryFiles } from '../../src/ingest/select.js';
import { materialiseRepo } from '../../src/server/sources/materialise.js';
import { gitBlobSha, type TreeEntry } from '../../src/server/sources/testing.js';
import type { RepoInventoryFiles, SourceAdapter } from '../../src/server/sources/types.js';
import type { Inventory } from '../../src/core/types.js';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, '..', 'fixtures', 'sources');

export const DEFAULT_REPO = 'mochajs/mocha';
export const DEFAULT_COMMIT = 'a9fc5296831641fbbcc8862e561e498549d840dc';

const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=never', '-c', 'credential.helper='];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', [...SAFE_GIT, ...args], { cwd, env: cloneEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  return stdout;
}

export function inventoryHash(inv: Inventory): string {
  return createHash('sha256').update(JSON.stringify(inv)).digest('hex');
}

/** git ls-tree -r -t [-l] → GitHub tree API entries. */
export function parseLsTree(out: string, withSizes: boolean): TreeEntry[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const meta = line.slice(0, tab).trim().split(/\s+/);
      const path = line.slice(tab + 1);
      const [mode, type, sha, size] = meta as [string, TreeEntry['type'], string, string | undefined];
      const e: TreeEntry = { path, mode, type, sha };
      if (withSizes && type === 'blob' && size && size !== '-') e.size = Number(size);
      return e;
    });
}

async function fetchCommit(dir: string, url: string, sha: string, blobless: boolean): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-q', '--template=']);
  await git(dir, ['remote', 'add', 'origin', url]);
  await git(dir, ['fetch', '-q', '--depth', '1', '--no-tags', ...(blobless ? ['--filter=blob:none'] : []), 'origin', sha]);
}

async function treeFromApi(fullName: string, sha: string): Promise<TreeEntry[] | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}/git/trees/${sha}?recursive=1`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'blastradius-equivalence' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { tree: TreeEntry[]; truncated: boolean };
    return body.truncated ? null : body.tree;
  } catch {
    return null;
  }
}

/** A read-only adapter over public endpoints: just enough for materialiseRepo. */
function publicAdapter(tree: TreeEntry[], commit: string, fetched: Map<string, string>): SourceAdapter {
  const listing: RepoInventoryFiles = {
    commit,
    files: selectInventoryFiles(tree.filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755')).map((e) => e.path)).map((f) => ({
      ...f,
      size: tree.find((e) => e.path === f.path)?.size ?? 0,
    })),
    truncated: false,
  };
  return {
    host: 'github',
    listRepos: async () => [],
    getRepo: async () => null,
    defaultBranch: async () => 'main',
    findLockfiles: async () => listing,
    readFiles: async (_scope, fullName, ref, paths) => {
      const out = new Map<string, Uint8Array>();
      for (const p of paths) {
        const res = await fetch(`https://raw.githubusercontent.com/${fullName}/${ref}/${p.split('/').map(encodeURIComponent).join('/')}`);
        if (!res.ok) throw new Error(`raw ${p}: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fetched.set(p, buf.toString('utf8'));
        out.set(p, buf);
      }
      return out;
    },
    verifyWebhook: () => false,
    parsePush: () => null,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const record = args.includes('--record');
  const [fullName = DEFAULT_REPO, commit = DEFAULT_COMMIT] = args.filter((a) => !a.startsWith('--'));
  await installEnvProxy();
  const url = `https://github.com/${fullName}`;
  const work = mkdtempSync(join(tmpdir(), 'br-equivalence-'));
  try {
    // 1. Clone scan.
    const cloneDir = join(work, 'clone', 'repo');
    let t = performance.now();
    await fetchCommit(cloneDir, url, commit, false);
    await git(cloneDir, ['checkout', '-q', 'FETCH_HEAD']);
    const cloned = await ingestDetailed(cloneDir);
    const cloneMs = Math.round(performance.now() - t);

    // 2. Fetch-only scan.
    t = performance.now();
    let tree = await treeFromApi(fullName, commit);
    const treeSource = tree ? 'GitHub tree API' : 'git ls-tree of a blob-less fetch (API not reachable here)';
    if (!tree) {
      const listDir = join(work, 'list');
      await fetchCommit(listDir, url, commit, true);
      tree = parseLsTree(await git(listDir, ['ls-tree', '-r', '-t', 'FETCH_HEAD']), false);
    }
    const fetched = new Map<string, string>();
    const m = await materialiseRepo(publicAdapter(tree, commit, fetched), 'public', fullName, commit, { tmpDir: work });
    const viaFetch = await ingestDetailed(m.dir);
    const fetchMs = Math.round(performance.now() - t);

    const same = JSON.stringify(cloned.inventory) === JSON.stringify(viaFetch.inventory);
    const sameWarnings = JSON.stringify(cloned.warnings) === JSON.stringify(viaFetch.warnings);
    const summary = {
      repo: fullName,
      commit,
      treeSource,
      filesInTree: tree.filter((e) => e.type === 'blob').length,
      filesFetched: m.fetched.length,
      bytesFetched: [...fetched.values()].reduce((n, s) => n + Buffer.byteLength(s), 0),
      clone: { ms: cloneMs, assets: cloned.inventory.assets.length, components: cloned.inventory.components.length, edges: cloned.inventory.edges.length, sha256: inventoryHash(cloned.inventory) },
      fetchOnly: { ms: fetchMs, assets: viaFetch.inventory.assets.length, components: viaFetch.inventory.components.length, edges: viaFetch.inventory.edges.length, sha256: inventoryHash(viaFetch.inventory) },
      identicalInventory: same,
      identicalWarnings: sameWarnings,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!same || !sameWarnings) process.exitCode = 1;

    if (record && same) {
      // The fixture's tree comes from the clone (with sizes), in the API's shape; every recorded
      // file must hash to the blob id the tree lists.
      const fullTree = parseLsTree(await git(cloneDir, ['ls-tree', '-r', '-t', '-l', 'HEAD']), true);
      for (const [p, c] of fetched) {
        const e = fullTree.find((x) => x.path === p);
        if (!e || e.sha !== gitBlobSha(Buffer.from(c, 'utf8'))) throw new Error(`recorded ${p} does not match its blob id`);
      }
      mkdirSync(FIXTURE_DIR, { recursive: true });
      const file = join(FIXTURE_DIR, `${fullName.replace('/', '-')}-${commit.slice(0, 7)}.json.gz`);
      const fixture = {
        repo: fullName,
        commit,
        recordedAt: new Date().toISOString(),
        tree: fullTree,
        files: Object.fromEntries([...fetched.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
        cloneScan: { ...summary.clone, warnings: cloned.warnings },
      };
      writeFileSync(file, gzipSync(JSON.stringify(fixture), { level: 9 }));
      process.stdout.write(`recorded ${file}\n`);
    }
    await m.cleanup();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
