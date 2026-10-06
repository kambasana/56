import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../core/http.js';
import type { TransportRequest } from '../../core/http.js';
import type { EnrichContext } from '../../core/plugin.js';
import { isFactOf, npmPurl } from '../../core/types.js';
import type { Component, Inventory } from '../../core/types.js';
import { createOsvEnricher, fixedVersions, isMalwareRecord, osvRecordsToFacts, severityOf } from './index.js';

const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/osv/', import.meta.url));
const NOW = new Date('2026-01-01T00:00:00Z');

function comp(name: string, version: string): Component {
  return { purl: npmPurl(name, version), ecosystem: 'npm', name, version };
}

function inventory(components: Component[]): Inventory {
  return { assets: [], components, edges: [] };
}

const FIXTURE_INV = inventory([
  comp('ua-parser-js', '0.7.29'),
  comp('flatmap-stream', '0.1.1'),
  comp('event-stream', '3.3.6'),
  comp('@sigstore/core', '1.1.0'),
  { purl: 'pkg:githubactions/actions/checkout@v4', ecosystem: 'githubactions', name: 'actions/checkout', version: 'v4' },
]);

function ctxWith(http: HttpClient, warnings: string[] = []): EnrichContext {
  return { http, now: NOW, offline: http.offline, warn: (m) => warnings.push(m) };
}

const noNetwork = async (): Promise<never> => {
  throw new Error('network disabled in tests');
};

describe('OSV enricher over recorded fixtures', () => {
  it('emits malware + vuln facts for the known incidents and nothing for a clean package', async () => {
    const http = new HttpClient({ cacheDir: false, offline: true, fixturesDir: FIXTURES, transport: noNetwork });
    const warnings: string[] = [];
    const facts = await createOsvEnricher().enrich(FIXTURE_INV, ctxWith(http, warnings));

    expect(warnings).toEqual([]);
    expect(http.requestCount).toBe(0);

    const ua = npmPurl('ua-parser-js', '0.7.29');
    // GHSA-pjwm carries CWE-829/CWE-912 (not CWE-506) and no MAL- alias, so OSV alone reports it
    // as a critical vulnerability; the malware override comes from the curated KB (INC-2021-0001).
    const uaMal = facts.filter(isFactOf('malware')).filter((f) => f.subject === ua);
    expect(uaMal).toHaveLength(0);

    const uaVuln = facts.filter(isFactOf('vuln')).find((f) => f.subject === ua);
    expect(uaVuln?.source).toBe('osv');
    expect(uaVuln?.fetchedAt).toBe(NOW.toISOString());
    expect(uaVuln?.evidence).toContain('https://github.com/advisories/GHSA-pjwm-rvh2-c87w');
    expect(uaVuln?.value).toMatchObject({
      id: 'GHSA-pjwm-rvh2-c87w',
      severity: 'critical',
      cvss: 9.8,
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      fixedVersions: ['0.7.30', '0.8.1', '1.0.1'],
      url: 'https://osv.dev/vulnerability/GHSA-pjwm-rvh2-c87w',
    });
    expect(uaVuln?.value.epss).toBeUndefined();
    expect(uaVuln?.value.kev).toBeUndefined();

    const fm = npmPurl('flatmap-stream', '0.1.1');
    const fmMal = facts.filter(isFactOf('malware')).filter((f) => f.subject === fm).map((f) => f.value.id);
    expect(fmMal.sort()).toEqual(['GHSA-9x64-5r7x-2q53', 'GHSA-mh6f-8j2x-4483']);
    const fmVuln = facts.filter(isFactOf('vuln')).find((f) => f.subject === fm && f.value.id === 'GHSA-9x64-5r7x-2q53');
    expect(fmVuln?.value.fixedVersions).toEqual([]); // no fix: package was removed

    const es = npmPurl('event-stream', '3.3.6');
    const esVuln = facts.filter(isFactOf('vuln')).find((f) => f.subject === es);
    // No CVSS vector in the record → falls back to database_specific.severity.
    expect(esVuln?.value).toMatchObject({ id: 'GHSA-mh6f-8j2x-4483', severity: 'critical', fixedVersions: ['4.0.0'] });
    expect(esVuln?.value.cvss).toBeUndefined();
    expect(facts.filter(isFactOf('malware')).some((f) => f.subject === es)).toBe(true);

    expect(facts.filter((f) => f.subject.includes('sigstore'))).toEqual([]);
    expect(facts.filter((f) => f.subject.startsWith('pkg:githubactions'))).toEqual([]);
  });

  it('turns offline misses into a single warning instead of throwing', async () => {
    const http = new HttpClient({ cacheDir: false, offline: true, transport: noNetwork });
    const warnings: string[] = [];
    const facts = await createOsvEnricher().enrich(inventory([comp('left-pad', '1.3.0')]), ctxWith(http, warnings));
    expect(facts).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no fixture or cached response offline/);
  });

  it('returns nothing (and makes no request) when there are no npm components', async () => {
    const http = new HttpClient({ cacheDir: false, offline: true, transport: noNetwork });
    expect(await createOsvEnricher().enrich(inventory([]), ctxWith(http))).toEqual([]);
  });
});

