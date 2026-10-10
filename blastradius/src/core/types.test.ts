import { describe, expect, it } from 'vitest';
import {
  factsFor,
  formatPurl,
  isFactOf,
  levelForScore,
  makeFact,
  normalizePurl,
  npmNameFromPurl,
  npmPurl,
  parsePurl,
  PurlParseError,
  summarizeInventory,
  unversionedPurl,
  type Fact,
  type Inventory,
} from './types.js';

describe('purl', () => {
  it('parses and formats scoped npm purls', () => {
    const p = parsePurl('pkg:npm/%40babel/core@7.24.0');
    expect(p).toEqual({ type: 'npm', namespace: '@babel', name: 'core', version: '7.24.0' });
    expect(formatPurl(p)).toBe('pkg:npm/%40babel/core@7.24.0');
  });

  it('tolerates a raw @ scope and normalises case', () => {
    expect(normalizePurl('pkg:npm/@Babel/Core@7.24.0')).toBe('pkg:npm/%40babel/core@7.24.0');
  });

  it('builds npm purls from package names', () => {
    expect(npmPurl('lodash', '4.17.21')).toBe('pkg:npm/lodash@4.17.21');
    expect(npmPurl('@types/node')).toBe('pkg:npm/%40types/node');
    expect(npmNameFromPurl('pkg:npm/%40types/node@1.0.0')).toBe('@types/node');
  });

  it('handles qualifiers, subpath and other types', () => {
    const s = 'pkg:githubactions/actions/checkout@v4?b=2&a=1#sub/dir';
    const p = parsePurl(s);
    expect(p.namespace).toBe('actions');
    expect(p.qualifiers).toEqual({ a: '1', b: '2' });
    expect(p.subpath).toBe('sub/dir');
    expect(formatPurl(p)).toBe('pkg:githubactions/actions/checkout@v4?a=1&b=2#sub/dir');
  });

  it('round-trips prerelease and build versions', () => {
    expect(normalizePurl('pkg:npm/x@1.0.0-beta.1%2Bbuild')).toBe('pkg:npm/x@1.0.0-beta.1%2Bbuild');
  });

  it('strips version for unversioned form', () => {
    expect(unversionedPurl('pkg:npm/%40a/b@1.2.3')).toBe('pkg:npm/%40a/b');
  });

  it.each(['', 'npm/x', 'pkg:npm', 'pkg:npm/x@', 'pkg:np m/x', 'pkg:npm/%E0%A4%A'])('rejects %j', (s) => {
    expect(() => parsePurl(s)).toThrow(PurlParseError);
  });
});

describe('levels', () => {
  it('maps thresholds', () => {
    expect(levelForScore(100)).toBe('critical');
    expect(levelForScore(80)).toBe('critical');
    expect(levelForScore(79.9)).toBe('high');
    expect(levelForScore(60)).toBe('high');
    expect(levelForScore(59)).toBe('medium');
    expect(levelForScore(30)).toBe('medium');
    expect(levelForScore(29.99)).toBe('low');
    expect(levelForScore(0)).toBe('low');
  });
});

describe('facts', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const facts: Fact[] = [
    makeFact('vuln', 'pkg:npm/a@1.0.0', { id: 'GHSA-1', aliases: [], severity: 'high', fixedVersions: ['1.0.1'] }, { source: 'osv', fetchedAt: now }),
    makeFact('maintainers', 'pkg:npm/a', { maintainers: [{ name: 'x' }], count: 1 }, { source: 'npm', fetchedAt: now, evidence: ['https://registry.npmjs.org/a'] }),
    makeFact('vuln', 'pkg:npm/a@2.0.0', { id: 'GHSA-2', aliases: [], severity: 'low', fixedVersions: [] }, { source: 'osv', fetchedAt: now }),
  ];

  it('matches versioned and unversioned subjects', () => {
    expect(factsFor(facts, 'pkg:npm/a@1.0.0')).toHaveLength(2);
    const vulns = factsFor(facts, 'pkg:npm/a@1.0.0', 'vuln');
    expect(vulns.map((f) => f.value.id)).toEqual(['GHSA-1']);
  });

  it('narrows by kind', () => {
    const m = facts.filter(isFactOf('maintainers'));
    expect(m[0]?.value.count).toBe(1);
    expect(m[0]?.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('summarizeInventory', () => {
  it('counts', () => {
    const inv: Inventory = {
      assets: [{ id: 'repo:x', kind: 'repo', name: 'x', environment: 'prod', criticality: 3, sourceFile: 'package.json' }],
      components: [
        { purl: 'pkg:npm/a@1.0.0', ecosystem: 'npm', name: 'a', version: '1.0.0', hasInstallScript: true },
        { purl: 'pkg:npm/b@1.0.0', ecosystem: 'npm', name: 'b', version: '1.0.0' },
      ],
      edges: [
        { from: 'repo:x', to: 'pkg:npm/a@1.0.0', scope: 'runtime', direct: true },
        { from: 'pkg:npm/a@1.0.0', to: 'pkg:npm/b@1.0.0', scope: 'runtime', direct: false },
      ],
    };
    expect(summarizeInventory(inv)).toEqual({
      assets: 1,
      components: 2,
      edges: 2,
      directComponents: 1,
      byEcosystem: { npm: 2 },
      byScope: { runtime: 2 },
      withInstallScripts: 1,
    });
  });
});
