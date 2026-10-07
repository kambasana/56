import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_DIR } from '../../test/replay/server.js';
import { FEATURE_NAMES } from './asof.js';
import { main } from './cli.js';
import { mergeOverlay, openStore } from './store.js';

const OVERLAY = join(DATA_DIR, 'registry');

async function run(argv: string[]): Promise<{ code: number; out: any[]; err: string[] }> {
  const out: any[] = [];
  const err: string[] = [];
  const code = await main(argv, (l) => out.push(JSON.parse(l)), (l) => err.push(l));
  return { code, out, err };
}

describe('feature store', () => {
  it('puts back unpublished releases from the overlay, keeping live data first', () => {
    const live = { name: 'x', time: { '1.0.0': '2020-01-01T00:00:00Z', '1.0.1': '2020-02-01T00:00:00Z' }, versions: { '1.0.0': { version: '1.0.0', _npmUser: { name: 'a' } } } };
    const overlay = { name: 'x', time: { '1.0.0': '1999-01-01T00:00:00Z', '1.0.1': '2020-02-01T00:00:00Z' }, versions: { '1.0.0': { version: '1.0.0', _npmUser: { name: 'WRONG' } }, '1.0.1': { version: '1.0.1', _npmUser: { name: 'b' } } } };
    const m = mergeOverlay(live, overlay)!;
    expect(m.versions!['1.0.0']!._npmUser!.name).toBe('a');
    expect(m.versions!['1.0.1']!._npmUser!.name).toBe('b');
    expect(m.time!['1.0.0']).toBe('2020-01-01T00:00:00Z');
  });

  it('first release as of a date, null before it, undefined when unknown', () => {
    const s = openStore({ overlayDir: OVERLAY });
    const first = s.firstPublished('peacenotwar', Date.parse('2030-01-01'))!;
    expect(first).toBeGreaterThan(Date.parse('2022-01-01'));
    expect(s.firstPublished('peacenotwar', first - 1)).toBeNull();
    expect(s.firstPublished('no-such-package', Date.now())).toBeUndefined();
  });
});

describe('features CLI', () => {
  it('prints the schema', async () => {
    const r = await run(['schema']);
    expect(r.out[0].names).toEqual([...FEATURE_NAMES]);
    expect(r.out[0].manifestFeatures).toContain('install_hooks');
  });

  it('emits one row per release, as of release + offset, NaN as null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feat-'));
    writeFileSync(join(dir, 'names.txt'), 'rc\nnot-recorded\n');
    const r = await run(['releases', '--overlay', OVERLAY, '--names', join(dir, 'names.txt')]);
    expect(r.code).toBe(0);
    expect(r.out.map((x) => x.version).sort()).toEqual(['0.0.5', '1.2.6', '1.2.7', '1.2.8', '1.2.9']);
    for (const x of r.out) {
      expect(Date.parse(x.asOf) - Date.parse(x.releasedAt)).toBe(3_600_000);
      expect(x.features).toHaveLength(FEATURE_NAMES.length);
      expect(x.features[FEATURE_NAMES.indexOf('scorecard_score')]).toBeNull();
    }
    expect(r.err.join()).toMatch(/1 package/);
  });

  it('answers explicit requests and says why one was dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feat-'));
    const req = join(dir, 'req.jsonl');
    writeFileSync(req, ['{"name":"rc","version":"1.2.9","asOf":"2021-11-04T16:30:00Z","label":1}', '{"name":"rc","version":"1.2.9","asOf":"2015-01-01T00:00:00Z"}'].join('\n'));
    const r = await run(['rows', '--overlay', OVERLAY, '--requests', req]);
    expect(r.out[0]).toMatchObject({ name: 'rc', version: '1.2.9', label: 1, origin: 'overlay' });
    expect(r.out[1]).toMatchObject({ features: null, dropped: 'release not visible at asOf' });
  });

  it('describes an unpublished release from its time entry only when asked, with downloads from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feat-'));
    const cache = join(dir, 'cache');
    const dl = join(dir, 'dl');
    mkdirSync(cache);
    mkdirSync(dl);
    writeFileSync(
      join(cache, 'x.json'),
      JSON.stringify({ name: 'x', time: { '1.0.0': '2024-01-01T00:00:00Z', '1.0.1': '2024-03-01T00:00:00Z', '1.0.2': '2024-05-01T12:00:00Z' }, versions: { '1.0.0': { version: '1.0.0' }, '1.0.1': { version: '1.0.1' } } }),
    );
    writeFileSync(join(dl, 'x.json'), JSON.stringify({ from: '2024-01-01', counts: Array(200).fill(7) }));
    const req = join(dir, 'req.jsonl');
    writeFileSync(req, '{"name":"x","version":"1.0.2","asOf":"2024-05-01T13:00:00Z","label":1}\n');
    const without = await run(['rows', '--cache', cache, '--requests', req]);
    expect(without.out[0]).toMatchObject({ features: null });
    const r = await run(['rows', '--cache', cache, '--downloads', dl, '--allow-missing-manifest', '--requests', req]);
    expect(r.out[0]).toMatchObject({ name: 'x', version: '1.0.2', manifest: false, label: 1 });
    const f = r.out[0].features as (number | null)[];
    expect(f[FEATURE_NAMES.indexOf('prior_releases')]).toBe(2);
    expect(f[FEATURE_NAMES.indexOf('install_hooks')]).toBeNull();
    expect(f[FEATURE_NAMES.indexOf('downloads_weekly_log10')]).toBeCloseTo(Math.log10(50));
    expect(f[FEATURE_NAMES.indexOf('downloads_trend')]).toBeCloseTo(1);
  });
});
