import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../core/http.js';
import type { TransportRequest } from '../../core/http.js';
import type { EnrichContext } from '../../core/plugin.js';
import { factsFor, isFactOf, npmPurl } from '../../core/types.js';
import type { Component, Inventory } from '../../core/types.js';
import { createDepsDevEnricher, dependentsOf, normalizeRepoUrl, provenanceOf, repoOf } from './index.js';

const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/depsdev/', import.meta.url));
const NOW = new Date('2026-01-01T00:00:00Z');

function comp(name: string, version: string): Component {
  return { purl: npmPurl(name, version), ecosystem: 'npm', name, version };
}
const inventory = (components: Component[]): Inventory => ({ assets: [], components, edges: [] });
const noNetwork = async (): Promise<never> => {
  throw new Error('network disabled in tests');
};
function ctxWith(http: HttpClient, warnings: string[] = []): EnrichContext {
  return { http, now: NOW, offline: http.offline, warn: (m) => warnings.push(m) };
}

describe('deps.dev enricher over recorded fixtures', () => {
  const inv = inventory([
    comp('ua-parser-js', '0.7.29'),
    comp('flatmap-stream', '0.1.1'),
    comp('event-stream', '3.3.6'),
    comp('@sigstore/core', '1.1.0'),
    { purl: 'pkg:docker/library/node@20', ecosystem: 'docker', name: 'library/node', version: '20' },
  ]);

  async function run() {
    const http = new HttpClient({ cacheDir: false, offline: true, fixturesDir: FIXTURES, transport: noNetwork });
    const warnings: string[] = [];
    const facts = await createDepsDevEnricher().enrich(inv, ctxWith(http, warnings));
    return { facts, warnings, http };
  }

  it('emits provenance, repo, scorecard and dependents facts', async () => {
    const { facts, warnings, http } = await run();
    expect(warnings).toEqual([]);
    expect(http.requestCount).toBe(0);

    const ua = npmPurl('ua-parser-js', '0.7.29');
    expect(factsFor(facts, ua, 'provenance').map((f) => f.value)).toEqual([{ hasProvenance: false }]);
    expect(factsFor(facts, ua, 'repo').map((f) => f.value)).toEqual([
      { url: 'https://github.com/faisalman/ua-parser-js', host: 'github', owner: 'faisalman', name: 'ua-parser-js', via: 'depsdev.links' },
    ]);
    const [uaScore] = factsFor(facts, ua, 'scorecard');
    expect(uaScore?.subject).toBe('pkg:npm/ua-parser-js');
    expect(uaScore?.source).toBe('depsdev');
    expect(uaScore?.value.score).toBe(4.6);
    expect(uaScore?.value.repo).toBe('github.com/faisalman/ua-parser-js');
    // -1 ("not applicable / error") checks are dropped.
    expect(uaScore?.value.checks.map((c) => c.name)).toEqual(['Maintained', 'Code-Review', 'Token-Permissions', 'Pinned-Dependencies']);
    expect(uaScore?.evidence).toEqual(['https://scorecard.dev/viewer/?uri=github.com/faisalman/ua-parser-js']);
    expect(factsFor(facts, ua, 'dependents').map((f) => f.value)).toEqual([{ count: 312, direct: 41, indirect: 271 }]);

    // event-stream: deps.dev project has no scorecard → Scorecard API fallback.
    const es = npmPurl('event-stream', '3.3.6');
    const [esScore] = factsFor(facts, es, 'scorecard');
    expect(esScore?.source).toBe('scorecard');
    expect(esScore?.value).toMatchObject({ score: 3.1, date: '2024-05-13T00:00:00Z', repo: 'github.com/dominictarr/event-stream' });
    expect(factsFor(facts, es, 'repo')[0]?.value.url).toBe('https://github.com/dominictarr/event-stream');
    expect(factsFor(facts, es, 'dependents')[0]?.value.count).toBe(1590);

    // flatmap-stream was removed from the registry: 404 → no facts, no warning.
    expect(factsFor(facts, npmPurl('flatmap-stream', '0.1.1'))).toEqual([]);

    // Scoped package: URL-encoded name, verified SLSA provenance, attested repo link preferred.
    const sg = npmPurl('@sigstore/core', '1.1.0');
    expect(factsFor(facts, sg, 'provenance')[0]?.value).toEqual({
      hasProvenance: true,
      type: 'slsa-v1',
      sourceRepo: 'https://github.com/sigstore/sigstore-js',
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/@sigstore%2fcore@1.1.0',
    });
    expect(factsFor(facts, sg, 'repo')[0]?.value.via).toBe('provenance');
    expect(factsFor(facts, sg, 'scorecard')[0]?.value.score).toBe(8.4);
    expect(factsFor(facts, sg, 'dependents')[0]?.subject).toBe('pkg:npm/%40sigstore/core');

    expect(facts.some((f) => f.subject.startsWith('pkg:docker'))).toBe(false);
    expect(facts.every((f) => f.fetchedAt === NOW.toISOString())).toBe(true);
  });

  it('is deterministic', async () => {
    expect((await run()).facts).toEqual((await run()).facts);
  });

  it('summarises offline misses in one warning', async () => {
    const http = new HttpClient({ cacheDir: false, offline: true, transport: noNetwork });
    const warnings: string[] = [];
    const facts = await createDepsDevEnricher().enrich(inventory([comp('left-pad', '1.3.0'), comp('ms', '2.1.3')]), ctxWith(http, warnings));
    expect(facts).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^depsdev: 2 request\(s\) had no fixture/);
  });
});

