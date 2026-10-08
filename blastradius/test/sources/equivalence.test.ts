/**
 * Connector proof 1, offline: the recorded tree and files of mochajs/mocha at a pinned commit,
 * served by a fake GitHub through the real GitHubAdapter, give exactly the inventory the clone
 * scan of that commit gave when recorded (test/sources/equivalence.ts --record; the live run
 * compares the two directly).
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { ingestDetailed } from '../../src/ingest/index.js';
import { GitHubAdapter } from '../../src/server/sources/github.js';
import { materialiseRepo } from '../../src/server/sources/materialise.js';
import { FakeGitHub, gitBlobSha, type TreeEntry } from '../../src/server/sources/testing.js';
import { DEFAULT_COMMIT, DEFAULT_REPO, FIXTURE_DIR, inventoryHash } from './equivalence.js';

interface Fixture {
  repo: string;
  commit: string;
  tree: TreeEntry[];
  files: Record<string, string>;
  cloneScan: { assets: number; components: number; edges: number; sha256: string; warnings: string[] };
}

const fixture = JSON.parse(gunzipSync(readFileSync(join(FIXTURE_DIR, 'mochajs-mocha-a9fc529.json.gz'))).toString('utf8')) as Fixture;
const tmp = mkdtempSync(join(tmpdir(), 'br-equiv-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('fetch-only scan equals the clone scan (mochajs/mocha, recorded)', () => {
  it('recorded files match the blob ids in the recorded tree', () => {
    expect(fixture.repo).toBe(DEFAULT_REPO);
    expect(fixture.commit).toBe(DEFAULT_COMMIT);
    for (const [p, c] of Object.entries(fixture.files)) {
      expect(fixture.tree.find((e) => e.path === p)?.sha, p).toBe(gitBlobSha(Buffer.from(c, 'utf8')));
    }
  });

  it('GitHubAdapter + materialise + ingest reproduce the clone inventory', async () => {
    const gh = new FakeGitHub();
    gh.addRecordedCommit(fixture.repo, fixture.commit, fixture.tree, fixture.files, { defaultBranch: 'main' });
    gh.addInstallation(99, 'mochajs', [fixture.repo]);
    const adapter = new GitHubAdapter(gh.config);
    const m = await materialiseRepo(adapter, '99', fixture.repo, 'main', { tmpDir: tmp });
    try {
      expect(m.commit).toBe(fixture.commit);
      // Only the inventory files are read: 29 of 692.
      expect(m.fetched.sort()).toEqual(Object.keys(fixture.files).sort());
      expect(fixture.tree.filter((e) => e.type === 'blob').length).toBeGreaterThan(m.fetched.length * 10);
      const res = await ingestDetailed(m.dir);
      expect({ assets: res.inventory.assets.length, components: res.inventory.components.length, edges: res.inventory.edges.length }).toEqual({
        assets: fixture.cloneScan.assets,
        components: fixture.cloneScan.components,
        edges: fixture.cloneScan.edges,
      });
      expect(inventoryHash(res.inventory)).toBe(fixture.cloneScan.sha256);
      expect(res.warnings).toEqual(fixture.cloneScan.warnings);
    } finally {
      await m.cleanup();
    }
  });
});
