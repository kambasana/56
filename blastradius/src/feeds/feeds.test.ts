/**
 * Feeds sync gates (docs/FEEDS-AND-DETECTORS.md §2.4), on a trimmed slice of real data recorded
 * on 2026-10-08 (test/fixtures/feeds, see record.ts there): the OSV npm modified_id.csv cut at the
 * end of 2026-10-07 with its records, and slices of the Datadog manifest and the BKC name list.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../cli.js';
import { loadPack, packMalware } from '../pack/load.js';
import { DEFAULT_KB_DIR } from '../pipeline.js';
import { offlineFetcher } from './fetcher.js';
import { normTs, FeedStore } from './store.js';
import { syncFeeds, type FeedSyncOptions } from './sync.js';
import { zipEntries, zipRead, zipWrite } from './zip.js';

const FIX = fileURLToPath(new URL('../../test/fixtures/feeds', import.meta.url));
const OSV_DIR = join(FIX, 'osv', 'npm');
const DAY = '2026-10-07';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `feeds-${p}-`));
const records = () =>
  readdirSync(OSV_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(OSV_DIR, f), 'utf8') }));

/** A copy of the fixture whose all.zip holds `files` (name → text). */
function fixtureWithZip(files: { name: string; text: string }[]): string {
  const dir = tmp('fix');
  cpSync(FIX, dir, { recursive: true });
  writeFileSync(join(dir, 'osv', 'npm', 'all.zip'), zipWrite(files.map((f) => ({ name: f.name, data: Buffer.from(f.text) }))));
  return dir;
}

async function run(store: FeedStore, fixDir: string, outDir: string, extra: Partial<FeedSyncOptions> = {}) {
  return syncFeeds(store, offlineFetcher(fixDir), { outDir, kbDir: DEFAULT_KB_DIR, ...extra });
}

const modifiedOf = (text: string) => (JSON.parse(text) as { modified: string }).modified;

describe('zip reader', () => {
  it('reads what it writes', () => {
    const z = zipWrite([
      { name: 'a.json', data: Buffer.from('{"id":"a"}') },
      { name: 'b.json', data: Buffer.from('x'.repeat(5000)) },
    ]);
    const es = zipEntries(z);
    expect(es.map((e) => e.name)).toEqual(['a.json', 'b.json']);
    expect(zipRead(z, es[1]!)!.toString()).toBe('x'.repeat(5000));
  });
});

describe('timestamps', () => {
  it('normalises precision so strings order correctly', () => {
    expect(normTs('2020-02-21T20:20:53Z')).toBe('2020-02-21T20:20:53.000000000Z');
    expect(normTs('2026-10-07T15:45:06.67280518Z')).toBe('2026-10-07T15:45:06.672805180Z');
    expect(normTs('2020-02-21T20:20:53Z') < normTs('2020-02-21T20:20:53.5Z')).toBe(true);
  });
});

