import { describe, expect, it } from 'vitest';
import { matchAdvisories, nameMatches, purlIdentity, searchExposure } from './match.js';
import type { Inventory } from '../core/types.js';

const inv: Inventory = {
  assets: [
    { id: 'repo:app', kind: 'repo', name: 'app', environment: 'prod', criticality: 3, sourceFile: 'requirements.txt' },
    { id: 'workflow:.github/workflows/ci.yml', kind: 'workflow', name: 'ci', environment: 'ci', criticality: 3, sourceFile: '.github/workflows/ci.yml' },
    { id: 'image:Dockerfile', kind: 'image', name: 'Dockerfile', environment: 'prod', criticality: 3, sourceFile: 'Dockerfile' },
  ],
  components: [
    { purl: 'pkg:pypi/pyyaml@6.0.2', ecosystem: 'pypi', name: 'pyyaml', version: '6.0.2' },
    { purl: 'pkg:githubactions/actions/checkout@v4', ecosystem: 'githubactions', name: 'actions/checkout', version: 'v4' },
    { purl: 'pkg:docker/library/node@22', ecosystem: 'docker', name: 'library/node', version: '22' },
  ],
  edges: [
    { from: 'repo:app', to: 'pkg:pypi/pyyaml@6.0.2', scope: 'runtime', direct: true },
    { from: 'workflow:.github/workflows/ci.yml', to: 'pkg:githubactions/actions/checkout@v4', scope: 'build', direct: true },
    { from: 'image:Dockerfile', to: 'pkg:docker/library/node@22', scope: 'runtime', direct: true },
  ],
};
const stored = [{ projectId: 'p1', projectName: 'app', inventory: inv }];

describe('exposure search for every purl type', () => {
  it('finds PyPI packages by any spelling of the name, with version', () => {
    expect(searchExposure(stored, { name: 'PyYAML' }).map((h) => h.purl)).toEqual(['pkg:pypi/pyyaml@6.0.2']);
    expect(searchExposure(stored, { name: 'pyyaml', version: '6.0.2' })[0]).toMatchObject({ production: true, scope: 'runtime', ecosystem: 'pypi' });
    expect(searchExposure(stored, { name: 'pyyaml', version: '5.4' })).toEqual([]);
  });
  it('finds GitHub Actions and Docker images; CI is never production', () => {
    expect(searchExposure(stored, { name: 'actions/checkout' })[0]).toMatchObject({ purl: 'pkg:githubactions/actions/checkout@v4', production: false, scope: 'ci' });
    expect(searchExposure(stored, { name: 'node' }).map((h) => h.purl)).toEqual(['pkg:docker/library/node@22']);
    expect(searchExposure(stored, { name: 'pkg:githubactions/actions/checkout@v4' })).toHaveLength(1);
  });
  it('matches names with each ecosystem\'s rules', () => {
    expect(nameMatches(purlIdentity('pkg:pypi/zope-interface@7.0')!, 'zope.interface')).toBe(true);
    expect(nameMatches(purlIdentity('pkg:npm/%40babel/core@7.0.0')!, '@babel/core')).toBe(true);
    expect(nameMatches(purlIdentity('pkg:npm/%40babel/core@7.0.0')!, 'core')).toBe(false);
  });
  it('matches OSV advisories for PyPI and GitHub Actions too', () => {
    const hits = matchAdvisories(stored, [
      { id: 'GHSA-pypi', affected: [{ package: { name: 'PyYAML', ecosystem: 'PyPI' }, versions: ['6.0.2'] }] },
      { id: 'GHSA-gha', affected: [{ package: { name: 'actions/checkout', ecosystem: 'GitHub Actions' }, ranges: [{ events: [{ introduced: '0' }] }] }] },
    ]);
    expect(hits.map((h) => `${h.purl} ${h.advisoryId}`)).toEqual(['pkg:githubactions/actions/checkout@v4 GHSA-gha', 'pkg:pypi/pyyaml@6.0.2 GHSA-pypi']);
  });
});
