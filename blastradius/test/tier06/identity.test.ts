/**
 * Tier 0.6 (1): a display name is weak evidence. An independent re-check replayed the recorded xz
 * history with Jia Tan committing under Lasse Collin's display name ("spoof2"): the Tier 0.5 merge
 * joined the two and the takeover disappeared. Identities now merge for continuity signals only on
 * evidence the person cannot pick (same address, .mailmap, GitHub no-reply login, npm publisher
 * account, GitHub's own mapping or a signature it verified); a name match only lowers noise (CAF)
 * and annotates.
 */
import { describe, expect, it } from 'vitest';
import { aggregateHistory } from '../../src/history/aggregate.js';
import { isWeakNameKey, nameDigest, nameKey } from '../../src/history/identity.js';
import { aggregateMerged, mergeIdentities } from '../../src/history/merge.js';
import type { HistoryRecord } from '../../src/history/record.js';
import { loadFixture } from '../history/fixture.js';
import { productionInventory, registryFacts, stabilityOf } from '../stability/build.js';
import { loadSubjects, subjectHistory } from '../stability/fixture.js';
import { STABILITY_SUBJECTS } from '../stability/subjects.js';
import { tier0IdentityLabel } from '../stability/tier0.js';

const SALT = 'tier06-spoof-replay-salt';
// The two ids of the recorded xz history (the re-check's spoof2.mts): Lasse Collin and Jia Tan.
const LASSE = 'hash:f6c63ae7f73f0192';
const JIA = 'hash:e9c80ea4f2f8ddf1';
const XZ_AT = new Date('2024-02-01T00:00:00Z');

function xzWithNames(names: Record<string, string>): HistoryRecord {
  return { ...loadFixture('xz').record, names };
}
const takeovers = (rec: HistoryRecord) => aggregateMerged(mergeIdentities(rec), XZ_AT)!.history.changes.filter((c) => c.kind === 'release_takeover');

describe('Tier 0.6 (1): the xz spoof replay still fires the takeover', () => {
  it('honest names: the takeover fires, with no annotation', () => {
    const t = takeovers(xzWithNames({ [LASSE]: nameKey('Lasse Collin', SALT)!, [JIA]: nameKey('Jia Tan', SALT)! }));
    expect(t).toHaveLength(1);
    expect(t[0]!.possiblySameAs).toBeUndefined();
  });

  it.each([
    ['the same display name', 'Lasse Collin'],
    ['a spacing variant', 'LasseCollin'],
    ['a case variant', 'lasse collin'],
  ])('Jia Tan committing under %s ("%s"): the takeover still fires, annotated "possibly the same person as …"', (_label, spoof) => {
    const rec = xzWithNames({ [LASSE]: nameKey('Lasse Collin', SALT)!, [JIA]: nameKey(spoof, SALT)! });
    const m = mergeIdentities(rec);
    // The weak view would merge them (what Tier 0.5 did, and why the takeover disappeared) …
    expect(aggregateHistory(m.weakRec, XZ_AT)!.history.changes.filter((c) => c.kind === 'release_takeover')).toEqual([]);
    expect(m.merged.displayName).toBe(1);
    // … the strong view does not, so the takeover stays, dated to the causing release.
    const t = takeovers(rec);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ date: '2023-03-18', release: 'v5.2.11' });
    expect(t[0]!.possiblySameAs).toMatch(/^an address first seen in this repository on \d{4}-\d\d-\d\d$/);
    expect(t[0]!.text).toMatch(/Possibly the same person as an address first seen in this repository on .* \(name match only, unverified\)\.$/);
    const agg = aggregateMerged(m, XZ_AT)!;
    expect(agg.history.identity.merged).toMatchObject({ displayName: 1, npmPublisher: 0, keptDespiteNameMatch: expect.any(Number) });
    expect(agg.history.identity.merged!.keptDespiteNameMatch).toBeGreaterThanOrEqual(1);
  });
});

it('a single-word variant ("lassecollin") is a weak key: it merges nothing without a login or npm tie, and the takeover fires', () => {
  const rec = xzWithNames({ [LASSE]: nameKey('Lasse Collin', SALT)!, [JIA]: nameKey('lassecollin', SALT)! });
  expect(mergeIdentities(rec).merged.displayName).toBe(0);
  expect(takeovers(rec)).toHaveLength(1);
});