describe('feeds sync (recorded day of OSV npm)', () => {
  it('incremental replay of a recorded modified_id.csv day equals a full rebuild, byte for byte', async () => {
    const all = records();
    // Day-0 state: everything modified before the day, plus an older copy of one record the day
    // updates (MAL-2026-14486), so the replay exercises insert and update.
    const before = all.filter((f) => modifiedOf(f.text) < DAY);
    const updated = all.find((f) => f.name === 'MAL-2026-14486.json')!;
    const old = JSON.parse(updated.text) as { modified: string; affected: { versions?: string[] }[] };
    old.modified = '2026-09-01T00:00:00Z';
    old.affected[0]!.versions = ['0.0.1'];
    const day0 = fixtureWithZip([...before, { name: updated.name, text: JSON.stringify(old) }]);
    // ... and the CSV as published at the start of the day (the updated record at its old time).
    const csv0 = join(day0, 'osv', 'npm', 'modified_id.csv');
    const rows0 = readFileSync(csv0, 'utf8').split('\n').filter((l) => l && l < DAY);
    writeFileSync(csv0, `${['2026-09-01T00:00:00Z,MAL-2026-14486', ...rows0].sort().reverse().join('\n')}\n`);

    const incStore = new FeedStore(':memory:');
    const incOut = tmp('inc');
    const boot = await run(incStore, day0, tmp('boot'));
    expect(boot.osv!.mode).toBe('bootstrap-zip');
    expect(boot.osv!.inserted).toBe(before.length + 1);
    // The day's CSV rows are only fetched by the incremental pass.
    const dayFix = tmp('day');
    cpSync(FIX, dayFix, { recursive: true });
    const inc = await run(incStore, dayFix, incOut);
    expect(inc.osv!.mode).toBe('incremental');
    const dayRows = readFileSync(join(OSV_DIR, 'modified_id.csv'), 'utf8').split('\n').filter((l) => l.startsWith(DAY)).length;
    expect(inc.osv!.fetched).toBe(dayRows);
    expect(inc.osv!.updated).toBe(1);
    expect(inc.osv!.inserted).toBe(dayRows - 1);

    const fullStore = new FeedStore(':memory:');
    const fullOut = tmp('full');
    const full = await run(fullStore, fixtureWithZip(all), fullOut);
    expect(full.osv!.fetched).toBe(0);

    const a = readFileSync(inc.emit.packFile);
    const b = readFileSync(full.emit.packFile);
    expect(a.equals(b)).toBe(true);
    expect(readFileSync(join(incOut, 'listing.json'), 'utf8')).toBe(readFileSync(join(fullOut, 'listing.json'), 'utf8'));
    // The pack loads with the existing loader and answers lookups.
    const pack = (await loadPack(inc.emit.packFile, inc.emit.listing.sha256)).pack;
    expect(packMalware(pack, 'spf-analytics', '9.9.9').map((r) => r.id)).toEqual(['MAL-2026-14486']);
    expect(inc.emit.listing.highWater['osv:npm']).toBe('2026-10-07T23:30:04.705618979Z');
    expect(inc.emit.listing.newestModified).toBe('2026-10-07T23:30:04.705618979Z');
  });

  it('bootstrap without all.zip (walking the CSV) gives the same pack', async () => {
    const viaZip = await run(new FeedStore(':memory:'), fixtureWithZip(records()), tmp('z'));
    const viaCsv = await run(new FeedStore(':memory:'), FIX, tmp('c'));
    expect(viaCsv.osv!.mode).toBe('bootstrap-csv');
    expect(readFileSync(viaCsv.emit.packFile).equals(readFileSync(viaZip.emit.packFile))).toBe(true);
  });

  it('is idempotent: a re-run writes nothing to the store or the output directory', async () => {
    const store = new FeedStore(':memory:');
    const out = tmp('idem');
    const first = await run(store, FIX, out);
    expect(first.storeChanges).toBeGreaterThan(0);
    expect(first.emit.written).toEqual([expect.stringMatching(/^pack-\d{8}T\d{6}Z\.json\.gz$/), expect.stringMatching(/\.sha256$/), 'listing.json']);
    const mtimes = readdirSync(out).map((f) => statSync(join(out, f)).mtimeMs);
    const again = await run(store, FIX, out);
    expect(again.storeChanges).toBe(0);
    expect(again.emit.written).toEqual([]);
    expect(again.osv!.fetched).toBe(0);
    expect(again.datadog!.changed).toBe(false);
    expect(readdirSync(out).map((f) => statSync(join(out, f)).mtimeMs)).toEqual(mtimes);
  });

  it('is deterministic: two independent runs give identical bytes and names', async () => {
    const a = await run(new FeedStore(':memory:'), FIX, tmp('d1'));
    const b = await run(new FeedStore(':memory:'), FIX, tmp('d2'));
    expect(a.emit.listing.url).toBe(b.emit.listing.url);
    expect(readFileSync(a.emit.packFile).equals(readFileSync(b.emit.packFile))).toBe(true);
    // builtAt is the newest source timestamp (here the Datadog commit date), not the wall clock.
    expect(a.emit.listing.builtAt).toBe('2026-10-08T08:19:02.000Z');
  });

  it('turns a withdrawn record into a tombstone: kept in the store, absent from the index', async () => {
    // MAL-2024-1398 (drata) is withdrawn in the real feed. Day 0 holds it live; the CSV then
    // lists the real, withdrawn record.
    const all = records();
    const real = all.find((f) => f.name === 'MAL-2024-1398.json')!;
    const live = JSON.parse(real.text) as Record<string, unknown>;
    delete live.withdrawn;
    live.modified = '2024-08-01T00:00:00Z';
    const day0 = fixtureWithZip([...all.filter((f) => f !== real), { name: real.name, text: JSON.stringify(live) }]);
    const store = new FeedStore(':memory:');
    const out = tmp('wd');
    // An all.zip that still has the live copy, and a CSV whose rows are all older than the zip's mark
    // minus the overlap except the withdrawal: bootstrap then incremental.
    const first = await run(store, day0, out);
    expect(packMalware((await loadPack(first.emit.packFile)).pack, 'drata', '1.0.0').map((r) => r.id)).toEqual(['MAL-2024-1398']);

    const dir = tmp('wdcsv');
    cpSync(FIX, dir, { recursive: true });
    const csv = join(dir, 'osv', 'npm', 'modified_id.csv');
    // The withdrawal is published as a fresh modification at the top of the CSV.
    const withdrawn = { ...(JSON.parse(real.text) as Record<string, unknown>), modified: '2026-10-08T01:00:00Z' };
    writeFileSync(join(dir, 'osv', 'npm', real.name), JSON.stringify(withdrawn));
    writeFileSync(csv, `2026-10-08T01:00:00Z,MAL-2024-1398\n${readFileSync(csv, 'utf8')}`);
    const second = await run(store, dir, out);
    expect(second.osv!.withdrawn).toBe(1);
    const row = store.get('osv:npm', 'MAL-2024-1398')!;
    expect(row.withdrawnAt).toBe('2024-08-29T04:29:00.000000000Z');
    expect(JSON.parse(row.json).id).toBe('MAL-2024-1398');
    expect(packMalware((await loadPack(second.emit.packFile)).pack, 'drata', '1.0.0')).toEqual([]);
    expect(store.count('osv:npm').withdrawn).toBe(1);
  });

  it('tombstones dataset entries that disappear from the manifest', async () => {
    const store = new FeedStore(':memory:');
    await run(store, FIX, tmp('ds1'));
    const dir = tmp('ds');
    cpSync(FIX, dir, { recursive: true });
    const dd = join(dir, 'git', 'DataDog__malicious-software-packages-dataset');
    const manifest = JSON.parse(readFileSync(join(dd, 'samples', 'npm', 'manifest.json'), 'utf8')) as Record<string, unknown>;
    delete manifest['000webhost-admin'];
    writeFileSync(join(dd, 'samples', 'npm', 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dd, 'HEAD.json'), JSON.stringify({ commit: 'f'.repeat(40), date: '2026-10-09T00:00:00Z' }));
    const r = await run(store, dir, tmp('ds2'));
    expect(r.datadog!.withdrawn).toBe(1);
    expect(store.get('datadog:npm', '000webhost-admin')!.withdrawnAt).not.toBeNull();
    expect(packMalware((await loadPack(r.emit.packFile)).pack, '000webhost-admin', '1.0.0')).toEqual([]);
  });
});