describe('deps.dev enricher request handling (fake transport)', () => {
  it('memoises projects, keeps one package-level fact per package and max dependents', async () => {
    const requests: TransportRequest[] = [];
    const http = new HttpClient({
      cacheDir: false,
      offline: false,
      minIntervalMs: 0,
      transport: async (req) => {
        requests.push(req);
        const u = req.url;
        let body: unknown;
        if (u.includes(':dependents')) body = { dependentCount: u.includes('1.0.0') ? '5' : '9' };
        else if (u.includes('/v3/projects/')) body = { projectKey: { id: 'github.com/o/r' }, scorecard: { overallScore: 7, checks: [] } };
        else body = { relatedProjects: [{ projectKey: { id: 'github.com/o/r' }, relationType: 'SOURCE_REPO' }] };
        return { status: 200, body: JSON.stringify(body) };
      },
    });
    const facts = await createDepsDevEnricher({ scorecardFallback: false }).enrich(
      inventory([comp('pkg', '1.0.0'), comp('pkg', '2.0.0')]),
      ctxWith(http),
    );
    expect(requests.filter((r) => r.url.includes('/v3/projects/'))).toHaveLength(1);
    expect(requests.find((r) => r.url.includes('/v3/projects/'))?.url).toBe('https://api.deps.dev/v3/projects/github.com%2Fo%2Fr');
    expect(facts.filter(isFactOf('provenance'))).toHaveLength(2);
    expect(facts.filter(isFactOf('repo'))).toHaveLength(1);
    expect(facts.filter(isFactOf('scorecard'))).toHaveLength(1);
    expect(facts.filter(isFactOf('dependents')).map((f) => f.value.count)).toEqual([9]);
  });

  it('warns on server errors without throwing', async () => {
    const http = new HttpClient({
      cacheDir: false,
      offline: false,
      minIntervalMs: 0,
      maxRetries: 0,
      transport: async () => ({ status: 500, body: 'oops' }),
    });
    const warnings: string[] = [];
    expect(await createDepsDevEnricher().enrich(inventory([comp('x', '1.0.0')]), ctxWith(http, warnings))).toEqual([]);
    expect(warnings[0]).toMatch(/depsdev: version x@1\.0\.0 failed: HTTP 500/);
  });
});

describe('deps.dev helpers', () => {
  it('normalises repository URLs', () => {
    expect(normalizeRepoUrl('git+https://github.com/Owner/Repo.git')).toEqual({
      url: 'https://github.com/Owner/Repo',
      host: 'github',
      owner: 'Owner',
      name: 'Repo',
      projectId: 'github.com/owner/repo',
    });
    expect(normalizeRepoUrl('git@gitlab.com:grp/proj.git')?.url).toBe('https://gitlab.com/grp/proj');
    expect(normalizeRepoUrl('git://github.com/dominictarr/event-stream.git')?.projectId).toBe('github.com/dominictarr/event-stream');
    expect(normalizeRepoUrl('https://github.com/o/r/tree/main/packages/x')?.url).toBe('https://github.com/o/r');
    expect(normalizeRepoUrl('https://example.org/code/thing.git')).toEqual({ url: 'https://example.org/code/thing', host: 'other' });
    expect(normalizeRepoUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeRepoUrl('https://github.com/only-owner')).toBeUndefined();
    expect(normalizeRepoUrl(42)).toBeUndefined();
  });

  it('reads provenance from attestations when no SLSA provenance is verified', () => {
    expect(provenanceOf({ slsaProvenances: [{ verified: false }], attestations: [{ verified: true, url: 'https://x.test/a' }] })).toEqual({
      hasProvenance: true,
      type: 'npm-attestation',
      url: 'https://x.test/a',
    });
    expect(provenanceOf({})).toEqual({ hasProvenance: false });
  });

  it('falls back to the SOURCE_REPO link when there is no related project', () => {
    expect(repoOf({ links: [{ label: 'HOMEPAGE', url: 'https://h.test' }, { label: 'SOURCE_REPO', url: 'https://github.com/a/b' }] })).toMatchObject({
      url: 'https://github.com/a/b',
      via: 'depsdev.links',
    });
    expect(repoOf({})).toBeUndefined();
  });

  it('parses int64-as-string dependent counts', () => {
    expect(dependentsOf({ dependentCount: '10', directDependentCount: 3 })).toEqual({ count: 10, direct: 3 });
    expect(dependentsOf({ dependentCount: '-1' })).toBeUndefined();
    expect(dependentsOf({})).toBeUndefined();
  });
});
