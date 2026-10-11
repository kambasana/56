/**
 * Stability labels (docs/WHO-BEHIND-PLAN.md §4, P3): S3, S4, S5a npm side, label rules, wording,
 * and the guardrails (labels read repo- and org-level facts only; no person field, no location,
 * no time zone; funding never guessed).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeFact, npmPurl, type CommitHistoryChange, type CommitHistoryValue, type ContributorsValue, type Fact, type Inventory } from '../core/types.js';
import { npmContinuity } from '../history/continuity.js';
import type { HistoryRecord } from '../history/record.js';
import { findJudgementWord } from '../incidents/schema.js';
import { coefficientOfVariation, median, releaseCadence, releasePublishers, type ReleaseRecord } from './cadence.js';
import { declaredStatusOf } from './declared.js';
import { labelPackage } from './label.js';
import { productionComponents } from './production.js';
import { buildStabilityReport } from './report.js';
import { FUNDING_RULES, LABEL_RULES, STABILITY_RULES } from './rules.js';
import { collectInputs, PER_PERSON_FIELDS } from './signals.js';

const NOW = new Date('2026-10-11T00:00:00Z');
const PKG = npmPurl('demo');
const meta = { source: 'npm', fetchedAt: NOW };
const rel = (version: string, iso: string, publisher = 'alice', trusted = false): ReleaseRecord => ({ version, publishedAt: `${iso}T00:00:00.000Z`, publishedMs: Date.parse(`${iso}T00:00:00Z`), publisher, trustedPublisher: trusted });

function history(over: Partial<CommitHistoryValue> = {}, changes: CommitHistoryChange[] = []): CommitHistoryValue {
  return {
    repo: 'https://github.com/example/demo',
    head: 'abc',
    asOf: NOW.toISOString(),
    firstCommit: '2015-01-01',
    lastCommit: '2026-10-01',
    commits: 500,
    windows: [],
    changes,
    people: [{ id: 'hash:0123456789abcdef', firstSeen: '2015-01-01', lastSeen: '2026-10-01', commits: 400, commits24m: 40, releases: 10 }],
    daysSinceLastCommit: 10,
    longestGapDays24m: 30,
    identity: { mapped: 0, hashed: 1, via: ['salted-hash'] },
    ...over,
  };
}

function contributors(caf: number, commits = 60, over: Partial<ContributorsValue> = {}): ContributorsValue {
  return { from: '2024-10-11', to: '2026-10-11', commits, absenceFactor: caf, top: [{ id: 'hash:0123456789abcdef', share: 0.9 }], unmapped: commits, ...over };
}

function facts(opts: { caf?: number; commits?: number; lastCommit?: string; lastRelease?: string; latestDeprecated?: string; declared?: 'deprecated' | 'maintenance_mode'; changes?: CommitHistoryChange[]; irregular?: boolean; archived?: boolean; noHistory?: boolean; cafAtLast?: { commits: number; absenceFactor: number }; size?: { unpackedSize: number; fileCount: number; dependencies: number }; firstPublished?: string; finalYear?: number; vulns?: { id: string; fixed: string[]; published?: string }[] } = {}): Fact[] {
  const lastRelease = opts.lastRelease ?? '2026-09-01';
  const out: Fact[] = [
    makeFact('maintainers', PKG, { maintainers: [{ name: 'alice' }], count: 1 }, meta),
    makeFact('release_age', npmPurl('demo', '1.0.0'), { version: '1.0.0', publishedAt: `${lastRelease}T00:00:00.000Z`, ageDays: 1, latestVersion: '1.0.0', latestPublishedAt: `${lastRelease}T00:00:00.000Z`, ...(opts.latestDeprecated ? { deprecated: opts.latestDeprecated, latestDeprecated: opts.latestDeprecated } : {}), ...(opts.firstPublished ? { firstPublishedAt: `${opts.firstPublished}T00:00:00.000Z` } : {}), ...(opts.finalYear !== undefined ? { releasesInFinalYear: opts.finalYear } : {}) }, meta),
    makeFact('release_cadence', PKG, { releases: 10, medianDays: 30, cv: opts.irregular ? 2 : 0.5, latestGapDays: opts.irregular ? 400 : 30, irregular: opts.irregular === true, lastRelease: { version: '1.0.0', date: lastRelease } }, meta),
    makeFact('release_publishers', PKG, { releases: 10, accounts: [{ name: 'alice', firstVersion: '0.1.0', firstAt: '2015-01-01T00:00:00Z', index: 0, releases: 10, trusted: false }] }, meta),
    makeFact('publisher', npmPurl('demo', '1.0.0'), { name: 'alice', version: '1.0.0' }, meta),
    makeFact('maintainer_change', npmPurl('demo', '1.0.0'), { added: ['bob'], removed: ['carol'], changedAt: '2026-01-01' }, meta),
    makeFact('repo', PKG, { url: 'https://github.com/example/demo', host: 'github', via: 'npm.repository' }, meta),
  ];
  if (opts.size) out.push(makeFact('package_size', npmPurl('demo', '1.0.0'), { version: '1.0.0', ...opts.size, via: 'npm.tarball' }, meta));
  for (const v of opts.vulns ?? []) {
    const url = `https://osv.dev/vulnerability/${v.id}`;
    out.push(makeFact('vuln', npmPurl('demo', '1.0.0'), { id: v.id, aliases: [], severity: 'high', fixedVersions: v.fixed, url, ...(v.published ? { published: v.published } : {}) }, { source: 'osv', fetchedAt: NOW, evidence: [url] }));
  }
  if (opts.declared) out.push(makeFact('declared_status', PKG, { status: opts.declared, phrase: 'This project is deprecated.', via: 'npm.readme' }, meta));
  if (opts.archived) out.push(makeFact('scorecard', PKG, { score: 3, repo: 'github.com/example/demo', date: '2026-08-24', checks: [{ name: 'Maintained', score: 0, reason: 'project is archived' }] }, { source: 'depsdev', fetchedAt: NOW }));
  if (!opts.noHistory) {
    out.push(makeFact('contributors', PKG, contributors(opts.caf ?? 3, opts.commits ?? 60), { source: 'git', fetchedAt: NOW }));
    const h = history({ lastCommit: opts.lastCommit ?? '2026-10-01', ...(opts.cafAtLast ? { cafAtLastCommit: { from: '2018-01-01', to: '2020-01-01', ...opts.cafAtLast } } : {}) }, opts.changes ?? []);
    out.push(makeFact('commit_history', PKG, h, { source: 'git', fetchedAt: NOW }));
  }
  return out;
}

function inv(production = true): Inventory {
  const asset = { id: 'repo:app', kind: 'repo' as const, name: 'app', environment: 'prod' as const, criticality: 3 as const, sourceFile: 'package.json' };
  return { assets: [asset], components: [{ purl: npmPurl('demo', '1.0.0'), ecosystem: 'npm', name: 'demo', version: '1.0.0' }], edges: [{ from: asset.id, to: npmPurl('demo', '1.0.0'), scope: production ? 'runtime' : 'dev', direct: true }] };
}

const entryOf = (f: Fact[], production = true, advisoriesChecked = true) => buildStabilityReport(inv(production), f, NOW, { advisoriesChecked }).packages[0]!;
/** A small package with one contributor, inactive since 2019, first released 2014. */
const SMALL = { caf: 1, commits: 2, lastCommit: '2019-06-01', lastRelease: '2019-06-01', cafAtLast: { commits: 30, absenceFactor: 1 }, size: { unpackedSize: 4046, fileCount: 4, dependencies: 1 }, firstPublished: '2014-01-02', finalYear: 2 } as const;

