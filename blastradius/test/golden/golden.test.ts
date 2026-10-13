/**
 * `npm test` runs the golden gate (docs/REFACTOR.md): the replayed outputs must equal the snapshots
 * except for differences declared in DECLARED.md, and a shuffled input order must give the same
 * outputs. `npm run golden:check` is the same check with the full diff printed.
 */
import { describe, expect, it } from 'vitest';
import { parseDeclared, loadDeclared } from './declared.js';
import { diffJson, diffLines } from './diff.js';
import { normaliseJson } from './normalise.js';
import { diffOutputs, loadSnapshots, printDiffs, runGolden, type GoldenOutputs } from './run.js';

describe('golden outputs (recorded scans, offline, default plugin set)', () => {
  let first: GoldenOutputs;

  it('match the snapshots except for declared differences', async () => {
    first = await runGolden();
    const diffs = diffOutputs(loadSnapshots(), first, loadDeclared());
    const undeclared = diffs.filter((d) => !d.declared);
    expect(undeclared.length, `undeclared golden differences (see docs/REFACTOR.md):\n${printDiffs(diffs, 40)}`).toBe(0);
  }, 120_000);

  it('do not depend on the input order (cases, manifests, recorded responses shuffled)', async () => {
    const shuffled = await runGolden({ seed: 0x5eed1 });
    const diffs = diffOutputs(first ?? (await runGolden()), shuffled);
    expect(diffs.length, printDiffs(diffs, 40)).toBe(0);
  }, 120_000);
});

describe('golden tooling', () => {
  it('matches array elements by identity, so an insertion is one entry', () => {
    const a = { findings: [{ purl: 'a', level: 'low' }, { purl: 'b', level: 'high' }] };
    const b = { findings: [{ purl: 'x', level: 'low' }, { purl: 'a', level: 'low' }, { purl: 'b', level: 'critical' }] };
    const d = diffJson(a, b).map((e) => `${e.kind} ${e.path}`);
    expect(d).toEqual(['changed $.findings[purl=b].level', 'added $.findings[purl=x]']);
    expect(diffJson(a, { findings: [a.findings[1]!, a.findings[0]!] }).map((e) => e.path)).toEqual(['$.findings[*order*]']);
  });

  it('diffs HTML by line', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc').map((e) => `${e.kind} ${e.path}`)).toEqual(['added $.line[2]', 'removed $.line[2]']);
  });

  it('normalises run-specific values and set-like arrays', () => {
    const text = JSON.stringify({ serialNumber: 'urn:uuid:1', metadata: { timestamp: 't' }, components: [{ 'bom-ref': 'b', name: '/tmp/x/t' }, { 'bom-ref': 'a' }] });
    expect(normaliseJson('cyclonedx', text, '/tmp/x/t')).toEqual({ serialNumber: 'urn:uuid:<derived>', metadata: { timestamp: '<timestamp>' }, components: [{ 'bom-ref': 'a' }, { 'bom-ref': 'b', name: '<target>' }] });
  });

  it('reads DECLARED.md rows: globs per case, format and path segment; a path covers what is below it', () => {
    const [d] = parseDeclared('| Path | Reason | Stage |\n|---|---|---|\n| `*/json $.coverage.sources[*].plugin` | lineage | 2 |\n');
    expect(d!.match('flask/json', '$.coverage.sources[source=osv].plugin')).toBe(true);
    expect(d!.match('flask/json', '$.coverage.sources[source=osv].plugin.id')).toBe(true);
    expect(d!.match('flask/json', '$.coverage.sources[source=osv].pluginVersion')).toBe(false);
    expect(d!.match('flask/sarif', '$.coverage.sources[source=osv].plugin')).toBe(false);
    expect(() => parseDeclared('| Path | Reason | Stage |\n|---|---|---|\n| $.x | r | 1 |\n')).toThrow(/cannot parse/);
  });
});
