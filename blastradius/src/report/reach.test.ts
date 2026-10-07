import { describe, expect, it } from 'vitest';
import { describeReach } from './reach.js';

const finding = (assets: { assetId: string; exposure: number; paths: string[][] }[]) => ({ blastRadius: { assets, score: 1 } });

describe('describeReach', () => {
  it('names the direct dependency that brings a transitive package in', () => {
    const f = finding([{ assetId: 'repo:payments-api', exposure: 1, paths: [['repo:payments-api', 'pkg:npm/event-stream@3.3.6', 'pkg:npm/flatmap-stream@0.1.1']] }]);
    expect(describeReach(f, () => ({ name: 'payments-api', environment: 'prod' }))).toBe('Brought in by event-stream · used by payments-api (production)');
  });
  it('says direct dependency, and dev/test only when every path is a dev path', () => {
    const f = finding([{ assetId: 'repo:web', exposure: 0.3, paths: [['repo:web', 'pkg:npm/mocha@10.0.0']] }]);
    expect(describeReach(f)).toBe('Direct dependency · used by web (dev/test dependencies only)');
  });
  it('lists several assets and introducers compactly, scoped names included', () => {
    const f = finding([
      { assetId: 'repo:a', exposure: 1, paths: [['repo:a', 'pkg:npm/%40babel/core@7.0.0', 'pkg:npm/x@1.0.0']] },
      { assetId: 'repo:b', exposure: 1, paths: [['repo:b', 'pkg:npm/tslint@5.0.0', 'pkg:npm/y@1.0.0', 'pkg:npm/x@1.0.0'], ['repo:b', 'pkg:npm/z@1.0.0', 'pkg:npm/x@1.0.0']] },
      { assetId: 'workflow:.github/workflows/ci.yml', exposure: 1, paths: [['workflow:.github/workflows/ci.yml', 'pkg:npm/q@1.0.0', 'pkg:npm/x@1.0.0']] },
    ]);
    const envs: Record<string, 'prod' | 'dev' | 'ci'> = { 'repo:a': 'prod', 'repo:b': 'dev' };
    expect(describeReach(f, (id) => (envs[id] ? { name: id.slice(5), environment: envs[id]! } : undefined))).toBe(
      'Brought in by @babel/core, z and 2 more · used by 3 parts of this project (a, b and 1 more) (1 in production)',
    );
  });
  it('says so when no path reaches the component', () => {
    expect(describeReach(finding([]))).toMatch(/no dependency path/);
  });
});
