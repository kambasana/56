import { describe, expect, it } from 'vitest';
import type { Asset } from '../core/types.js';
import { applyOverrides, inferEnvironment, parseConfig, segmentMatch } from './config.js';

const asset = (sourceFile: string, kind: Asset['kind'] = 'repo'): Asset => ({
  id: `${kind}:${sourceFile}`,
  kind,
  name: sourceFile,
  environment: 'prod',
  criticality: 3,
  sourceFile,
});

describe('inferEnvironment', () => {
  it('uses path heuristics', () => {
    expect(inferEnvironment('', 'repo')).toBe('prod');
    expect(inferEnvironment('packages/api', 'repo')).toBe('prod');
    expect(inferEnvironment('docs/site', 'repo')).toBe('dev');
    expect(inferEnvironment('examples/basic', 'repo')).toBe('dev');
    expect(inferEnvironment('tools/gen', 'repo')).toBe('dev');
    expect(inferEnvironment('deploy/staging/Dockerfile', 'image')).toBe('staging');
    expect(inferEnvironment('anything', 'workflow')).toBe('ci');
  });
});

describe('parseConfig / applyOverrides', () => {
  it('validates entries and applies the longest match', () => {
    const { config, warnings } = parseConfig(
      'assets:\n  - path: ./\n    criticality: 2\n  - path: packages/*\n    environment: staging\n  - path: packages/api\n    criticality: 5\n  - path: x\n    environment: moon\n    criticality: 9\n  - nopath: 1\n',
    );
    expect(warnings).toHaveLength(3);
    expect(applyOverrides(asset('package.json'), config, '')).toMatchObject({ criticality: 2, environment: 'prod' });
    expect(applyOverrides(asset('packages/web/package.json'), config, 'packages/web')).toMatchObject({ environment: 'staging', criticality: 3 });
    expect(applyOverrides(asset('packages/api/package.json'), config, 'packages/api')).toMatchObject({ criticality: 5, environment: 'prod' });
  });

  it('reports bad YAML without throwing', () => {
    expect(parseConfig('assets: [').warnings[0]).toMatch(/invalid YAML/);
    expect(parseConfig('').config.assets).toEqual([]);
  });

  // Regression: a hostile repo must not be able to abort its own scan with an alias bomb.
  it('turns an alias bomb into a warning and an empty config', () => {
    const bomb =
      'a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n' +
      'd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\nassets: []\n';
    const r = parseConfig(bomb);
    expect(r.config.assets).toEqual([]);
    expect(r.warnings[0]).toMatch(/could not load/);
  });

  it('matches * within a segment like a glob', () => {
    expect(segmentMatch('pkg-*', 'pkg-api')).toBe(true);
    expect(segmentMatch('*-api', 'pkg-api')).toBe(true);
    expect(segmentMatch('a*b*c', 'axxbyyc')).toBe(true);
    expect(segmentMatch('a*b*c', 'axxbyy')).toBe(false);
    expect(segmentMatch('*', '')).toBe(true);
    expect(segmentMatch('a.b*', 'aXb')).toBe(false); // no regex semantics
    expect(segmentMatch('exact', 'exact')).toBe(true);
  });

  // Regression: untrusted patterns × untrusted directory names used to backtrack polynomially.
  it('matches pathological wildcard patterns in linear time', () => {
    const { config } = parseConfig('assets:\n  - path: "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b"\n    criticality: 5\n');
    const dir = 'a'.repeat(5000);
    const t = Date.now();
    expect(applyOverrides(asset(`${dir}/package.json`), config, dir).criticality).toBe(3);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