describe('Tier 0.6 (1): event-stream still fires when the new account copies the maintainer\'s display name', () => {
  it('3.3.5 by right9ctrl stays an S5a rule (npm side), annotated, with honest and with spoofed names', async () => {
    const subjects = loadSubjects();
    const pkg = subjects.packages['event-stream']!;
    const es = STABILITY_SUBJECTS.find((x) => x.slug === 'event-stream')!;
    const base = subjectHistory(es.history, 'event-stream')!;
    const ids = [...new Set(base.commits.flatMap((c) => [c.author, c.committer]))];
    const dominic = base.npmPublishers!.dominictarr!;
    const right9 = base.npmPublishers!.right9ctrl!;
    const when = new Date('2018-11-26T00:00:00Z');
    const label = async (names: Record<string, string>) => {
      const hist = { ...base, names };
      const { report } = await stabilityOf(productionInventory([{ name: 'event-stream', version: '3.3.6' }]), registryFacts(pkg, when, pkg.project, subjects.recordedAt), () => hist, when);
      return report.packages[0]!;
    };
    const honest = Object.fromEntries(ids.map((id, i) => [id, nameKey(`Person Number${i}`, SALT)!]));
    const spoofed = { ...honest, [right9]: honest[dominic]! };
    for (const names of [honest, spoofed]) {
      const e = await label(names);
      expect(e.rules.map((r) => r.rule)).toContain('watch_release_continuity');
      expect(e.s5a.some((x) => x.kind === 'npm_release_by_new_account' && x.release === '3.3.5')).toBe(true);
    }
    const s = (await label(spoofed)).s5a.find((x) => x.release === '3.3.5' && x.kind === 'npm_release_by_new_account')!;
    expect(s.possiblySameAs).toMatch(/^an address first seen in this repository on 2011-/);
  });
});

describe('Tier 0.6 (1): name keys are consistent', () => {
  it('"Li Wei" and "LiWei" have the same strength and digest; one-word names ("Michael") are weak', () => {
    const a = nameKey('Li Wei', SALT)!;
    const b = nameKey('LiWei', SALT)!;
    expect(nameDigest(a)).toBe(nameDigest(b));
    expect([isWeakNameKey(a), isWeakNameKey(b)]).toEqual([true, true]);
    expect(isWeakNameKey(nameKey('Michael', SALT)!)).toBe(true);
    expect(isWeakNameKey(nameKey('Christopher', SALT)!)).toBe(true);
    // Two words of 6+ letters: a strong key, and its spacing / camelCase variants share it.
    const r = nameKey('Romuald Percereau', SALT)!;
    expect(isWeakNameKey(r)).toBe(false);
    expect(nameKey('RomualdPercereau', SALT)).toBe(r);
  });

  it('two different people named "Michael" do not merge (not even for the CAF)', () => {
    const rec = xzWithNames({ [LASSE]: nameKey('Michael', SALT)!, [JIA]: nameKey('Michael', SALT)! });
    const m = mergeIdentities(rec);
    expect(m.merged.displayName + m.merged.loginName).toBe(0);
    expect(m.weakRec).toBe(m.rec);
    expect(takeovers(rec)).toHaveLength(1);
  });

  it('"Li Wei" and "LiWei" are one weak group: no merge without a login or npm account tie (Tier 0.5 merged neither or both depending on spacing)', () => {
    const rec = xzWithNames({ [LASSE]: nameKey('Li Wei', SALT)!, [JIA]: nameKey('LiWei', SALT)! });
    expect(mergeIdentities(rec).merged.displayName).toBe(0);
  });
});

describe('Tier 0.6 (1): the earlier false positives, on recorded real data', () => {
  const PARSE = '2026-10-12T16:58:26Z';
  const JITSI = '2026-10-12T17:17:09Z';
  const s5aRule = (e: { rules: { rule: string }[] }) => e.rules.some((r) => r.rule === 'watch_release_continuity');

  it('quiet on strong evidence alone: nanoid (npm publisher account), react (react-bot), picocolors (creator), process-warning (npm sibling)', async () => {
    for (const [slug, v, asOf] of [
      ['nanoid', '3.3.19', undefined],
      ['react', '18.3.1', undefined],
      ['picocolors', '1.1.1', undefined],
      ['process-warning', '2.3.2', PARSE],
    ] as const) {
      const { entry, facts } = await tier0IdentityLabel(slug, v, asOf ? { asOf } : {});
      expect(s5aRule(entry), slug).toBe(false);
      const h = (facts.find((f) => f.kind === 'commit_history') as any).value;
      expect(h.identity.merged, slug).toEqual(expect.objectContaining({ npmPublisher: expect.any(Number), displayName: expect.any(Number), loginName: expect.any(Number), keptDespiteNameMatch: expect.any(Number) }));
    }
  });

  it('react-native-sound and react-native-video relied on a name match only: their observations come back, annotated (counted in keptDespiteNameMatch)', async () => {
    for (const [slug, v, release, who] of [
      ['react-native-sound', '0.11.2', 'v0.13.0', 'the GitHub login romualdpercereau'],
      ['react-native-video', '6.19.1', '6.19.3', 'the GitHub login fnwk'],
    ] as const) {
      const { entry, facts } = await tier0IdentityLabel(slug, v, { asOf: JITSI });
      expect(s5aRule(entry), slug).toBe(true);
      const e = entry.s5a.find((x) => x.release === release)!;
      expect(e.possiblySameAs, slug).toBe(who);
      const texts = entry.rules.find((r) => r.rule === 'watch_release_continuity')!.facts.map((f) => f.text);
      expect(texts.some((t) => t.endsWith(`Possibly the same person as ${who} (name match only, unverified).`)), slug).toBe(true);
      const h = (facts.find((f) => f.kind === 'commit_history') as any).value;
      expect(h.identity.merged.keptDespiteNameMatch, slug).toBeGreaterThanOrEqual(1);
    }
  });
});
