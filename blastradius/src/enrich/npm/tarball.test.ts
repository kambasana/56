/**
 * Package size for the finished / low-surface test (P3): the tar reader, the registry's dist
 * numbers, and the npm enricher's tarball fallback for old versions (fixtures, no network).
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../core/http.js';
import { createNpmEnricher } from './index.js';
import { packageSize } from './packument.js';
import { tarballFootprint } from './tarball.js';
import type { Packument } from './types.js';

/** A ustar archive: one 512-byte header per entry, contents padded to 512, two zero blocks. */
function tar(entries: { name: string; size: number; type?: string; pax?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write(size.toString(8).padStart(11, '0'), 124, 'latin1');
    h.write(type, 156, 'latin1');
    h.write('ustar\u000000', 257, 'latin1');
    return h;
  };
  const pad = (n: number) => Buffer.alloc(Math.ceil(n / 512) * 512);
  for (const e of entries) {
    if (e.pax) {
      const body = Buffer.from(e.pax);
      blocks.push(header('PaxHeader', body.length, 'x'), Buffer.concat([body, pad(body.length).subarray(body.length)]));
    }
    blocks.push(header(e.name, e.pax ? 0 : e.size, e.type ?? '0'), pad(e.size));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('tarball footprint (as npm publish computes dist.unpackedSize / fileCount)', () => {
  it('sums entry sizes and counts files; directories and pax headers are not files', () => {
    const gz = tar([
      { name: 'package/', size: 0, type: '5' },
      { name: 'package/package.json', size: 300 },
      { name: 'package/index.js', size: 1200 },
      { name: 'package/README.md', size: 2546 },
      { name: 'package/big.bin', size: 600, pax: '15 size=600\n' },
    ]);
    expect(tarballFootprint(gz)).toEqual({ unpackedSize: 4646, fileCount: 4 });
  });
  it('rejects malformed archives and oversized ones', () => {
    const bad = Buffer.alloc(1536);
    bad.write('package/a', 0);
    bad.write('99zz', 124, 'latin1');
    expect(() => tarballFootprint(gzipSync(bad))).toThrow(/tar: malformed size/);
    const short = Buffer.alloc(512);
    short.write('package/a', 0);
    short.write('77777', 124, 'latin1');
    expect(() => tarballFootprint(gzipSync(short))).toThrow(/runs past the end/);
    expect(() => tarballFootprint(tar([{ name: 'package/a', size: 4096 }]), 1024)).toThrow();
  });
});

const packument = (dist: Record<string, unknown>, time = '2014-01-02T00:00:00.000Z'): Packument => ({
  name: 'tiny',
  'dist-tags': { latest: '1.0.0' },
  time: { created: time, '1.0.0': time },
  versions: { '1.0.0': { name: 'tiny', version: '1.0.0', dependencies: { a: '1', b: '2' }, dist: { tarball: 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz', ...dist } } },
});

describe('package_size', () => {
  it("from the registry's dist numbers, with the declared dependencies", () => {
    expect(packageSize(packument({ unpackedSize: 3958, fileCount: 5 }), '1.0.0')).toEqual({ version: '1.0.0', unpackedSize: 3958, fileCount: 5, dependencies: 2, via: 'npm.dist' });
    expect(packageSize(packument({}), '1.0.0')).toBeUndefined();
  });

  const NOW = new Date('2026-10-11T00:00:00Z');
  const inv = { assets: [], edges: [], components: [{ purl: 'pkg:npm/tiny@1.0.0' as const, ecosystem: 'npm' as const, name: 'tiny', version: '1.0.0' }] };
  const run = async (p: Packument, withTarball: boolean) => {
    const fixtures: Record<string, unknown> = { 'https://registry.npmjs.org/tiny': p };
    if (withTarball) fixtures['https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz'] = tar([{ name: 'package/index.js', size: 1000 }, { name: 'package/package.json', size: 200 }]).toString('base64');
    const warnings: string[] = [];
    const facts = await createNpmEnricher({ snapshots: false, downloadsApi: false }).enrich(inv, { http: new HttpClient({ offline: true, cacheDir: false, fixtures }), now: NOW, offline: true, warn: (m) => warnings.push(m) });
    return { size: facts.find((f) => f.kind === 'package_size'), warnings };
  };

  it('the enricher reads an old version without dist numbers from its tarball, for inactive packages only', async () => {
    const old = await run(packument({}), true);
    expect(old.size).toMatchObject({ subject: 'pkg:npm/tiny@1.0.0', value: { unpackedSize: 1200, fileCount: 2, dependencies: 2, via: 'npm.tarball' }, evidence: ['https://www.npmjs.com/package/tiny/v/1.0.0', 'https://registry.npmjs.org/tiny/-/tiny-1.0.0.tgz'] });
    expect(old.warnings).toEqual([]);
    // Released last month: the finished test cannot apply, the tarball is not read.
    expect((await run(packument({}, '2026-09-01T00:00:00.000Z'), true)).size).toBeUndefined();
    // Offline without the tarball: size unknown, no warning (the label says what is missing).
    expect(await run(packument({}), false)).toEqual({ size: undefined, warnings: [] });
  });
});
