import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { npmPurl, summarizeInventory } from '../core/types.js';
import { ingest, ingestDetailed, parseCycloneDx, repoNameFromUrl } from './index.js';

const FIX = fileURLToPath(new URL('../../test/fixtures/ingest/', import.meta.url));
const tmpRoots: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'br-ingest-test-'));
  tmpRoots.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe('ingest: npm workspace monorepo (lockfile v3)', async () => {
  const res = await ingestDetailed(path.join(FIX, 'lock-v3'));
  const inv = res.inventory;
  const asset = (id: string) => inv.assets.find((a) => a.id === id);

  it('creates one asset per package root, workflow and Dockerfile', () => {
    expect(inv.assets.map((a) => a.id)).toEqual([
      'image:Dockerfile',
      'repo:@acme/web',
      'repo:acme-docs',
      'repo:acme-platform',
      'workflow:.github/workflows/ci.yml',
      'workflow:.github/workflows/release.yml',
    ]);
  });

  it('applies heuristics and .blastradius.yml overrides', () => {
    expect(asset('repo:acme-platform')).toMatchObject({ environment: 'prod', criticality: 4, sourceFile: 'package.json' });
    expect(asset('repo:@acme/web')).toMatchObject({ environment: 'prod', criticality: 5, sourceFile: 'packages/web/package.json' });
    expect(asset('repo:acme-docs')).toMatchObject({ environment: 'dev', criticality: 4 });
    expect(asset('workflow:.github/workflows/release.yml')).toMatchObject({ environment: 'ci', criticality: 5, ci: { hasOidc: true, publishes: true } });
    expect(asset('image:Dockerfile')).toMatchObject({ kind: 'image', environment: 'prod', criticality: 4 });
  });

  it('merges npm, actions and docker components', () => {
    const s = summarizeInventory(inv);
    expect(s.byEcosystem.npm).toBe(13); // 12 from the lockfile + marked@4.0.10 from docs (exact pin)
    expect(s.byEcosystem.githubactions).toBe(5); // checkout@sha shared by both workflows
    expect(s.byEcosystem.docker).toBe(6);
    expect(s.withInstallScripts).toBe(2);
    expect(inv.components.find((c) => c.purl === npmPurl('marked', '4.0.10'))).toBeDefined();
    // purls unique
    expect(new Set(inv.components.map((c) => c.purl)).size).toBe(inv.components.length);
  });

  it('keeps edges consistent with the contract', () => {
    const ids = new Set(inv.assets.map((a) => a.id));
    const purls = new Set(inv.components.map((c) => c.purl));
    for (const e of inv.edges) {
      expect(purls.has(e.to)).toBe(true);
      expect(e.direct).toBe(ids.has(e.from));
      if (!e.direct) expect(purls.has(e.from)).toBe(true);
    }
    expect(inv.edges).toContainEqual({ from: 'workflow:.github/workflows/ci.yml', to: 'pkg:githubactions/tj-actions/changed-files@main', scope: 'build', direct: true });
  });

  it('exposes workflow info for the outbound score', () => {
    expect(res.workflows.map((w) => w.path)).toEqual(['.github/workflows/ci.yml', '.github/workflows/release.yml']);
    expect(res.workflows[0]!.privilegedTriggers).toEqual(['pull_request_target']);
    expect(res.warnings.some((w) => /highlight\.js|range/.test(w))).toBe(true);
  });

  it('is deterministic', async () => {
    expect(await ingest(path.join(FIX, 'lock-v3'))).toEqual(inv);
  });
});

describe('ingest: lockfile v1 and manifest-only roots', () => {
  it('ingests a v1 lockfile', async () => {
    const inv = await ingest(path.join(FIX, 'lock-v1'));
    expect(inv.assets).toEqual([{ id: 'repo:legacy-app', kind: 'repo', name: 'legacy-app', environment: 'prod', criticality: 3, sourceFile: 'package.json' }]);
    expect(inv.edges.filter((e) => e.direct)).toHaveLength(4);
    expect(inv.components.some((c) => c.purl === npmPurl('flatmap-stream', '0.1.1'))).toBe(true);
  });

  it('warns about unsupported lockfiles and unresolved ranges', async () => {
    const warnings: string[] = [];
    const inv = await ingest(path.join(FIX, 'no-lock'), { warn: (m) => warnings.push(m) });
    expect(inv.components.map((c) => c.purl)).toEqual([npmPurl('chalk', '5.3.0'), npmPurl('left-pad', '1.3.0')]);
    expect(warnings.join('\n')).toMatch(/yarn\.lock is not supported yet.*2 dependency range/);
  });
});

