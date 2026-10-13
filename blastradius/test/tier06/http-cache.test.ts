/**
 * Tier 0.6 (2): the HTTP response cache has a disk budget (--cache-max-mb), like the clone cache.
 * The re-check measured superset's HTTP cache at 1,145 MB (npm packuments), outside any budget.
 */
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HTTP_CACHE_MAX_MB, HttpClient, type Transport } from '../../src/core/http.js';
import { stabilityCoverage } from '../../src/stability/report.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'br-http-budget-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A packument-sized body (~300 kB) per URL. */
const transport = vi.fn<Transport>(async (req) => ({ status: 200, body: JSON.stringify({ url: req.url, pad: 'x'.repeat(300_000) }) }));
const client = (maxMb: number) => new HttpClient({ transport, cacheDir: dir, cacheMaxMb: maxMb, offline: false, minIntervalMs: 0 });
const sizeOf = async () => {
  let n = 0;
  for (const f of await readdir(dir)) n += (await stat(join(dir, f))).size;
  return n;
};

describe('Tier 0.6 (2): HTTP cache budget with least-recently-used eviction', () => {
  it('stays under its budget and reports peak and evictions', async () => {
    const c = client(1);
    for (let i = 0; i < 8; i++) await c.fetchJson(`https://registry.test/p${i}`);
    expect(await sizeOf()).toBeLessThanOrEqual(1e6);
    const u = (await c.cacheUsage())!;
    expect(u.maxMb).toBe(1);
    expect(u.peakMb).toBeLessThanOrEqual(1);
    expect(u.evicted).toBeGreaterThanOrEqual(5);
  });

  it('evicts the least recently used entry first: a cache hit keeps an entry', async () => {
    const c = client(1);
    await c.fetchJson('https://registry.test/a');
    await c.fetchJson('https://registry.test/b');
    await c.fetchJson('https://registry.test/c');
    // Make a and b old on disk, then use a again (a hit refreshes its time).
    const old = Date.now() / 1000 - 3600;
    for (const f of await readdir(dir)) await utimes(join(dir, f), old, old);
    const c2 = client(1);
    const calls = transport.mock.calls.length;
    await c2.fetchJson('https://registry.test/a');
    expect(transport.mock.calls.length).toBe(calls);
    await c2.fetchJson('https://registry.test/d');
    await c2.fetchJson('https://registry.test/e');
    // a was used last among the old entries: still cached.
    await c2.fetchJson('https://registry.test/a');
    expect(transport.mock.calls.length).toBe(calls + 2);
  });

  it('an existing cache over the budget is trimmed at once (the 1,145 MB case, scaled down)', async () => {
    for (let i = 0; i < 10; i++) await writeFile(join(dir, `${i}.json`), 'x'.repeat(250_000));
    const u = (await client(1).cacheUsage())!;
    expect(u.sizeMb).toBeLessThanOrEqual(1);
    expect(u.evicted).toBe(7);
    expect(await sizeOf()).toBeLessThanOrEqual(0.9e6);
  });

  it('default budget, and the coverage line names it', () => {
    expect(DEFAULT_HTTP_CACHE_MAX_MB).toBe(500);
    const cov = stabilityCoverage({ assets: [], components: [], edges: [] }, [], undefined, { maxMb: 500, peakMb: 498, sizeMb: 450, evicted: 1234 });
    expect(cov.line).toMatch(/HTTP cache: peak 498 MB of the 500 MB budget \(--cache-max-mb\), 1,234 least recently used entries deleted to stay under it\./);
    expect(cov.httpCache).toEqual({ maxMb: 500, peakMb: 498, sizeMb: 450, evicted: 1234 });
  });

  it('no disk cache, no usage', async () => {
    expect(await new HttpClient({ transport, cacheDir: false }).cacheUsage()).toBeUndefined();
  });
});
