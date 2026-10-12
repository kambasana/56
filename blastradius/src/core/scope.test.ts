import { describe, expect, it } from 'vitest';
import { assetScopeCap, componentScopes, isProductionScope, pathScope, productionSet, scopeTier } from './scope.js';
import type { Asset, Inventory } from './types.js';

const repo = (id: string, environment: Asset['environment'] = 'prod'): Asset => ({ id, kind: 'repo', name: id, environment, criticality: 3, sourceFile: 'package.json' });

describe('one scope per (project, package)', () => {
  const inv: Inventory = {
    assets: [repo('repo:app'), repo('repo:examples', 'dev'), { id: 'workflow:ci.yml', kind: 'workflow', name: 'ci', environment: 'ci', criticality: 3, sourceFile: '.github/workflows/ci.yml' }],
    components: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => ({ purl: `pkg:npm/${n}@1.0.0`, ecosystem: 'npm' as const, name: n, version: '1.0.0' })),
    edges: [
      { from: 'repo:app', to: 'pkg:npm/a@1.0.0', scope: 'runtime', direct: true },
      { from: 'pkg:npm/a@1.0.0', to: 'pkg:npm/b@1.0.0', scope: 'optional', direct: false },
      { from: 'pkg:npm/a@1.0.0', to: 'pkg:npm/c@1.0.0', scope: 'peer', direct: false },
      { from: 'repo:app', to: 'pkg:npm/d@1.0.0', scope: 'dev', direct: true },
      // e: dev path and runtime path → runtime wins.
      { from: 'pkg:npm/d@1.0.0', to: 'pkg:npm/e@1.0.0', scope: 'runtime', direct: false },
      { from: 'pkg:npm/a@1.0.0', to: 'pkg:npm/e@1.0.0', scope: 'runtime', direct: false },
      // f: runtime of a dev-environment project only → dev.
      { from: 'repo:examples', to: 'pkg:npm/f@1.0.0', scope: 'runtime', direct: true },
      { from: 'workflow:ci.yml', to: 'pkg:npm/g@1.0.0', scope: 'build', direct: true },
    ],
  };
  const s = componentScopes(inv);
  it('takes the weakest link of a path and the strongest path', () => {
    expect(Object.fromEntries([...s].map(([p, v]) => [p.replace(/^pkg:npm\/|@1\.0\.0$/g, ''), v]))).toEqual({ a: 'runtime', b: 'optional', c: 'peer', d: 'dev', e: 'runtime', f: 'dev', g: 'ci', h: 'unreachable' });
  });
  it('only runtime is production', () => {
    expect([...productionSet(inv)].sort()).toEqual(['pkg:npm/a@1.0.0', 'pkg:npm/e@1.0.0']);
    expect(isProductionScope('optional')).toBe(false);
    expect(isProductionScope('peer')).toBe(false);
  });
  it('orders tiers production first and caps paths by the asset', () => {
    expect(['dev', 'runtime', 'ci', 'optional', 'peer', 'unreachable'].sort((a, b) => scopeTier(a as never) - scopeTier(b as never))).toEqual(['runtime', 'peer', 'optional', 'ci', 'dev', 'unreachable']);
    expect(assetScopeCap(repo('x', 'dev'))).toBe('dev');
    expect(pathScope(repo('x'), ['runtime', 'optional', 'runtime'])).toBe('optional');
  });
});