describe('precedence: KB > GitHub reviewed > OSV MAL > dataset manifests', () => {
  async function pack() {
    const r = await run(new FeedStore(':memory:'), FIX, tmp('prec'));
    return { r, pack: (await loadPack(r.emit.packFile)).pack };
  }

  it('lists the KB record first and keeps the OSV advisories beside it', async () => {
    const { pack: p } = await pack();
    expect(packMalware(p, 'event-stream', '3.3.6').map((r) => r.id)).toEqual(['INC-2018-0001', 'GHSA-mh6f-8j2x-4483']);
    expect(packMalware(p, 'event-stream', '3.3.6')[0]).toMatchObject({ source: 'kb', url: 'https://github.com/dominictarr/event-stream/issues/116' });
    expect(packMalware(p, 'event-stream', '3.3.5')).toEqual([]);
  });

  it('adds dataset entries only where nothing ranked above covers them', async () => {
    const { r, pack: p } = await pack();
    // chalk 5.6.1: KB and MAL already; the Datadog entry corroborates and is not added again.
    expect(packMalware(p, 'chalk', '5.6.1').map((x) => x.id)).toEqual(['INC-2025-0002', 'MAL-2025-46969']);
    // 000webhost-admin is only in the Datadog manifest (null = every version).
    expect(packMalware(p, '000webhost-admin', '1.2.3')).toEqual([{ id: 'datadog:npm/000webhost-admin', source: 'datadog', url: 'https://github.com/DataDog/malicious-software-packages-dataset/tree/main/samples/npm' }]);
    expect(r.compile.datasetOnly).toBeGreaterThan(0);
    expect(r.compile.corroborated).toBeGreaterThan(0);
  });

  it('keeps and flags contradicted "every version" claims instead of letting them override', async () => {
    const { pack: p } = await pack();
    const c = (name: string) => p.conflicts!.filter((x) => x.name === name).map((x) => [x.ref.id, x.contradictedBy]);
    // Datadog says every version of 0vulns-dependency-confusion-poc; OSV MAL names 1.0.0 only.
    expect(c('0vulns-dependency-confusion-poc')).toEqual([['datadog:npm/0vulns-dependency-confusion-poc', ['MAL-2025-5016']]]);
    expect(packMalware(p, '0vulns-dependency-confusion-poc', '2.0.0')).toEqual([]);
    expect(packMalware(p, '0vulns-dependency-confusion-poc', '1.0.0').map((x) => x.id)).toEqual(['MAL-2025-5016']);
    // GitHub reviewed says every version of flatmap-stream; the KB names 0.1.1 only.
    expect(c('flatmap-stream')).toEqual([['GHSA-mh6f-8j2x-4483', ['INC-2018-0001']]]);
    expect(packMalware(p, 'flatmap-stream', '0.1.1').map((x) => x.id)).toEqual(['INC-2018-0001']);
    // ">= 0.0.0, never fixed" (GHSA-7wgh) agrees with MAL's "every version": no conflict.
    expect(c('1337qq-js')).toEqual([]);
    expect(packMalware(p, '1337qq-js', '5.0.0').map((x) => x.id)).toEqual(['GHSA-7wgh-5q4q-6wx5', 'MAL-2025-6983']);
  });

  it('keeps range-only advisories as ranges, and BKC names as labels that never match', async () => {
    const { pack: p } = await pack();
    expect(p.malware.packages.fsevents).toBeUndefined();
    expect(packMalware(p, 'fsevents', '1.2.10').map((x) => x.id)).toEqual(['MAL-2023-462']);
    expect(packMalware(p, 'fsevents', '2.3.3')).toEqual([]);
    expect(p.labels!['spf-analytics']).toEqual(['bkc']);
    expect(p.labels!.debug).toEqual(['bkc']);
    // debug is in BKC (names only) but only 4.4.2 is known bad (Datadog list).
    expect(packMalware(p, 'debug', '4.4.1')).toEqual([]);
    expect(packMalware(p, 'debug', '4.4.2').map((x) => x.id)).toEqual(['INC-2025-0002']);
  });

  it('carries a NOTICE table (source, licence, snapshot) in the pack and the listing', async () => {
    const { r, pack: p } = await pack();
    expect(p.sources.map((s) => s.name.split(' ')[0])).toEqual(['OSV', 'Blastradius', 'Datadog', "Backstabber's"]);
    expect(r.emit.listing.notice.find((n) => n.name.startsWith('Datadog'))).toMatchObject({ licence: 'Apache-2.0', snapshot: 'df32a361b27b78c5de4cdb4b4c549b666accaa40 (2026-10-08T08:19:02.000000000Z)' });
    expect(Object.keys(r.emit.listing.highWater).sort()).toEqual(['bkc:npm', 'datadog:npm', 'kb', 'osv:npm']);
  });
});

describe('feeds sync CLI', () => {
  it('runs offline from a recorded directory and prints a JSON report', async () => {
    const dir = tmp('cli');
    let stdout = '';
    await buildProgram({ stdout: (s) => void (stdout += s), stderr: () => {} }).parseAsync(['node', 'blastradius', 'feeds', 'sync', '--store', join(dir, 'feeds.db'), '--out', join(dir, 'out'), '--offline-from', FIX]);
    const report = JSON.parse(stdout) as { listing: { url: string; sha256: string }; written: string[] };
    expect(report.written).toContain('listing.json');
    expect(readFileSync(join(dir, 'out', `${report.listing.url}.sha256`), 'utf8')).toMatch(new RegExp(`^${report.listing.sha256}  `));
    rmSync(dir, { recursive: true, force: true });
  });
});