describe('ingest: path safety', () => {
  it('never follows symlinks out of the target and caps file sizes', async () => {
    const outside = tmp();
    writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'secret', dependencies: { x: '1.0.0' } }));
    const root = tmp();
    mkdirSync(path.join(root, 'linked-dir'));
    symlinkSync(outside, path.join(root, 'escape-dir'), 'dir');
    symlinkSync(path.join(outside, 'package.json'), path.join(root, 'linked-dir', 'package.json'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'safe', dependencies: { y: '2.0.0' } }));
    mkdirSync(path.join(root, 'big'));
    writeFileSync(path.join(root, 'big', 'package.json'), JSON.stringify({ name: 'big', description: 'x'.repeat(5000) }));
    mkdirSync(path.join(root, 'node_modules', 'z'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'z', 'package.json'), '{"name":"z"}');

    const res = await ingestDetailed(root, { maxFileBytes: 1000 });
    expect(res.inventory.assets.map((a) => a.name)).toEqual(['safe']);
    expect(res.inventory.components.map((c) => c.purl)).toEqual([npmPurl('y', '2.0.0')]);
    expect(res.warnings.some((w) => /symlink not followed: escape-dir/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /symlink not followed: linked-dir\/package.json/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /big\/package.json.*limit/.test(w))).toBe(true);
  });

  it('survives malformed files', async () => {
    const root = tmp();
    writeFileSync(path.join(root, 'package.json'), '{not json');
    writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/__proto__":{"version":"1.0.0"},"node_modules/ok":{"version":"1.0.0"}}}');
    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(root, '.github', 'workflows', 'bad.yml'), 'on: [');
    const res = await ingestDetailed(root);
    expect(res.inventory.components.map((c) => c.purl)).toEqual([npmPurl('ok', '1.0.0')]);
    expect(res.warnings.some((w) => /could not parse package.json/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /could not parse workflow/.test(w))).toBe(true);
  });
});

describe('ingest: git URL targets', () => {
  it('clones via the injected runner, scans, then removes the clone', async () => {
    let cloneDir = '';
    const res = await ingestDetailed('https://github.com/acme/legacy-app.git', {
      git: {
        tmpDir: tmp(),
        runner: async (args) => {
          cloneDir = args[args.length - 1]!;
          cpSync(path.join(FIX, 'lock-v1'), cloneDir, { recursive: true });
        },
      },
    });
    expect(res.target).toBe('https://github.com/acme/legacy-app.git');
    expect(res.inventory.assets[0]?.id).toBe('repo:legacy-app');
    expect(cloneDir).not.toBe('');
    expect(existsSync(cloneDir)).toBe(false); // clone was removed
  });

  it('refuses non-https/ssh URLs', async () => {
    await expect(ingest('http://example.com/x.git')).rejects.toThrow(/refusing to clone/);
  });

  it('derives a repo name', () => {
    expect(repoNameFromUrl('git@github.com:o/my-repo.git')).toBe('my-repo');
    expect(repoNameFromUrl('https://github.com/o/r/')).toBe('r');
  });
});

describe('syft adapter', () => {
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    components: [
      { 'bom-ref': 'a', type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0' },
      { 'bom-ref': 'b', type: 'library', name: 'requests', version: '2.31.0', purl: 'pkg:pypi/requests@2.31.0' },
      { 'bom-ref': 'c', type: 'library', name: 'urllib3', version: '2.2.0', purl: 'pkg:pypi/urllib3@2.2.0' },
      { 'bom-ref': 'd', type: 'library', name: 'nover', purl: 'pkg:npm/nover' },
      { 'bom-ref': 'e', type: 'file', name: 'x' },
    ],
    dependencies: [{ ref: 'b', dependsOn: ['c', 'zzz'] }],
  };

  it('parses CycloneDX components and dependencies', () => {
    const r = parseCycloneDx(bom);
    expect(r.components.map((c) => [c.purl, c.ecosystem])).toEqual([
      ['pkg:npm/left-pad@1.3.0', 'npm'],
      ['pkg:pypi/requests@2.31.0', 'generic'],
      ['pkg:pypi/urllib3@2.2.0', 'generic'],
    ]);
    expect(r.dependencies.get('pkg:pypi/requests@2.31.0')).toEqual(['pkg:pypi/urllib3@2.2.0']);
    expect(r.warnings[0]).toMatch(/2 component/);
  });

  it('merges only new components when enabled', async () => {
    const res = await ingestDetailed(path.join(FIX, 'no-lock'), { syft: true, syftRunner: async () => parseCycloneDx(bom) });
    const purls = res.inventory.components.map((c) => c.purl);
    expect(purls).toContain('pkg:pypi/requests@2.31.0');
    expect(res.inventory.edges).toContainEqual({ from: 'repo:tiny', to: 'pkg:pypi/requests@2.31.0', scope: 'runtime', direct: true });
    expect(res.inventory.edges).toContainEqual({ from: 'pkg:pypi/requests@2.31.0', to: 'pkg:pypi/urllib3@2.2.0', scope: 'runtime', direct: false });
    expect(res.inventory.edges.some((e) => e.to === 'pkg:pypi/urllib3@2.2.0' && e.direct)).toBe(false);
  });

  it('skips quietly with a warning when syft is absent', async () => {
    const res = await ingestDetailed(path.join(FIX, 'no-lock'), { syft: true, syftRunner: async () => null });
    expect(res.warnings.some((w) => /syft not found/.test(w))).toBe(true);
  });
});

describe('walkTarget: workflow detection', () => {
  it('only treats root-level .github/workflows/*.yml|yaml as workflows (case-insensitive)', async () => {
    const { walkTarget } = await import('./fs.js');
    const root = tmp();
    for (const rel of ['.github/workflows/ci.yml', '.GitHub/Workflows/Release.YAML', 'packages/a/.github/workflows/nested.yml', 'vendor/x/.github/workflows/y.yaml', '.github/workflows/sub/deep.yml']) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), 'on: push\n');
    }
    const found = await walkTarget(root);
    expect(found.workflows.sort()).toEqual(['.GitHub/Workflows/Release.YAML', '.github/workflows/ci.yml']);
  });
});
