import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { npmPurl } from '../core/types.js';
import { componentsFromManifest, nameFromInstallPath, parsePackageJson, parsePackageLock, resolveLockVersion } from './npm.js';

const fx = (p: string) => readFileSync(fileURLToPath(new URL(`../../test/fixtures/ingest/${p}`, import.meta.url)), 'utf8');

describe('parsePackageJson', () => {
  it('reads dependency sections and install hooks, ignoring junk', () => {
    const m = parsePackageJson(
      JSON.stringify({
        name: 'App',
        dependencies: { a: '^1', 'bad name!': '1.0.0', b: 5 },
        devDependencies: { c: '1.0.0' },
        scripts: { postinstall: 'node x.js', test: 'vitest' },
        workspaces: { packages: ['packages/*'] },
      }),
    );
    expect(m.name).toBe('app');
    expect(m.dependencies).toEqual({ a: '^1' });
    expect(m.devDependencies).toEqual({ c: '1.0.0' });
    expect(m.installHooks).toEqual(['postinstall']);
    expect(m.workspaces).toEqual(['packages/*']);
  });

  it('does not let __proto__ keys pollute anything', () => {
    const m = parsePackageJson('{"dependencies":{"__proto__":{"x":1},"ok":"1.0.0"}}');
    expect(m.dependencies).toEqual({ ok: '1.0.0' });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('resolveLockVersion', () => {
  it('handles aliases, git and file deps', () => {
    expect(resolveLockVersion('my-alias', 'npm:lodash@4.17.21', undefined)).toEqual({ name: 'lodash', version: '4.17.21' });
    expect(resolveLockVersion('x', 'file:../x', undefined)).toBeNull();
    const git = resolveLockVersion('g', 'git+https://github.com/o/g.git#abc123', undefined);
    expect(git).toEqual({ name: 'g', version: 'abc123', qualifiers: { vcs_url: 'git+https://github.com/o/g.git' } });
    expect(resolveLockVersion('../evil', '1.0.0', undefined)).toBeNull();
  });

  it('extracts names from nested install paths', () => {
    expect(nameFromInstallPath('node_modules/a/node_modules/@s/b')).toBe('@s/b');
    expect(nameFromInstallPath('packages/web')).toBeUndefined();
  });
});

describe('parsePackageLock v1', () => {
  const manifest = parsePackageJson(fx('lock-v1/package.json'));
  const res = parsePackageLock(fx('lock-v1/package-lock.json'), { assetIdFor: () => 'repo:legacy-app', rootManifest: manifest });
  const purls = res.components.map((c) => c.purl);

  it('reads every nested entry as a component', () => {
    expect(res.lockfileVersion).toBe(1);
    expect(purls).toContain(npmPurl('event-stream', '3.3.6'));
    expect(purls).toContain(npmPurl('flatmap-stream', '0.1.1'));
    expect(purls).toContain(npmPurl('lodash', '4.17.21')); // via alias
    expect(purls).toContain(npmPurl('debug', '3.1.0')); // nested under mocha
    expect(purls).toContain(npmPurl('debug', '4.1.1'));
    expect(purls.some((p) => p.startsWith('pkg:npm/git-dep@0123456789abcdef'))).toBe(true);
    const es = res.components.find((c) => c.name === 'event-stream')!;
    expect(es.integrity).toMatch(/^sha512-/);
    expect(es.resolved).toContain('registry.npmjs.org');
  });

  it('builds direct edges from package.json with scopes', () => {
    const direct = res.edges.filter((e) => e.direct);
    expect(direct).toContainEqual({ from: 'repo:legacy-app', to: npmPurl('event-stream', '3.3.6'), scope: 'runtime', direct: true });
    expect(direct).toContainEqual({ from: 'repo:legacy-app', to: npmPurl('lodash', '4.17.21'), scope: 'runtime', direct: true });
    expect(direct).toContainEqual({ from: 'repo:legacy-app', to: npmPurl('mocha', '5.2.0'), scope: 'dev', direct: true });
    expect(direct).toHaveLength(4);
  });

  it('resolves requires through the nested tree', () => {
    expect(res.edges).toContainEqual({ from: npmPurl('event-stream', '3.3.6'), to: npmPurl('flatmap-stream', '0.1.1'), scope: 'runtime', direct: false });
    // mocha → its own nested debug@3.1.0, not the hoisted 4.1.1
    expect(res.edges).toContainEqual({ from: npmPurl('mocha', '5.2.0'), to: npmPurl('debug', '3.1.0'), scope: 'dev', direct: false });
    expect(res.edges).toContainEqual({ from: npmPurl('debug', '3.1.0'), to: npmPurl('ms', '2.0.0'), scope: 'dev', direct: false });
  });

  it('infers direct deps when package.json is missing', () => {
    const r = parsePackageLock(fx('lock-v1/package-lock.json'), { assetIdFor: () => 'repo:x' });
    const direct = r.edges.filter((e) => e.direct).map((e) => e.to);
    expect(direct).toContain(npmPurl('event-stream', '3.3.6'));
    expect(direct).not.toContain(npmPurl('flatmap-stream', '0.1.1'));
    expect(r.warnings.join()).toMatch(/inferred/);
  });
});

describe('parsePackageLock v3', () => {
  const ids: Record<string, string> = { '': 'repo:acme-platform', 'packages/web': 'repo:@acme/web' };
  const res = parsePackageLock(fx('lock-v3/package-lock.json'), { assetIdFor: (d) => ids[d] });
  const comp = (name: string, v: string) => res.components.find((c) => c.purl === npmPurl(name, v));

  it('reads components with install-script flags and dedups duplicate versions', () => {
    expect(res.lockfileVersion).toBe(3);
    expect(comp('esbuild', '0.20.2')?.hasInstallScript).toBe(true);
    expect(comp('fsevents', '2.3.3')?.hasInstallScript).toBe(true);
    expect(comp('express', '4.19.2')?.hasInstallScript).toBeUndefined();
    // debug@2.6.9 is installed twice (express/ and packages/web/) → one component
    expect(res.components.filter((c) => c.purl === npmPurl('debug', '2.6.9'))).toHaveLength(1);
    // workspace link is not a component
    expect(res.components.some((c) => c.name === '@acme/web')).toBe(false);
    expect(res.importers.sort()).toEqual(['', 'packages/web']);
  });

  it('labels direct edges by manifest section and flags', () => {
    const d = res.edges.filter((e) => e.direct);
    expect(d).toContainEqual({ from: 'repo:acme-platform', to: npmPurl('express', '4.19.2'), scope: 'runtime', direct: true });
    expect(d).toContainEqual({ from: 'repo:acme-platform', to: npmPurl('@babel/runtime', '7.24.0'), scope: 'runtime', direct: true });
    expect(d).toContainEqual({ from: 'repo:acme-platform', to: npmPurl('esbuild', '0.20.2'), scope: 'dev', direct: true });
    expect(d).toContainEqual({ from: 'repo:acme-platform', to: npmPurl('fsevents', '2.3.3'), scope: 'optional', direct: true });
    // workspace resolves its own nested debug, and hoisted react
    expect(d).toContainEqual({ from: 'repo:@acme/web', to: npmPurl('debug', '2.6.9'), scope: 'runtime', direct: true });
    expect(d).toContainEqual({ from: 'repo:@acme/web', to: npmPurl('react', '18.2.0'), scope: 'runtime', direct: true });
  });

  it('resolves transitive edges with node_modules lookup', () => {
    const e = res.edges.filter((x) => !x.direct);
    expect(e).toContainEqual({ from: npmPurl('express', '4.19.2'), to: npmPurl('debug', '2.6.9'), scope: 'runtime', direct: false });
    expect(e).toContainEqual({ from: npmPurl('debug', '2.6.9'), to: npmPurl('ms', '2.0.0'), scope: 'runtime', direct: false });
    expect(e).toContainEqual({ from: npmPurl('esbuild', '0.20.2'), to: npmPurl('debug', '4.3.4'), scope: 'dev', direct: false });
    expect(e).toContainEqual({ from: npmPurl('react', '18.2.0'), to: npmPurl('loose-envify', '1.4.0'), scope: 'runtime', direct: false });
    expect(e).toContainEqual({ from: npmPurl('@babel/runtime', '7.24.0'), to: npmPurl('regenerator-runtime', '0.14.1'), scope: 'runtime', direct: false });
  });

  it('only creates direct edges for importers the caller maps', () => {
    const r = parsePackageLock(fx('lock-v3/package-lock.json'), { assetIdFor: (d) => (d === '' ? 'repo:root' : undefined) });
    expect(new Set(r.edges.filter((e) => e.direct).map((e) => e.from))).toEqual(new Set(['repo:root']));
  });

  it('rejects non-object JSON', () => {
    expect(() => parsePackageLock('[1]', { assetIdFor: () => 'x' })).toThrow();
  });
});

describe('componentsFromManifest', () => {
  it('keeps exact versions and aliases only', () => {
    const m = parsePackageJson(fx('no-lock/package.json'));
    const r = componentsFromManifest(m, 'repo:tiny');
    expect(r.components.map((c) => c.purl).sort()).toEqual([npmPurl('chalk', '5.3.0'), npmPurl('left-pad', '1.3.0')]);
    expect(r.unresolved.sort()).toEqual(['typescript', 'ua-parser-js']);
  });
});