describe('OSV enricher request handling (fake transport)', () => {
  function fakeOsv(handler: (req: TransportRequest) => unknown) {
    const requests: TransportRequest[] = [];
    const http = new HttpClient({
      cacheDir: false,
      offline: false,
      minIntervalMs: 0,
      transport: async (req) => {
        requests.push(req);
        const res = handler(req);
        return res === null ? { status: 404, body: '{}' } : { status: 200, body: JSON.stringify(res) };
      },
    });
    return { http, requests };
  }

  it('chunks querybatch, follows next_page_token and URL-encodes ids', async () => {
    const { http, requests } = fakeOsv((req) => {
      if (req.url.endsWith('/querybatch')) {
        const body = JSON.parse(req.body!) as { queries: { package: { name: string }; version: string; page_token?: string }[] };
        return {
          results: body.queries.map((q) => {
            if (q.package.name === 'a' && !q.page_token) return { vulns: [{ id: 'GHSA-aaaa-aaaa-aaaa' }], next_page_token: 'tok' };
            if (q.package.name === 'a' && q.page_token === 'tok') return { vulns: [{ id: 'MAL-0000-0001' }] };
            if (q.package.name === '@scope/c') return { vulns: [{ id: 'GHSA-cccc-cccc-cccc' }, { id: '../etc/passwd' }] };
            return {};
          }),
        };
      }
      const id = decodeURIComponent(req.url.split('/').pop()!);
      if (id === 'MAL-0000-0001') {
        return {
          id,
          summary: 'Malicious code in a (npm)',
          database_specific: { 'malicious-packages-origins': [{ source: 'test' }] },
          affected: [{ package: { ecosystem: 'npm', name: 'a' }, versions: ['1.0.0'] }],
        };
      }
      if (id === 'GHSA-cccc-cccc-cccc') return null; // detail missing → minimal fact
      return {
        id,
        summary: 'Prototype pollution',
        aliases: ['CVE-2099-0001'],
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }],
        affected: [{ package: { ecosystem: 'npm', name: 'a' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }] }],
      };
    });

    const inv = inventory([comp('a', '1.0.0'), comp('b', '2.0.0'), comp('@scope/c', '3.0.0')]);
    const warnings: string[] = [];
    const facts = await createOsvEnricher({ batchSize: 2 }).enrich(inv, ctxWith(http, warnings));

    const batches = requests.filter((r) => r.url.endsWith('/querybatch'));
    // 3 components / batchSize 2 → 2 chunks, + 1 page-token follow-up for "a".
    expect(batches).toHaveLength(3);
    expect(batches.every((r) => r.method === 'POST')).toBe(true);
    expect(JSON.parse(batches[0]!.body!).queries[0]).toEqual({ package: { name: '@scope/c', ecosystem: 'npm' }, version: '3.0.0' });
    expect(requests.some((r) => r.url.includes('passwd'))).toBe(false);

    const a = npmPurl('a', '1.0.0');
    expect(facts.filter(isFactOf('malware')).map((f) => [f.subject, f.value.id])).toEqual([[a, 'MAL-0000-0001']]);
    // MAL-* records do not also become vuln facts.
    expect(facts.filter(isFactOf('vuln')).filter((f) => f.subject === a).map((f) => f.value)).toEqual([
      expect.objectContaining({ id: 'GHSA-aaaa-aaaa-aaaa', aliases: ['CVE-2099-0001'], cvss: 7.5, severity: 'high', fixedVersions: ['1.0.1'] }),
    ]);
    const c = facts.filter(isFactOf('vuln')).find((f) => f.subject === npmPurl('@scope/c', '3.0.0'));
    expect(c?.value).toMatchObject({ id: 'GHSA-cccc-cccc-cccc', severity: 'unknown', fixedVersions: [] });
    expect(warnings).toEqual([]);
  });

  it('warns and skips when querybatch result count does not match', async () => {
    const { http } = fakeOsv(() => ({ results: [] }));
    const warnings: string[] = [];
    const facts = await createOsvEnricher().enrich(inventory([comp('a', '1.0.0')]), ctxWith(http, warnings));
    expect(facts).toEqual([]);
    expect(warnings[0]).toMatch(/returned 0 result/);
  });

  it('skips non-exact versions (git/file specs)', async () => {
    const { http, requests } = fakeOsv(() => ({ results: [] }));
    const inv = inventory([{ purl: 'pkg:npm/x@file:..', ecosystem: 'npm', name: 'x', version: 'file:..' }]);
    expect(await createOsvEnricher().enrich(inv, ctxWith(http))).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe('OSV record helpers', () => {
  const c = { purl: npmPurl('x', '1.0.0'), name: 'x' };

  it('skips withdrawn records and dedupes aliases', () => {
    const facts = osvRecordsToFacts(
      c,
      [
        { id: 'GHSA-1111-1111-1111', withdrawn: '2024-01-01T00:00:00Z' },
        { id: 'GHSA-2222-2222-2222', aliases: ['CVE-2020-1'] },
        { id: 'CVE-2020-1', aliases: ['GHSA-2222-2222-2222'] },
      ],
      NOW,
    );
    expect(facts.map((f) => f.kind === 'vuln' && f.value.id)).toEqual(['GHSA-2222-2222-2222']);
  });

  it('detects malware by id, alias, origins and CWE-506 only', () => {
    expect(isMalwareRecord({ id: 'MAL-2024-1' })).toBe(true);
    expect(isMalwareRecord({ id: 'GHSA-x', aliases: ['MAL-2024-1'] })).toBe(true);
    expect(isMalwareRecord({ id: 'GHSA-x', database_specific: { cwe_ids: ['CWE-506'] } })).toBe(true);
    expect(isMalwareRecord({ id: 'GHSA-x', database_specific: { 'malicious-packages-origins': [] } })).toBe(true);
    expect(isMalwareRecord({ id: 'GHSA-x', summary: 'ReDoS in foo', database_specific: { cwe_ids: ['CWE-1333'] } })).toBe(false);
  });

  // Regression: free-text summaries must never make an ordinary vulnerability "malware".
  it('does not infer malware from advisory summary text', () => {
    const rec = {
      id: 'GHSA-xxxx-yyyy-zzzz',
      summary: 'Template injection allows attackers to run malicious code',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N' }],
    };
    expect(isMalwareRecord(rec)).toBe(false);
    expect(isMalwareRecord({ id: 'GHSA-x', summary: 'Embedded malware in foo' })).toBe(false);
    const facts = osvRecordsToFacts({ purl: 'pkg:npm/foo@1.0.0', name: 'foo' }, [rec], NOW);
    expect(facts.map((f) => f.kind)).toEqual(['vuln']);
  });

  it('derives severity from CVSS v3, else label, keeping v4 vectors unscored', () => {
    expect(severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H' }] })).toEqual({
      severity: 'critical',
      cvss: 10,
      vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H',
    });
    expect(
      severityOf({
        severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }],
        database_specific: { severity: 'MODERATE' },
      }),
    ).toEqual({ severity: 'medium', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' });
    expect(severityOf({})).toEqual({ severity: 'unknown' });
  });

  it('collects fixed versions only for the matching npm package', () => {
    expect(
      fixedVersions(
        {
          affected: [
            { package: { ecosystem: 'npm', name: 'X' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.3' }] }] },
            { package: { ecosystem: 'PyPI', name: 'x' }, ranges: [{ type: 'ECOSYSTEM', events: [{ fixed: '9.9.9' }] }] },
            { package: { ecosystem: 'npm', name: 'x' }, ranges: [{ type: 'GIT', events: [{ fixed: 'abcdef' }] }] },
          ],
        },
        'x',
      ),
    ).toEqual(['1.2.3']);
  });
});
