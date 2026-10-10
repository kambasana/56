import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeFact, type Inventory } from '../core/types.js';
import { addOsvRecord, emptyPack, finishPack, isMalwareAdvisory, parseAttackMeta } from './build.js';
import { createPackEnricher } from './enricher.js';
import { loadPack, packMalware } from './load.js';

const npm = (name: string) => ({ name, ecosystem: 'npm' });

describe('pack builder', () => {
  it('splits whole-package malware from bad releases of otherwise good packages', () => {
    const p = emptyPack('2026-10-07T00:00:00.000Z');
    addOsvRecord(p.malware, { id: 'MAL-2022-10', published: '2022-06-20T20:22:01Z', affected: [{ package: npm('0-shadowenv'), ranges: [{ events: [{ introduced: '0' }] }] }] });
    addOsvRecord(p.malware, { id: 'MAL-2025-46969', affected: [{ package: npm('chalk'), versions: ['5.6.1'], ranges: [{ events: [{ introduced: '5.6.1' }, { fixed: '5.6.2' }] }] }] });
    expect(p.malware.packages['0-shadowenv']).toEqual([{ id: 'MAL-2022-10', published: '2022-06-20T20:22:01.000Z' }]);
    expect(p.malware.versions.chalk).toEqual({ '5.6.1': [{ id: 'MAL-2025-46969' }] });
  });
  it('keeps range-only advisories as ranges (MAL-2023-462: fsevents >=1.0.0 <1.2.11), never as every version', () => {
    const p = emptyPack('x');
    addOsvRecord(p.malware, { id: 'MAL-2023-462', affected: [{ package: npm('fsevents'), ranges: [{ events: [{ introduced: '1.0.0' }, { fixed: '1.2.11' }] }] }] });
    expect(p.malware.packages.fsevents).toBeUndefined();
    const pack = finishPack(p, []);
    expect(packMalware(pack, 'fsevents', '2.3.3')).toEqual([]);
    expect(packMalware(pack, 'fsevents', '1.2.10').map((r) => r.id)).toEqual(['MAL-2023-462']);
    expect(packMalware(pack, 'fsevents', '1.2.11')).toEqual([]);
    expect(pack.counts.rangeAdvisories).toBe(1);
  });
  it('keeps GitHub advisories only when tagged CWE-506, and never twice', () => {
    const es = { id: 'GHSA-mh6f-8j2x-4483', database_specific: { cwe_ids: ['CWE-506'] }, affected: [{ package: npm('event-stream'), versions: ['3.3.6'] }, { package: npm('event-stream'), versions: ['3.3.6'] }] };
    expect(isMalwareAdvisory(es)).toBe(true);
    expect(isMalwareAdvisory({ id: 'GHSA-xxxx-yyyy-zzzz', database_specific: { cwe_ids: ['CWE-79'] } })).toBe(false);
    const p = emptyPack('x');
    expect(addOsvRecord(p.malware, es)).toBe(true);
    expect(addOsvRecord(p.malware, { id: 'GHSA-xxxx-yyyy-zzzz', affected: [{ package: npm('lodash'), versions: ['4.17.20'] }] })).toBe(false);
    expect(addOsvRecord(p.malware, { id: 'MAL-2020-1', withdrawn: '2021-01-01', affected: [{ package: npm('x') }] })).toBe(false);
    expect(p.malware.versions['event-stream']).toEqual({ '3.3.6': [{ id: 'GHSA-mh6f-8j2x-4483' }] });
    expect(p.malware.versions.lodash).toBeUndefined();
  });
  it('imports npm attacks from supplychain-attack-data as alleged incidents', () => {
    const yaml = `- id: ironworm-npm
  title: IronWorm
  start_date: 2026-06-03
  target: { name: asteroiddao, kind: maintainer }
  method: { cause: compromised_account_credentials }
  artifacts:
  - { package: weavedb-lite, ecosystem: npm, versions: [0.1.1] }
  - { package: some-gem, ecosystem: rubygems, versions: [1.0.0] }
`;
    const [inc] = parseAttackMeta(yaml, 'https://github.com/tstromberg/supplychain-attack-data', 'ironworm-npm');
    expect(inc).toMatchObject({ id: 'ironworm-npm', cause: 'compromised_account_credentials', startDate: '2026-06-03', target: { name: 'asteroiddao', kind: 'maintainer' }, status: 'alleged', packages: [{ name: 'weavedb-lite', versions: ['0.1.1'] }] });
    expect(parseAttackMeta('- id: gems-only\n  artifacts: [{ package: g, ecosystem: rubygems }]\n', 'u', 'd')).toEqual([]);
  });
  it('is deterministic: same inputs, same bytes', () => {
    const build = (order: string[]) => {
      const p = emptyPack('t');
      for (const n of order) addOsvRecord(p.malware, { id: `MAL-1-${n}`, affected: [{ package: npm(n) }] });
      return JSON.stringify(finishPack(p, []));
    };
    expect(build(['b', 'a', 'c'])).toBe(build(['c', 'b', 'a']));
  });
});

