/**
 * GitHub App adapter against a fake GitHub (throwaway RSA key, injected fetch): signatures,
 * push parsing, per-use installation tokens, tree selection, fetch-only materialisation, and
 * access-lost errors. No network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ingestDetailed } from '../../ingest/index.js';
import { selectInventoryFiles, touchesInventory } from '../../ingest/select.js';
import { GitHubAdapter, GitHubConfigError, githubConfigFromEnv, parseGitHubPush, signGitHubBody, verifyGitHubSignature } from './github.js';
import { checkTreePath, materialiseRepo } from './materialise.js';
import { FakeGitHub } from './testing.js';
import { SourceAccessError } from './types.js';

const tmp = mkdtempSync(join(tmpdir(), 'br-gh-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const LOCK = JSON.stringify({
  name: 'api',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'api', version: '1.0.0', dependencies: { ms: '2.1.3' } },
    'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: 'sha512-x' },
  },
});
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'api', version: '1.0.0', dependencies: { ms: '2.1.3' } }),
  'package-lock.json': LOCK,
  'packages/web/package.json': JSON.stringify({ name: 'web', dependencies: { once: '1.4.0' } }),
  'packages/web/yarn.lock': '# yarn lockfile v1\n',
  '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
  '.github/workflows/nested/skip.yml': 'on: push\n',
  'node_modules/x/package.json': '{}',
  'src/index.js': 'console.log(1)',
  'README.md': '# api',
};

describe('signatures', () => {
  const secret = 'a-throwaway-secret-of-some-length';
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  it('accepts the right HMAC and rejects anything else', () => {
    expect(verifyGitHubSignature(secret, body, signGitHubBody(secret, body))).toBe(true);
    expect(verifyGitHubSignature(secret, body, signGitHubBody(secret, body).toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
    expect(verifyGitHubSignature(secret, body, null)).toBe(false);
    expect(verifyGitHubSignature(secret, body, '')).toBe(false);
    expect(verifyGitHubSignature(secret, body, signGitHubBody('another-secret-entirely', body))).toBe(false);
    expect(verifyGitHubSignature(secret, Buffer.from(`${body.toString()} `), signGitHubBody(secret, body))).toBe(false);
    expect(verifyGitHubSignature(secret, body, 'sha1=abc')).toBe(false);
    expect(verifyGitHubSignature(secret, body, `sha256=${'0'.repeat(63)}`)).toBe(false);
    expect(verifyGitHubSignature('', body, signGitHubBody('', body))).toBe(false);
  });
});

describe('push parsing and path filtering', () => {
  const push = (commits: unknown[], extra: Record<string, unknown> = {}) =>
    parseGitHubPush({ ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { id: 7, full_name: 'acme/api' }, commits, ...extra })!;

  it('collects added, modified and removed paths', () => {
    const p = push([{ added: ['a.js'], modified: ['package-lock.json'], removed: [] }, { added: [], modified: ['docs/x.md'], removed: ['old/package.json'] }]);
    expect(p).toMatchObject({ repoId: '7', fullName: 'acme/api', ref: 'refs/heads/main', deleted: false, incomplete: false });
    expect(p!.changedPaths).toEqual(['a.js', 'docs/x.md', 'old/package.json', 'package-lock.json']);
  });

  it('marks pushes it cannot see in full as incomplete', () => {
    expect(push([]).incomplete).toBe(true);
    expect(push(Array.from({ length: 20 }, () => ({ modified: ['a.js'] }))).incomplete).toBe(true);
    expect(push([{ modified: ['a.js'] }], { forced: true }).incomplete).toBe(true);
    expect(push([], { deleted: true, after: '0'.repeat(40) })).toMatchObject({ deleted: true, after: null, incomplete: false });
    expect(parseGitHubPush({ zen: 'x' })).toBeNull();
    expect(parseGitHubPush(null)).toBeNull();
  });

  it('re-scans only for manifest, lockfile, workflow, Dockerfile or config paths', () => {
    for (const p of ['package.json', 'apps/web/package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', '.github/workflows/ci.yml', '.github/workflows/x.yaml', 'Dockerfile', 'svc/Dockerfile.prod', '.blastradius.yml']) {
      expect(touchesInventory([p]), p).toBe(true);
    }
    for (const p of ['src/index.ts', 'README.md', 'node_modules/a/package.json', '.github/workflows/nested/a.yml', '.github/dependabot.yml', 'docs/.blastradius.yml', 'package.json.bak']) {
      expect(touchesInventory([p]), p).toBe(false);
    }
    expect(touchesInventory([])).toBe(false);
  });

  it('selects what a directory walk would read', () => {
    expect(selectInventoryFiles(Object.keys(FILES)).map((f) => f.path)).toEqual([
      '.github/workflows/ci.yml',
      'package-lock.json',
      'package.json',
      'packages/web/package.json',
      'packages/web/yarn.lock',
    ]);
  });

  it('refuses tree paths that could escape', () => {
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a/./b', 'a\u0000b']) expect(checkTreePath(bad), bad).toBe(false);
    expect(checkTreePath('a/b/package.json')).toBe(true);
  });
});

describe('configuration from the environment', () => {
  it('is off when nothing is set and refuses partial settings without echoing values', () => {
    expect(githubConfigFromEnv({})).toBeNull();
    expect(() => githubConfigFromEnv({ BLASTRADIUS_GITHUB_APP_ID: '1' })).toThrow(GitHubConfigError);
    try {
      githubConfigFromEnv({ BLASTRADIUS_GITHUB_APP_ID: '1', BLASTRADIUS_GITHUB_WEBHOOK_SECRET: 'super-secret-value-123' });
    } catch (e) {
      expect(String(e)).not.toContain('super-secret-value-123');
    }
  });

  it('reads the key from a file and unescapes one-line keys', () => {
    const gh = new FakeGitHub();
    const keyFile = join(tmp, 'app.pem');
    writeFileSync(keyFile, gh.key.privateKey, { mode: 0o600 });
    const fromFile = githubConfigFromEnv({ BLASTRADIUS_GITHUB_APP_ID: '12', BLASTRADIUS_GITHUB_PRIVATE_KEY_FILE: keyFile, BLASTRADIUS_GITHUB_WEBHOOK_SECRET: gh.webhookSecret });
    expect(fromFile?.privateKey).toBe(gh.key.privateKey);
    const oneLine = githubConfigFromEnv({ BLASTRADIUS_GITHUB_APP_ID: '12', BLASTRADIUS_GITHUB_PRIVATE_KEY: gh.key.privateKey.replace(/\n/g, '\\n'), BLASTRADIUS_GITHUB_WEBHOOK_SECRET: gh.webhookSecret });
    expect(oneLine?.privateKey).toBe(gh.key.privateKey);
    expect(() => githubConfigFromEnv({ BLASTRADIUS_GITHUB_APP_ID: 'abc', BLASTRADIUS_GITHUB_PRIVATE_KEY: gh.key.privateKey, BLASTRADIUS_GITHUB_WEBHOOK_SECRET: gh.webhookSecret })).toThrow(/numeric/);
  });
});

describe('GitHubAdapter on a fake GitHub', () => {
  it('lists repos and reads lockfiles with a fresh, revoked token per operation', async () => {
    const gh = new FakeGitHub();
    gh.addRepo('acme/api', FILES);
    gh.addRepo('acme/docs', { 'README.md': '# docs' });
    gh.addInstallation(11, 'acme', ['acme/api', 'acme/docs']);
    const a = new GitHubAdapter(gh.config);

    const repos = await a.listRepos('11');
    expect(repos.map((r) => r.fullName).sort()).toEqual(['acme/api', 'acme/docs']);
    expect(await a.defaultBranch('11', 'acme/api')).toBe('main');
    const listing = await a.findLockfiles('11', 'acme/api', 'main');
    expect(listing.files.map((f) => f.path)).toEqual(gh.inventoryPaths('acme/api'));
    expect((await a.findLockfiles('11', 'acme/docs', 'main')).files).toEqual([]);
    // Three operations so far after listRepos and defaultBranch: each minted and revoked its own token.
    expect(gh.tokensMinted).toBe(4);
    expect(gh.tokensRevoked).toBe(4);
    // Only GET reads, plus token minting and revocation; JWT only for minting.
    for (const r of gh.log) {
      if (r.auth === 'jwt') expect(r.path).toMatch(/^\/app\/installations\/11\/access_tokens$/);
      else expect(r.method === 'GET' || (r.method === 'DELETE' && r.path === '/installation/token')).toBe(true);
    }
  });

  it('gives concurrent operations on one installation their own tokens (found by the GitHub simulator)', async () => {
    const gh = new FakeGitHub();
    gh.addRepo('acme/api', FILES);
    gh.addRepo('acme/docs', { 'README.md': '# docs' });
    gh.addInstallation(12, 'acme', ['acme/api', 'acme/docs']);
    const a = new GitHubAdapter(gh.config);
    // Discovery inspects repos two at a time: a shared token would be revoked by the first to finish.
    const out = await Promise.all([a.findLockfiles('12', 'acme/api', 'main'), a.findLockfiles('12', 'acme/docs', 'main'), a.listRepos('12')]);
    expect(out[2].length).toBe(2);
    expect(gh.tokensMinted).toBe(3);
    expect(gh.tokensRevoked).toBe(3);
  });

  it('materialises only the inventory files and ingests them like a checkout', async () => {
    const gh = new FakeGitHub();
    gh.addRepo('acme/api', FILES);
    gh.addInstallation(11, 'acme', ['acme/api']);
    const a = new GitHubAdapter(gh.config);
    const m = await materialiseRepo(a, '11', 'acme/api', 'main', { tmpDir: tmp });
    try {
      expect(m.fetched.sort()).toEqual(['.github/workflows/ci.yml', 'package-lock.json', 'package.json', 'packages/web/package.json']);
      expect(readFileSync(join(m.dir, 'packages/web/yarn.lock'), 'utf8')).toBe(''); // placeholder: presence only
      expect(() => statSync(join(m.dir, 'src/index.js'))).toThrow();
      // The same files laid out as a checkout give the same inventory.
      const checkout = join(tmp, 'checkout', 'repo');
      for (const [p, c] of Object.entries(FILES)) {
        mkdirSync(dirname(join(checkout, p)), { recursive: true });
        writeFileSync(join(checkout, p), c);
      }
      const fetched = await ingestDetailed(m.dir);
      const cloned = await ingestDetailed(checkout);
      expect(fetched.inventory).toEqual(cloned.inventory);
      expect(fetched.warnings).toEqual(cloned.warnings);
      expect(fetched.inventory.components.map((c) => c.purl)).toContain('pkg:npm/ms@2.1.3');
    } finally {
      await m.cleanup();
    }
  });

  it('writes oversized files as sparse placeholders so ingest skips them the same way', async () => {
    const gh = new FakeGitHub();
    gh.addRepo('acme/big', { 'package.json': '{"name":"big"}', 'package-lock.json': LOCK });
    gh.addInstallation(11, 'acme', ['acme/big']);
    const a = new GitHubAdapter(gh.config);
    const m = await materialiseRepo(a, '11', 'acme/big', 'main', { tmpDir: tmp, maxLockfileBytes: 10 });
    try {
      expect(m.fetched).toEqual(['package.json']);
      expect(statSync(join(m.dir, 'package-lock.json')).size).toBe(Buffer.byteLength(LOCK));
      const res = await ingestDetailed(m.dir, { maxLockfileBytes: 10 });
      expect(res.warnings.join('\n')).toMatch(/package-lock\.json is \d+ bytes, over the 10-byte limit/);
    } finally {
      await m.cleanup();
    }
  });

  it('reports a revoked or suspended installation as lost scope access, and a missing repo as lost repo access', async () => {
    const gh = new FakeGitHub();
    gh.addRepo('acme/api', FILES);
    const inst = gh.addInstallation(11, 'acme', ['acme/api']);
    const a = new GitHubAdapter(gh.config);
    await expect(a.findLockfiles('11', 'acme/other', 'main')).rejects.toMatchObject({ name: 'SourceAccessError', level: 'repo' });
    expect(await a.getRepo('11', 'acme/other')).toBeNull();
    inst.suspended = true;
    await expect(a.listRepos('11')).rejects.toBeInstanceOf(SourceAccessError);
    inst.suspended = false;
    inst.revoked = true;
    await expect(a.listRepos('11')).rejects.toMatchObject({ level: 'scope', status: 404 });
    await expect(a.getInstallation('11')).rejects.toMatchObject({ level: 'scope' });
    await expect(a.listRepos('not-a-number')).rejects.toBeInstanceOf(SourceAccessError);
  });

  it('builds the install URL and checks the installer through OAuth', async () => {
    const gh = new FakeGitHub();
    gh.addInstallation(11, 'acme');
    gh.addInstallation(12, 'other');
    const a = new GitHubAdapter(gh.config);
    expect(await a.installUrl('st.ate')).toBe('https://github.com/apps/blastradius-test/installations/new?state=st.ate');
    expect(await a.getInstallation('11')).toMatchObject({ id: '11', account: 'acme', repositorySelection: 'selected', suspended: false });
    expect(await a.installerCanSee(gh.issueCode([11]), '11')).toBe(true);
    expect(await a.installerCanSee(gh.issueCode([11]), '12')).toBe(false);
    expect(await a.installerCanSee('forged-code', '11')).toBe(false);
    const code = gh.issueCode([11]);
    expect(await a.installerCanSee(code, '11')).toBe(true);
    expect(await a.installerCanSee(code, '11')).toBe(false); // codes are single-use
    expect(gh.userTokensRevoked).toBe(3); // every user token obtained was revoked after the check
  });
});
