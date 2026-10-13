/**
 * Tier 0.6 (4)–(7) on recorded real data (record-tier06.ts):
 *   4. @great-expectations/jsonforms-antd-renderers 2.2.8: a publisher at the owner's verified domain
 *      is an organisation member; a release built by the repository's CI (npm provenance) is context.
 *   5. README rule: misses caught, version-scoped notes and feature badges no longer match.
 *   6. PyPI: Inactive classifier + unmaintained description (click-plugins); the latest release's
 *      source repository when the version in use has none (geographiclib).
 *   7. Deprecated @types stubs: Watch "Remove: stub types", never Fragile "Ended in production".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import { makeFact, npmPurl, type Fact, type StabilityEntry } from '../../src/core/types.js';
import { createDepsDevEnricher } from '../../src/enrich/depsdev/index.js';
import { parseOrgDomain } from '../../src/enrich/github/index.js';
import { parseProvenanceAttestations } from '../../src/enrich/npm/attestation.js';
import { createPypiEnricher } from '../../src/enrich/pypi/index.js';
import { decodeFixture } from '../../src/history/fixture.js';
import { declaredStatusOf } from '../../src/stability/declared.js';
import { buildStabilityReport } from '../../src/stability/report.js';
import { productionInventory, registryFacts, stabilityOf } from '../stability/build.js';
import { STABILITY_DIR } from '../stability/fixture.js';
import { JSONFORMS, STUBS, TIER06_DIR } from './record-tier06.js';

const fx = JSON.parse(gunzipSync(readFileSync(join(TIER06_DIR, 'tier06.json.gz'))).toString('utf8'));
const rules = (e: StabilityEntry) => e.rules.map((r) => r.rule);

describe('Tier 0.6 (4): jsonforms-antd-renderers 2.2.8 (superset): organisation domain and CI provenance', () => {
  const pkg = fx.jsonforms;
  const hist = decodeFixture(JSON.parse(readFileSync(join(STABILITY_DIR, 'history', `tier06-${JSONFORMS.slug}.json`), 'utf8')));
  const asOf = new Date(JSONFORMS.asOf);
  const siblingLookup = async (account: string, owner: string) => (owner === pkg.siblings.owner ? (pkg.siblings.byAccount[account] ?? undefined) : undefined);
  const recordedProvenance = async (_n: string, v: string) => parseProvenanceAttestations(pkg.provenance[v]);
  async function label(opts: { org?: unknown; provenance?: boolean }) {
    const facts: Fact[] = registryFacts({ ...pkg, versions: [JSONFORMS.version] }, asOf, pkg.project, fx.recordedAt);
    if (opts.org !== undefined) {
      const domain = parseOrgDomain(opts.org);
      facts.push(makeFact('repo_owner', npmPurl(JSONFORMS.name), { repo: 'github.com/great-expectations/jsonforms-antd-renderers', owner: 'great-expectations', ownerType: 'Organization', url: JSONFORMS.repo, ...(domain ? { verifiedDomain: domain } : {}) }, { source: 'github', fetchedAt: asOf }));
    }
    const { report, facts: all } = await stabilityOf(productionInventory([{ name: JSONFORMS.name, version: JSONFORMS.version }]), facts, () => hist, asOf, false, {
      siblingLookup,
      provenanceLookup: opts.provenance ? recordedProvenance : async () => undefined,
    });
    return { entry: report.packages[0]!, history: (all.find((f) => f.kind === 'commit_history') as any)?.value };
  }

  it('the recorded data: 2.2.8 is the only release published from an address at greatexpectations.io, and it has SLSA provenance from the repository\'s release workflow', () => {
    expect(hist.npmOrgDomain).toBe('greatexpectations.io');
    expect(hist.npmOrgDomainVersions).toEqual(['2.2.8']);
    expect(pkg.packument.versions['2.2.8']._npmUser.name).toBe('tyler-hoffman-gx');
    expect(parseProvenanceAttestations(pkg.provenance['2.2.8'])).toEqual({ repository: 'https://github.com/great-expectations/jsonforms-antd-renderers', workflow: '.github/workflows/release.yml', ref: 'refs/heads/main' });
  });

  it('without either piece of evidence the S5a item stays (the re-check\'s observation, reproduced)', async () => {
    const { entry } = await label({});
    expect(rules(entry)).toContain('watch_release_continuity');
    expect(entry.s5a.map((e) => `${e.kind}:${e.release}`)).toContain('npm_release_by_new_account:2.2.8');
  });

  it('a provenance-attested release built by the repository\'s own CI is lower-risk context, not a Watch rule', async () => {
    const { entry, history } = await label({ provenance: true });
    expect(rules(entry)).not.toContain('watch_release_continuity');
    expect(entry.s5a.filter((e) => e.release === '2.2.8')).toEqual([]);
    const c = history.changes.find((x: any) => x.release === '2.2.8');
    expect(c.ciProvenance).toBe('github.com/great-expectations/jsonforms-antd-renderers/.github/workflows/release.yml');
    expect(entry.context.some((x) => x.signal === 'S5a' && /built and published by this repository's CI/.test(x.text))).toBe(true);
  });

  it('a publisher at the owner\'s verified organisation domain is an organisation member: no observation', async () => {
    // GitHub's /orgs/great-expectations answered 403 from the recording session; the answer's shape
    // (https://docs.github.com/en/rest/orgs/orgs#get-an-organization) is stated here.
    const org = { login: 'great-expectations', type: 'Organization', blog: 'https://greatexpectations.io', is_verified: true };
    const { entry, history } = await label({ org });
    expect(rules(entry)).not.toContain('watch_release_continuity');
    expect(history.changes.filter((x: any) => x.release === '2.2.8')).toEqual([]);
    // No deterministic domain evidence (unverified organisation, or no website): the signal stays.
    for (const o of [{ ...org, is_verified: false }, { ...org, blog: '' }]) expect(rules((await label({ org: o })).entry)).toContain('watch_release_continuity');
    expect(parseOrgDomain({ is_verified: true, blog: 'www.Example.org/about' })).toBe('example.org');
  });
});

describe('Tier 0.6 (5): README declarations (the re-check\'s rx.mts cases and real READMEs)', () => {
  const rx: [string, string | null][] = [
    ['# x\n\nThis PyPI package is no longer actively maintained, but the library can be vendored.', 'unmaintained'],
    ['# x\n\nThis package is no longer actively maintained.', 'unmaintained'],
    ['# tslint\n\n:warning: __TSLint is deprecated.__', 'deprecated'],
    ['# aws-sdk\n\n## 🚫 End-of-support as of September 8, 2025\n\nThe AWS SDK for JavaScript v2 has reached end-of-support.', 'deprecated'],
    ['# foo\n\n## ⚠️ Deprecated\n\nUse bar.', 'deprecated'],
    ['# lib\n\nVersion 1.x is now in maintenance mode; please upgrade to 2.x.', null],
    ['# lib\n\nThe v3 branch is in maintenance mode.', null],
    ['# lib\n\n[![status](https://img.shields.io/badge/IE11-deprecated-red)](x)\n\nA library.', null],
  ];
  it.each(rx)('%j → %s', (readme, status) => {
    expect(declaredStatusOf(readme)?.status ?? null).toBe(status);
  });

  it('real READMEs: aws-sdk v2 ("End-of-support" heading) and tslint ("TSLint is deprecated")', () => {
    expect(declaredStatusOf(fx.readmes['aws-sdk'], 'aws-sdk')).toMatchObject({ status: 'deprecated', phrase: expect.stringMatching(/^End of support/) });
    expect(declaredStatusOf(fx.readmes.tslint, 'tslint')).toMatchObject({ status: 'deprecated', phrase: expect.stringMatching(/TSLint is deprecated/) });
  });

  it('a status badge still counts; the same words under a feature label do not', () => {
    expect(declaredStatusOf('# lib\n\n![status](https://img.shields.io/badge/status-unmaintained-red)\n\nA library.')?.status).toBe('unmaintained');
    expect(declaredStatusOf('# lib\n\n![x](https://img.shields.io/badge/project-deprecated-red)\n\nA library.')?.status).toBe('deprecated');
    expect(declaredStatusOf('# lib\n\n![x](https://img.shields.io/badge/Node%208-deprecated-orange)\n\nA library.')).toBeUndefined();
    // "<Name> is deprecated" needs the package's own name or the README title.
    expect(declaredStatusOf('# lib\n\nThe foo option is deprecated.')).toBeUndefined();
  });
});

describe('Tier 0.6 (6): PyPI labels (click-plugins, geographiclib; superset)', async () => {
  const fixtures: Record<string, unknown> = {};
  for (const [url, body] of Object.entries(fx.pypi.responses)) fixtures[url] = body === null ? { status: 404, response: null } : { status: 200, response: body };
  const http = new HttpClient({ offline: true, cacheDir: false, fixtures });
  const asOf = new Date(JSONFORMS.asOf);
  const ctx = { http, now: asOf, offline: true, warn: () => {} };
  const facts = [...(await createDepsDevEnricher({ dependents: false }).enrich(fx.pypi.inventory, ctx)), ...(await createPypiEnricher().enrich(fx.pypi.inventory, ctx))];
  const report = buildStabilityReport(fx.pypi.inventory, facts, asOf, {});
  const of = (n: string) => report.packages.find((p) => p.name === n)!;

  it('click-plugins: "Development Status :: 7 - Inactive" and "This PyPI package is no longer actively maintained" together are ended evidence (Watch, low confidence)', () => {
    const e = of('click-plugins');
    expect(e.label).toBe('watch');
    expect(rules(e)).toContain('watch_ended');
    expect(e.s3).toMatchObject({ state: 'ended', confidence: 'low', declared: 'unmaintained' });
    const f = e.rules.find((r) => r.rule === 'watch_ended')!.facts[0]!;
    expect(f.text).toMatch(/^The PyPI project description declares that it is no longer maintained: "This PyPI package is no longer actively maintained/);
    expect(f.text).toContain('the PyPI classifier "Development Status :: 7 - Inactive"');
  });

  it('geographiclib 2.0 declares no repository; the latest release (2.1) does: the repository is resolved and read by --history', async () => {
    const e = of('geographiclib');
    // Before: "No source repository is declared on PyPI (deps.dev found none)."
    expect(e.missing.join(' ')).not.toMatch(/No source repository is declared/);
    const age = facts.find((f) => f.kind === 'release_age' && f.subject.startsWith('pkg:pypi/geographiclib@')) as any;
    expect(age.value.latestRepository).toEqual({ url: 'https://github.com/geographiclib/geographiclib-python' });
    expect(e.missing.join(' ')).toMatch(/git history of https:\/\/github\.com\/geographiclib\/geographiclib-python was not read/);
    // The history enricher picks that repository (offline here: listed as not read).
    const { createHistoryEnricher } = await import('../../src/enrich/history/index.js');
    let sel: any;
    await createHistoryEnricher({ repoFacts: () => facts, recorded: () => undefined, onSelection: (x) => (sel = x) }).enrich(fx.pypi.inventory, { http, now: asOf, offline: true, warn: () => {} });
    expect(sel.declared).toBe(2);
    expect(sel.failed).toContain('https://github.com/geographiclib/geographiclib-python');
    // deps.dev's repository stays first where it has one (click-plugins).
    expect(sel.failed).toContain('https://github.com/click-contrib/click-plugins');
  });
});

describe('Tier 0.6 (7): deprecated @types stubs are "Remove: stub types" at Watch', () => {
  it('every stub of the four re-scans: Watch watch_stub_types with the action, never fragile_ended_production', async () => {
    const asOf = new Date(JSONFORMS.asOf);
    for (const [name, versions] of Object.entries(STUBS)) {
      const pkg = fx.stubs[name];
      const { report } = await stabilityOf(productionInventory(versions.map((version) => ({ name, version }))), registryFacts({ ...pkg, versions }, asOf, undefined, fx.recordedAt), () => undefined, asOf);
      const e = report.packages[0]!;
      expect(e.label, name).toBe('watch');
      expect(rules(e), name).toContain('watch_stub_types');
      expect(rules(e), name).not.toContain('fragile_ended_production');
      expect(e.action, name).toMatch(new RegExp(`^Remove: stub types \\(${name.slice(7).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ships its own types`));
      expect(e.s3.state, name).not.toBe('ended');
    }
  });

  it('a real deprecation of an @types package still ends it', async () => {
    const asOf = new Date(JSONFORMS.asOf);
    const pkg = structuredClone(fx.stubs['@types/long']);
    const latest = pkg.packument['dist-tags'].latest;
    pkg.packument.versions[latest].deprecated = 'No longer maintained.';
    const { report } = await stabilityOf(productionInventory([{ name: '@types/long', version: '4.0.2' }]), registryFacts({ ...pkg, versions: ['4.0.2'] }, asOf, undefined, fx.recordedAt), () => undefined, asOf);
    expect(rules(report.packages[0]!)).toContain('fragile_ended_production');
  });
});
