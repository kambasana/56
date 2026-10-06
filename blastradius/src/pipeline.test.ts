import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFact, type Fact, type Incident } from './core/types.js';
import { DEFAULT_KB_DIR, factsKnownAt, incidentsKnownAt, scan, validateKb } from './pipeline.js';
import type { Enricher } from './core/plugin.js';
import { HttpClient } from './core/http.js';

const NOW = new Date('2020-01-01T00:00:00Z');
const meta = { source: 'osv', fetchedAt: NOW };

describe('time travel helpers', () => {
  it('drops advisories published after the reference time and keeps undated facts', () => {
    const facts: Fact[] = [
      makeFact('vuln', 'pkg:npm/a@1', { id: 'GHSA-old', aliases: [], severity: 'high', fixedVersions: [], published: '2019-06-01T00:00:00.000Z' }, meta),
      makeFact('malware', 'pkg:npm/a@1', { id: 'GHSA-new', origin: 'osv', published: '2021-06-01T00:00:00.000Z' }, meta),
      makeFact('vuln', 'pkg:npm/a@1', { id: 'GHSA-undated', aliases: [], severity: 'low', fixedVersions: [] }, meta),
      makeFact('maintainers', 'pkg:npm/a', { maintainers: [{ name: 'x' }], count: 1 }, { source: 'npm', fetchedAt: NOW }),
    ];
    const ids = factsKnownAt(facts, NOW).map((f) => (f.kind === 'vuln' || f.kind === 'malware' ? f.value.id : f.kind));
    expect(ids).toEqual(['GHSA-old', 'GHSA-undated', 'maintainers']);
  });

  it('drops incidents dated after the reference time', () => {
    const inc = (id: string, date: string): Incident => ({
      id, title: 't', type: 'malware_publish', status: 'confirmed', date, severity: 'high',
      affected: [], entities: [], evidence: ['https://example.org'],
    });
    expect(incidentsKnownAt([inc('INC-2019-0001', '2019-12-31'), inc('INC-2020-0002', '2020-01-02')], NOW).map((i) => i.id)).toEqual(['INC-2019-0001']);
  });

  // Regression: a date-only incident is not known during its own day (intraday replays).
  it('treats a date-only incident as known only after its day ends', () => {
    const inc: Incident = {
      id: 'INC-2021-0001', title: 't', type: 'account_takeover', status: 'confirmed', date: '2021-10-22', severity: 'high',
      affected: [], entities: [], evidence: ['https://example.org'],
    };
    expect(incidentsKnownAt([inc], new Date('2021-10-22T13:00:00Z'))).toEqual([]);
    expect(incidentsKnownAt([inc], new Date('2021-10-22T23:59:59Z'))).toEqual([]);
    expect(incidentsKnownAt([inc], new Date('2021-10-23T00:00:00Z'))).toEqual([inc]);
  });
});

describe('scan', () => {
  it('turns a throwing enricher into a warning and still scores', async () => {
    const boom: Enricher = { name: 'boom', enrich: async () => { throw new Error('kaput'); } };
    const http = new HttpClient({ offline: true, cacheDir: false, transport: async () => { throw new Error('no network'); } });
    const out = await scan({ target: 'test/fixtures/ingest/lock-v1', offline: true, now: NOW, http, enrichers: () => [boom] });
    expect(out.result.warnings).toContain('enricher boom failed: kaput');
    expect(out.result.inventory.components).toBeGreaterThan(0);
    expect(out.files).toEqual([]);
    expect(http.requestCount).toBe(0);
  });

  // Regression: --offline must not clone (git is live network access).
  it('refuses git URL targets in offline mode without invoking git', async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(
      scan({ target: 'https://github.com/example/repo', offline: true, now: NOW, enrichers: () => [], ingest: { git: { runner: runner as never } } }),
    ).rejects.toThrow(/offline mode cannot clone/);
    expect(calls).toBe(0);
  });

  // Regression: a cache directory inside the scanned checkout is untrusted and must not be used.
  it('disables a disk cache that lies inside the scan target', async () => {
    const target = path.resolve('test/fixtures/ingest/lock-v1');
    const out = await scan({ target, offline: true, now: NOW, enrichers: () => [], cacheDir: path.join(target, '.blastradius-cache') });
    expect(out.result.warnings?.some((w) => w.includes('is inside the scan target') && w.includes('disk cache disabled'))).toBe(true);
  });

  it('validates the bundled KB', async () => {
    const res = await validateKb(DEFAULT_KB_DIR);
    expect(res.ok).toBe(true);
    expect(res.files).toBeGreaterThan(0);
  });
});