describe('pack loader and enricher', () => {
  async function writePack() {
    const p = emptyPack('2026-10-07T00:00:00.000Z');
    addOsvRecord(p.malware, { id: 'GHSA-mh6f-8j2x-4483', published: '2018-11-26T00:00:00Z', database_specific: { cwe_ids: ['CWE-506'] }, affected: [{ package: npm('event-stream'), versions: ['3.3.6'] }] });
    addOsvRecord(p.malware, { id: 'MAL-2025-1', affected: [{ package: npm('@evil/pkg') }] });
    const dir = await mkdtemp(join(tmpdir(), 'pack-'));
    const file = join(dir, 'pack.json.gz');
    await writeFile(file, gzipSync(Buffer.from(JSON.stringify(finishPack(p, [])))));
    return file;
  }
  it('loads a gzipped pack, checks the SHA-256 and answers lookups', async () => {
    const file = await writePack();
    const loaded = await loadPack(file);
    expect(packMalware(loaded.pack, 'event-stream', '3.3.6').map((r) => r.id)).toEqual(['GHSA-mh6f-8j2x-4483']);
    expect(packMalware(loaded.pack, 'event-stream', '3.3.5')).toEqual([]);
    expect(packMalware(loaded.pack, '@evil/pkg', '9.9.9').map((r) => r.id)).toEqual(['MAL-2025-1']);
    await expect(loadPack(file, '0'.repeat(64))).rejects.toThrow(/does not match/);
  });
  it('adds malware facts, skipping what live OSV already reported', async () => {
    const loaded = await loadPack(await writePack());
    const inv: Inventory = {
      assets: [],
      edges: [],
      components: [
        { purl: 'pkg:npm/event-stream@3.3.6', name: 'event-stream', version: '3.3.6', ecosystem: 'npm' },
        { purl: 'pkg:npm/%40evil/pkg@1.0.0', name: '@evil/pkg', version: '1.0.0', ecosystem: 'npm' },
        { purl: 'pkg:npm/lodash@4.17.21', name: 'lodash', version: '4.17.21', ecosystem: 'npm' },
      ] as Inventory['components'],
    };
    const live = [makeFact('malware', 'pkg:npm/%40evil/pkg@1.0.0', { id: 'MAL-2025-1', origin: 'osv' }, { source: 'osv', fetchedAt: 'x', evidence: [] })];
    const facts = await createPackEnricher(loaded, () => live).enrich(inv, { warn: () => {} } as never);
    expect(facts.map((f) => [f.subject, (f.value as { id: string }).id, (f.value as { published?: string }).published])).toEqual([['pkg:npm/event-stream@3.3.6', 'GHSA-mh6f-8j2x-4483', '2018-11-26T00:00:00.000Z']]);
  });
});