describe('S4 release regularity (CHAOSS Release Frequency)', () => {
  it('median and coefficient of variation of the gaps', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(coefficientOfVariation([10, 10, 10])).toBe(0);
    expect(coefficientOfVariation([0, 20])).toBeCloseTo(1, 5);
  });
  it('uses the last 10 stable releases, ignores pre-releases, needs 4', () => {
    const h = ['2020-01-01', '2020-02-01', '2020-03-01'].map((d, i) => rel(`1.${i}.0`, d));
    expect(releaseCadence(h, NOW)).toBeUndefined();
    const more = [...h, rel('2.0.0-beta.1', '2020-03-15'), rel('1.3.0', '2020-04-01')];
    const c = releaseCadence(more, NOW)!;
    expect(c.releases).toBe(4);
    expect(c.dates).toEqual(['2020-01-01', '2020-02-01', '2020-03-01', '2020-04-01']);
    expect(c.irregular).toBe(false);
    expect(c.daysSinceLastRelease).toBeGreaterThan(2000);
  });
  it('irregular when CV > 1.5 and the latest gap > 3 × median', () => {
    const days = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06', '2024-01-07', '2024-01-08', '2024-01-09', '2026-01-01'];
    const c = releaseCadence(days.map((d, i) => rel(`1.0.${i}`, d)), NOW)!;
    expect(c.medianDays).toBe(1);
    expect(c.cv).toBeGreaterThan(STABILITY_RULES.irregularCv);
    expect(c.latestGapDays).toBeGreaterThan(3);
    expect(c.irregular).toBe(true);
  });
  it('publisher timeline: first release, position and count per account; later releases ignored', () => {
    const p = releasePublishers([rel('1.0.0', '2020-01-01', 'alice'), rel('1.0.1', '2020-02-01', 'bob'), rel('1.0.2', '2020-03-01', 'alice'), rel('1.0.3', '2027-01-01', 'eve')], NOW)!;
    expect(p.accounts.map((a) => [a.name, a.index, a.releases])).toEqual([
      ['alice', 0, 2],
      ['bob', 1, 1],
    ]);
  });
});

