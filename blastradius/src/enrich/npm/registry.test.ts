/**
 * Regression for peak memory on large monorepo scans (microsoft/vscode: ~3000 components, 2+ GB
 * RSS): every full packument used to stay memoised for the whole scan. Packuments are now
 * slimmed to the fields the enrichers read, and only in-flight fetches are shared.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpClient, type Transport } from '../../core/http.js';
import { packumentFacts, summarizePackument } from './packument.js';
import { fetchPackument, slimPackument } from './registry.js';
import type { Packument } from './types.js';

const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/npm');

async function fixturePackuments(): Promise<[string, Record<string, unknown>][]> {
  const out: [string, Record<string, unknown>][] = [];
  for (const f of (await readdir(FIXTURES)).sort()) {
    if (!f.endsWith('.json')) continue;
    const env = JSON.parse(await readFile(join(FIXTURES, f), 'utf8')) as { response: Record<string, unknown> };
    out.push([f.replace(/\.json$/, ''), env.response]);
  }
  return out;
}

describe('slimPackument', () => {
  it('derives exactly the same facts and snapshot summary as the full packument', async () => {
    const all = await fixturePackuments();
    expect(all.length).toBeGreaterThan(5);
    let compared = 0;
    for (const [name, full] of all) {
      const slim = slimPackument(full);
      const versions = Object.keys((full.versions as Record<string, unknown>) ?? {});
      for (const version of [...versions, '0.0.0-not-published']) {
        for (const opts of [
          { now: new Date('2026-10-07T00:00:00Z') },
          { now: new Date('2018-11-27T00:00:00Z'), includeEmails: true, changeWindowDays: 3650 },
        ]) {
          expect(packumentFacts(slim, name, version, opts), `${name}@${version}`).toEqual(packumentFacts(full as Packument, name, version, opts));
          compared++;
        }
      }
      expect(summarizePackument(slim, name)).toEqual(summarizePackument(full as Packument, name));
    }
    expect(compared).toBeGreaterThan(50);
  });

  it('drops READMEs and per-version fields nothing reads', () => {
    const full = {
      name: 'x',
      readme: 'r'.repeat(10_000),
      description: 'd',
      users: { a: true },
      'dist-tags': { latest: '1.0.0' },
      time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
      versions: {
        '1.0.0': {
          name: 'x',
          version: '1.0.0',
          readme: 'r'.repeat(10_000),
          devDependencies: { big: '1' },
          files: ['a'],
          scripts: { postinstall: 'node x' },
          dist: { tarball: 'https://t', integrity: 'sha512-x', attestations: { url: 'https://a', provenance: { predicateType: 'p' } } },
        },
        'weird': 'not-an-object',
      },
    };
    const slim = slimPackument(full) as Record<string, unknown>;
    expect(Object.keys(slim).sort()).toEqual(['dist-tags', 'name', 'time', 'versions']);
    expect(slim.versions).toEqual({
      '1.0.0': {
        name: 'x',
        version: '1.0.0',
        scripts: { postinstall: 'node x' },
        dist: { attestations: { url: 'https://a', provenance: { predicateType: 'p' } } },
      },
      weird: 'not-an-object',
    });
  });
});

describe('fetchPackument', () => {
  it('shares a fetch in flight but does not keep settled packuments for the rest of the scan', async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { status: 200, body: JSON.stringify({ name: 'pkg', readme: 'big', versions: { '1.0.0': { version: '1.0.0', readme: 'big' } } }) };
    };
    const http = new HttpClient({ transport, cacheDir: false, minIntervalMs: 0, offline: false });
    const [a, b] = await Promise.all([fetchPackument(http, 'pkg'), fetchPackument(http, 'pkg')]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a).toEqual({ name: 'pkg', versions: { '1.0.0': { version: '1.0.0' } } });
    await fetchPackument(http, 'pkg');
    expect(calls).toBe(2);
  });

  it('does not keep failures either', async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls++;
      return calls === 1 ? { status: 500, body: '' } : { status: 200, body: '{"name":"pkg"}' };
    };
    const http = new HttpClient({ transport, cacheDir: false, minIntervalMs: 0, maxRetries: 0, offline: false });
    await expect(fetchPackument(http, 'pkg')).rejects.toThrow();
    expect(await fetchPackument(http, 'pkg')).toEqual({ name: 'pkg' });
  });
});