describe('declared status (README, low confidence)', () => {
  it('reads the short fixed list and keeps the sentence', () => {
    expect(declaredStatusOf('# Deprecated!\n\nAs of Feb 11th 2020, request is fully deprecated.')).toMatchObject({ status: 'deprecated' });
    expect(declaredStatusOf('⚠️ Moment.js is a legacy project, now in **maintenance mode**. In most cases…')).toMatchObject({ status: 'maintenance_mode', phrase: '⚠️ Moment.js is a legacy project, now in maintenance mode.' });
    expect(declaredStatusOf('This package is no longer maintained.')).toMatchObject({ status: 'unmaintained' });
  });
  it('does not match an API or option deprecation', () => {
    expect(declaredStatusOf('The `foo()` option is deprecated, use `bar()`.\n\n## Usage')).toBeUndefined();
    expect(declaredStatusOf(undefined)).toBeUndefined();
  });
});

describe('S3 maintenance status', () => {
  it('active, quiet (no commit in 6 months) and inactive (no commit and no release in 18 months)', () => {
    expect(entryOf(facts()).s3.state).toBe('active');
    expect(entryOf(facts({ lastCommit: '2026-03-01' })).s3.state).toBe('quiet');
    expect(entryOf(facts({ lastCommit: '2024-01-01', lastRelease: '2024-03-01' })).s3.state).toBe('inactive');
    // A release within 18 months keeps it out of inactive (plan S3).
    expect(entryOf(facts({ lastCommit: '2024-01-01', lastRelease: '2025-12-01' })).s3.state).toBe('quiet');
  });
  it('ended with high confidence: latest release deprecated on npm, or archived (Scorecard Maintained)', () => {
    const d = entryOf(facts({ latestDeprecated: 'use something else' }));
    expect(d.s3).toMatchObject({ state: 'ended', confidence: 'high' });
    const a = entryOf(facts({ archived: true }));
    expect(a.s3).toMatchObject({ state: 'ended', confidence: 'high' });
    expect(a.rules[0]!.facts[0]!.text).toContain('"project is archived"');
  });
  it('a replay of an earlier date does not read a later archival back into the past', () => {
    const past = new Date('2018-11-27T00:00:00Z');
    const sc = makeFact('scorecard', PKG, { score: 3, repo: 'github.com/example/demo', date: '2026-08-24', checks: [{ name: 'Maintained', score: 0, reason: 'project is archived' }] }, { source: 'depsdev', fetchedAt: NOW });
    const gh = (lastPushAt: string) => makeFact('archived', PKG, { archived: true, lastPushAt }, { source: 'github', fetchedAt: NOW });
    const at = (f: Fact[]) => buildStabilityReport(inv(), f, past).packages[0]!;
    expect(at([...facts({ lastCommit: '2018-11-01', lastRelease: '2018-10-01' }), sc]).s3.state).toBe('active');
    expect(at([...facts({ lastCommit: '2018-11-01', lastRelease: '2018-10-01' }), gh('2018-11-27T03:02:39Z')]).s3.state).toBe('active');
    expect(at([...facts({ lastCommit: '2018-11-01', lastRelease: '2018-10-01' }), gh('2018-11-20T00:00:00Z')]).s3).toMatchObject({ state: 'ended', confidence: 'high' });
  });
  it('a declared status needs a second fact and stays low confidence', () => {
    const alone = entryOf(facts({ declared: 'deprecated' }));
    expect(alone.s3.state).toBe('active');
    expect(alone.context.some((c) => c.source === 'npm.readme')).toBe(true);
    const withGap = entryOf(facts({ declared: 'deprecated', lastRelease: '2024-01-01' }));
    expect(withGap.s3).toMatchObject({ state: 'ended', confidence: 'low' });
    expect(withGap.label).toBe('watch');
  });
});

describe('labels', () => {
  it('Fragile: CAF = 1 and inactive (CAF of the last active 24 months)', () => {
    const e = entryOf(facts({ caf: 1, commits: 2, lastCommit: '2023-06-01', lastRelease: '2023-06-01', cafAtLast: { commits: 80, absenceFactor: 1 } }));
    expect(e.label).toBe('fragile');
    expect(e.rules.map((r) => r.rule)).toEqual(['fragile_single_contributor_inactive']);
    expect(e.summary).toBe('Single active contributor and no commit or release in 18 months.');
    expect(e.caf).toMatchObject({ value: 1, commits: 80, to: '2020-01-01' });
  });
  it('Fragile: ended in production; Watch when only a dev dependency', () => {
    expect(entryOf(facts({ latestDeprecated: 'gone' }), true)).toMatchObject({ label: 'fragile', production: true });
    expect(entryOf(facts({ latestDeprecated: 'gone' }), false)).toMatchObject({ label: 'watch', production: false });
    expect(entryOf(facts({ latestDeprecated: 'gone', noHistory: true }), true).label).toBe('fragile');
  });
  it('finished / low-surface: CAF = 1 and inactive on a small, finished package is Watch, with the facts', () => {
    const e = entryOf(facts(SMALL));
    expect(e.label).toBe('watch');
    expect(e.rules.map((r) => r.rule)).toEqual(['watch_finished_single_contributor_inactive']);
    expect(e.rules[0]!.name).toBe('Watch: small, finished package: single maintainer, no recent activity');
    expect(e.summary).toBe('Small, finished package: single maintainer, no recent activity.');
    const texts = e.rules[0]!.facts.map((f) => f.text);
    expect(texts).toContain('Small package: 1.0.0 is 4.0 kB unpacked in 4 files, with 1 dependency of its own (read from the published tarball).');
    expect(texts).toContain('Long, settled history: first release 2014-01-02; 2 stable releases in the final 12 months before the last release (2019-06-01).');
    expect(texts).toContain('Not deprecated or archived, and no OSV advisory affects the version in use (1.0.0).');
    expect(e.finished).toEqual({ state: 'yes', notMet: [], size: { unpackedSize: 4046, fileCount: 4, dependencies: 1 } });
  });
  it('finished / low-surface: each failed condition keeps Fragile and is shown', () => {
    const cases: [Parameters<typeof facts>[0], RegExp][] = [
      [{ ...SMALL, size: { unpackedSize: 40_000, fileCount: 4, dependencies: 0 } }, /39\.1 kB unpacked \(more than 32\.0 kB\)/],
      [{ ...SMALL, size: { unpackedSize: 4046, fileCount: 11, dependencies: 0 } }, /11 files \(more than 10\)/],
      [{ ...SMALL, size: { unpackedSize: 4046, fileCount: 4, dependencies: 3 } }, /3 dependencies \(more than 2\)/],
      [{ ...SMALL, firstPublished: '2024-01-02' }, /first release 2024-01-02, less than 36 months/],
      [{ ...SMALL, finalYear: 4 }, /4 releases in the final 12 months of its history \(more than 3\)/],
      [{ ...SMALL, vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', fixed: ['1.0.1'] }] }, /open OSV advisory for the version in use \(GHSA-aaaa-bbbb-cccc\)/],
    ];
    for (const [f, why] of cases) {
      const e = entryOf(facts(f));
      expect(e.label, String(why)).toBe('fragile');
      expect(e.rules.map((r) => r.rule)).toEqual(['fragile_single_contributor_inactive']);
      expect(e.finished?.state).toBe('no');
      expect(e.finished?.notMet.join('; ')).toMatch(why);
      expect(e.context.some((c) => /^Not a small, finished package: /.test(c.text))).toBe(true);
    }
    // Deprecated (ended): Fragile through the ended rule, never finished.
    const dep = entryOf(facts({ ...SMALL, latestDeprecated: 'use x' }));
    expect(dep.rules.map((r) => r.rule)).toEqual(['fragile_single_contributor_inactive', 'fragile_ended_production']);
    expect(dep.finished?.notMet).toContain('deprecated or archived');
  });
  it('finished / low-surface: an unknown input (size, or advisories not checked) keeps Fragile and says what is missing', () => {
    const noSize = entryOf(facts({ ...SMALL, size: undefined }));
    expect(noSize.label).toBe('fragile');
    expect(noSize.finished?.state).toBe('unknown');
    expect(noSize.missing.join(' ')).toMatch(/Finished \/ low-surface test not complete \(package size not known for 1\.0\.0\)/);
    const unchecked = entryOf(facts(SMALL), true, false);
    expect(unchecked.label).toBe('fragile');
    expect(unchecked.missing.join(' ')).toMatch(/advisories not checked in this scan/);
  });
  it('Fragile: an open advisory with no fixed release on an inactive package (any CAF); a fixed one does not count', () => {
    const base = { caf: 2, lastCommit: '2019-06-01', lastRelease: '2019-06-01' };
    const e = entryOf(facts({ ...base, vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', fixed: [], published: '2023-03-16T00:00:00Z' }] }));
    expect(e.label).toBe('fragile');
    expect(e.rules.map((r) => r.rule)).toEqual(['fragile_unfixed_advisory_inactive']);
    expect(e.rules[0]!.facts[0]).toMatchObject({ text: 'OSV advisory GHSA-aaaa-bbbb-cccc affects version 1.0.0; OSV lists no fixed release.', source: 'osv', date: '2023-03-16', evidence: ['https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc'] });
    expect(e.summary).toBe('Open advisory with no fixed release, and no commit or release in 18 months.');
    expect(entryOf(facts({ ...base, vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', fixed: ['1.0.1'] }] })).label).toBe('watch');
    // An active package with an unfixed advisory: not a stability rule (the finding is the vulnerability itself).
    expect(entryOf(facts({ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', fixed: [] }] })).label).toBe('steady');
  });
  it('Watch: CAF = 1 alone, quiet alone, inactive with CAF > 1', () => {
    expect(entryOf(facts({ caf: 1 })).rules.map((r) => r.rule)).toEqual(['watch_single_contributor']);
    expect(entryOf(facts({ lastCommit: '2026-01-01' })).rules.map((r) => r.rule)).toEqual(['watch_quiet']);
    expect(entryOf(facts({ caf: 2, lastCommit: '2024-01-01', lastRelease: '2024-01-01' })).rules.map((r) => r.rule)).toEqual(['watch_inactive']);
  });
  it('"contributor base changed" alone is context, never Fragile, and Watch only with another signal', () => {
    const c1: CommitHistoryChange = { kind: 'contributor_base_changed', date: '2026-10-11', text: 'Contributor base changed: commits by long-standing contributors went from 50 % to 16 % (12 months to 2026-10-11).', before: 0.5, after: 0.16 };
    const alone = entryOf(facts({ changes: [c1] }));
    expect(alone.label).toBe('steady');
    expect(alone.context.some((c) => c.signal === 'C1')).toBe(true);
    const withIrregular = entryOf(facts({ changes: [c1], irregular: true }));
    expect(withIrregular.label).toBe('watch');
    expect(withIrregular.rules.map((r) => r.rule)).toEqual(['watch_contributor_base_changed_with_other']);
    const withCafInactive = entryOf(facts({ changes: [c1], caf: 1, lastCommit: '2024-01-01', lastRelease: '2024-01-01' }));
    expect(withCafInactive.rules.every((r) => r.rule !== 'watch_contributor_base_changed_with_other')).toBe(true);
  });
  it('S5a and C2 (fell) within the last 12 months make Watch; older ones do not', () => {
    const s5a: CommitHistoryChange = { kind: 'npm_release_by_new_account', date: '2026-05-01', release: '2.0.0', daysSinceFirstSeen: 3, text: 'Release 2.0.0 was published on npm by an account first seen in this repository 3 days earlier.' };
    expect(entryOf(facts({ changes: [s5a] })).rules.map((r) => r.rule)).toEqual(['watch_release_continuity']);
    expect(entryOf(facts({ changes: [{ ...s5a, date: '2025-10-11' }] })).label).toBe('steady');
    const fell: CommitHistoryChange = { kind: 'signed_share_changed', date: '2026-10-11', text: 'Signed share fell from 95 % to 10 % (12 months to 2026-10-11).', before: 0.95, after: 0.1 };
    expect(entryOf(facts({ changes: [fell] })).rules.map((r) => r.rule)).toEqual(['watch_signed_share_fell']);
    expect(entryOf(facts({ changes: [{ ...fell, before: 0.1, after: 0.95 }] })).label).toBe('steady');
  });
  it('Steady needs git history; Unknown says what is missing', () => {
    expect(entryOf(facts()).label).toBe('steady');
    const u = entryOf(facts({ noHistory: true }));
    expect(u.label).toBe('unknown');
    expect(u.missing[0]).toMatch(/git history of https:\/\/github.com\/example\/demo was not read/);
    expect(entryOf(facts({ commits: 3 })).label).toBe('unknown');
  });
  it('funding is never guessed: its rules are listed, never fired, and every entry says not assessed', () => {
    for (const r of FUNDING_RULES) expect(LABEL_RULES[r]).toMatch(/F[23]/);
    for (const f of [facts(), facts({ caf: 1, lastCommit: '2023-01-01', lastRelease: '2023-01-01', cafAtLast: { commits: 9, absenceFactor: 1 } }), facts({ caf: 1 })]) {
      const e = entryOf(f);
      expect(e.funding).toBe('not_assessed');
      expect(e.rules.some((r) => (FUNDING_RULES as readonly string[]).includes(r.rule))).toBe(false);
    }
  });
  it('wording: factual, passes the judgement-word lint, names no account', () => {
    const variants = [facts(SMALL), facts({ ...SMALL, finalYear: 9 }), facts({ ...SMALL, size: undefined }), facts({ caf: 2, lastCommit: '2019-06-01', lastRelease: '2019-06-01', vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', fixed: [] }] }), facts(), facts({ caf: 1 }), facts({ latestDeprecated: 'use x' }), facts({ archived: true }), facts({ lastCommit: '2026-01-01' }), facts({ caf: 1, commits: 2, lastCommit: '2023-06-01', lastRelease: '2023-06-01', cafAtLast: { commits: 80, absenceFactor: 1 } }), facts({ noHistory: true })];
    for (const f of variants) {
      const e = entryOf(f);
      const texts = [e.summary, ...e.rules.flatMap((r) => [r.name, ...r.facts.map((x) => x.text)]), ...e.context.map((c) => c.text), ...e.missing];
      for (const t of texts) {
        expect(findJudgementWord(t), t).toBeUndefined();
        expect(t).not.toMatch(/alice|bob|carol|hash:/);
      }
      expect(JSON.stringify(e)).not.toMatch(/alice|bob|carol|hash:/);
    }
  });
});

describe('guardrail: labels read repo- and org-level facts only', () => {
  const FORBIDDEN_KINDS = new Set(['publisher', 'publisher_change', 'maintainer_change', 'release_publishers']);
  const forbidden = new Set<string>(PER_PERSON_FIELDS);
  const reads: string[] = [];
  /** Throws when a per-person field is read, anywhere in the value. */
  function guard<T>(v: T, where: string): T {
    if (v === null || typeof v !== 'object') return v;
    return new Proxy(v as object, {
      get(target, key, recv) {
        if (typeof key === 'string' && forbidden.has(key) && Object.hasOwn(target, key)) {
          reads.push(`${where}.${key}`);
          throw new Error(`per-person field read: ${where}.${key}`);
        }
        return guard(Reflect.get(target, key, recv), `${where}.${String(key)}`);
      },
    }) as T;
  }
  /** Throws on any read at all. */
  function sealed<T>(v: T, where: string): T {
    return new Proxy(v as object, {
      get(_t, key) {
        reads.push(`${where}.${String(key)}`);
        throw new Error(`fact about a person read: ${where}.${String(key)}`);
      },
    }) as T;
  }

  it('builds every label without touching a per-person field or a fact about a person', () => {
    const variants = [facts(), facts({ caf: 1 }), facts({ latestDeprecated: 'x' }), facts({ archived: true, declared: 'deprecated' }), facts({ changes: [{ kind: 'contributor_base_changed', date: '2026-10-11', text: 't', before: 0.5, after: 0.1 }], irregular: true }), facts(SMALL), facts({ ...SMALL, vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', fixed: [] }] })];
    for (const f of variants) {
      const wrapped = f.map((x) => ({ ...x, value: FORBIDDEN_KINDS.has(x.kind) ? sealed(x.value, x.kind) : guard(x.value, x.kind) }) as Fact);
      expect(() => buildStabilityReport(inv(), wrapped, NOW)).not.toThrow();
    }
    expect(reads).toEqual([]);
  });

  it('the guard itself works (a read of contributors.top or commit_history.people throws)', () => {
    const f = facts()[facts().length - 2]!; // contributors
    const g = guard(f.value as ContributorsValue, 'contributors');
    expect(() => g.top).toThrow(/per-person/);
    reads.length = 0;
  });

  it('the label code has no location, country or time-zone reads and no per-person keys', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      // The deny-list itself (PER_PERSON_FIELDS) names the fields; everything else must not.
      const src = readFileSync(path.join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
        .replace(/^export const PER_PERSON_FIELDS = .*$/m, '');
      expect(src, file).not.toMatch(/\b(country|location|nationality|timeZones|offsets|hourOfWeekUtc|Intl\.DateTimeFormat|timeZone)\b/);
      expect(src, file).not.toMatch(/\.(top|people|accounts|login|email)\b/);
    }
  });
});

describe('production dependencies', () => {
  it('follows runtime, optional and peer edges from an asset, never dev or build', () => {
    const asset = { id: 'repo:app', kind: 'repo' as const, name: 'app', environment: 'prod' as const, criticality: 3 as const, sourceFile: 'package.json' };
    const p = (n: string) => npmPurl(n, '1.0.0');
    const i: Inventory = {
      assets: [asset],
      components: ['a', 'b', 'c', 'd'].map((n) => ({ purl: p(n), ecosystem: 'npm' as const, name: n, version: '1.0.0' })),
      edges: [
        { from: asset.id, to: p('a'), scope: 'runtime', direct: true },
        { from: p('a'), to: p('b'), scope: 'optional', direct: false },
        { from: asset.id, to: p('c'), scope: 'dev', direct: true },
        { from: p('c'), to: p('d'), scope: 'runtime', direct: false },
      ],
    };
    expect([...productionComponents(i)].sort()).toEqual([p('a'), p('b')]);
  });
});

describe('S5a npm side (history aggregate)', () => {
  const at = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
  const rec: HistoryRecord = {
    repo: 'https://github.com/example/demo',
    head: 'x',
    mailmap: false,
    bots: 0,
    commits: [
      { oid: '1', parents: 1, author: 'hash:aaaa', committer: 'hash:aaaa', at: at('2015-01-01'), signed: false },
      { oid: '2', parents: 1, author: 'hash:bbbb', committer: 'hash:bbbb', at: at('2018-09-04'), signed: false },
    ],
    tags: [],
    tzMonths: {},
    lookup: [],
    npmPublishers: { alice: 'hash:aaaa', mallory: 'hash:bbbb' },
  };
  const pubs = { releases: 5, accounts: [
    { name: 'alice', firstVersion: '1.0.0', firstAt: '2015-01-02T00:00:00Z', index: 0, releases: 3, trusted: false },
    { name: 'mallory', firstVersion: '3.3.5', firstAt: '2018-09-05T00:00:00Z', index: 3, releases: 2, trusted: false },
    { name: 'unmatched', firstVersion: '3.3.7', firstAt: '2018-10-05T00:00:00Z', index: 4, releases: 1, trusted: false },
  ] };
  it('a release published by an account matched by e-mail and first seen < 180 days earlier', () => {
    const r = npmContinuity(rec, pubs, new Date('2018-11-26T00:00:00Z'));
    expect(r).toMatchObject({ accounts: 3, matched: 2 });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: 'npm_release_by_new_account', release: '3.3.5', daysSinceFirstSeen: 1, date: '2018-09-05' });
    expect(r.changes[0]!.text).not.toMatch(/mallory|alice|hash:/);
  });
  it('unmatched and trusted-publishing accounts give no observation', () => {
    const r = npmContinuity({ ...rec, npmPublishers: {} }, { ...pubs, accounts: pubs.accounts.map((a) => ({ ...a, trusted: a.name === 'mallory' })) }, new Date('2018-11-26T00:00:00Z'));
    expect(r.changes).toEqual([]);
  });
});

describe('inputs', () => {
  it('collects by unversioned package and skips facts about people', () => {
    const x = collectInputs(facts()).get(PKG)!;
    expect(x.maintainerCount?.value).toBe(1);
    expect(x.history?.value.events).toEqual([]);
    expect(Object.keys(x)).not.toContain('publisher');
  });
  it('labelPackage works on empty inputs', () => {
    expect(labelPackage({ package: PKG, licenseChanges: [] }, { name: 'demo', versions: ['1.0.0'], production: true }, NOW).label).toBe('unknown');
  });
});
