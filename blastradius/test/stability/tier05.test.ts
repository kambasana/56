/**
 * Tier 0.5: precision fixes after an independent verification of the Tier 0 re-scans, on recorded
 * real data (record-tier05-readmes.ts, record-tier0-identity.ts, record-tier05-pypi.ts).
 *   1. README "ended" only from a project-level declaration (rc-util, amplitude-js; moment kept).
 *   2. Identity merge and continuity (process-warning, react-native-sound, react-native-video).
 *   3. PyPI upkeep labels (flask, superset): never read as clean.
 *   4. History disk budget and shallow clones; 5. funding URLs are never cloned.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFact, type Fact, type StabilityEntry } from '../../src/core/types.js';
import { aggregateHistory } from '../../src/history/aggregate.js';
import { CloneBudget } from '../../src/history/git.js';
import { mergeIdentities } from '../../src/history/merge.js';
import { isFundingUrl, isHistoryRepoUrl } from '../../src/history/repo-url.js';
import { declaredStatusOf } from '../../src/stability/declared.js';
import { loadFixture } from '../history/fixture.js';
import { productionInventory, registryFacts, stabilityOf } from './build.js';
import { tier0IdentityHistory, tier0IdentityLabel } from './tier0.js';
import { loadTier05Readmes, tier05PypiReport } from './tier05.js';
import { TIER05_README_SUBJECTS } from './record-tier05-readmes.js';

const rules = (e: StabilityEntry) => e.rules.map((r) => r.rule);
const s5aRule = (e: StabilityEntry) => rules(e).includes('watch_release_continuity');

describe('Tier 0.5 (1): README "ended" needs a project-level declaration', () => {
  const fx = loadTier05Readmes();
  /** The Tier 0 pattern list matched any "### deprecated" heading anywhere. */
  const TIER0_HEADING = /^#{1,3}\s*deprecated\b/im;

  it('feature documentation is not a declaration: rc-util ("### deprecated" helper), amplitude-js ("Deprecated - React Native"), @xmpp/jid (deprecated XEPs)', () => {
    for (const n of ['rc-util', 'amplitude-js', '@xmpp/jid']) {
      // The recorded README is the real trigger of the Tier 0 false call …
      expect(TIER0_HEADING.test(fx.readmes[n]!.replace(/[*_`]+/g, '')), n).toBe(true);
      // … and is no declaration now.
      expect(declaredStatusOf(fx.readmes[n]), n).toBeUndefined();
    }
  });

  it('real declarations still count (opening section or a status heading first), low confidence', () => {
    const expected: Record<string, string> = {
      moment: 'maintenance_mode',
      'typescript-json-schema': 'maintenance_mode',
      request: 'deprecated',
      'crypto-js': 'unmaintained',
      'path-is-absolute': 'deprecated',
      'node-domexception': 'deprecated',
      'buf-compare': 'deprecated',
      'core-assert': 'deprecated',
      'deep-strict-equal': 'deprecated',
      'os-homedir': 'deprecated',
    };
    for (const [n, status] of Object.entries(expected)) expect(declaredStatusOf(fx.readmes[n])?.status, n).toBe(status);
    expect(declaredStatusOf(fx.readmes.moment)!.phrase).toBe('⚠️ Moment.js is a legacy project, now in maintenance mode.');
    expect(declaredStatusOf(fx.readmes['crypto-js'])!.phrase).toBe('Discontinued: Active development of CryptoJS has been discontinued.');
    // A badge in the opening section counts; the same words deep in the API docs do not.
    expect(declaredStatusOf('# lib\n\n![status](https://img.shields.io/badge/status-unmaintained-red)\n\nA library.')?.status).toBe('unmaintained');
    expect(declaredStatusOf(`# lib\n\nA library.\n\n## Install\n\n## API\n\n### foo\n\nThis package is deprecated in favour of bar.`)).toBeUndefined();
  });

  it('labels at the real scans: amplitude-js and rc-util are not Watch-ended; moment is still Watch with maintenance mode', async () => {
    for (const n of ['rc-util', 'amplitude-js']) {
      const s = TIER05_README_SUBJECTS[n]!;
      const pkg = fx.packages[n]!;
      const asOf = new Date(s.asOf);
      const { report } = await stabilityOf(productionInventory([{ name: n, version: s.version }]), registryFacts(pkg, asOf, pkg.project, fx.recordedAt), () => undefined, asOf);
      const e = report.packages[0]!;
      expect(rules(e), n).not.toContain('watch_ended');
      expect(e.s3.state, n).not.toBe('ended');
      expect(e.s3.declared, n).toBeUndefined();
    }
    const { entry } = await tier0IdentityLabel('moment', '2.31.0');
    expect(entry.label).toBe('watch');
    expect(entry.s3.declared).toBe('maintenance_mode');
    expect(entry.context.some((c) => c.confidence === 'low' && /README declares maintenance mode/.test(c.text))).toBe(true);
  });
});

describe('Tier 0.5 (2): identity merge and release continuity, recorded histories', () => {
  const PARSE = '2026-10-12T16:58:26Z';
  const JITSI = '2026-10-12T17:17:09Z';

  it('process-warning: "KaKa" (a short name) joins the no-reply login climba03003, who publishes it on npm; he already published fastify siblings, so v5.1.0 is no new person', async () => {
    const h = await tier0IdentityHistory('process-warning');
    const at = new Date(PARSE);
    const v510 = (rec: typeof h) => aggregateHistory(rec, at)!.history.changes.find((c) => c.kind === 'release_by_new_person' && c.release === 'v5.1.0');
    // Without the npm account tie the short name merges nothing: the tag's address is new that day.
    expect(v510(mergeIdentities(h).rec)?.daysSinceFirstSeen).toBe(0);
    // With it, the address is the login seen 43 days earlier (the login's own commits).
    expect(v510(mergeIdentities(h, { npmAccounts: ['climba03003'] }).rec)?.daysSinceFirstSeen).toBe(43);
    // Still under 180 days: the cross-registry sibling rule decides (recorded npm answer: fast-json-stringify, 2026-02-06).
    const noSib = await tier0IdentityLabel('process-warning', '2.3.2', { asOf: PARSE, noSiblings: true });
    expect(s5aRule(noSib.entry)).toBe(true);
    const { entry } = await tier0IdentityLabel('process-warning', '2.3.2', { asOf: PARSE });
    expect(s5aRule(entry)).toBe(false);
    expect(entry.s5a.filter((e) => e.date > '2025-10-12')).toEqual([]);
  });

  it('react-native-sound: "RomualdPercereau" = "Romuald Percereau"; the takeover is gone and its date and day count agree', async () => {
    const h = await tier0IdentityHistory('react-native-sound');
    const at = new Date(JITSI);
    const raw = aggregateHistory(h, at)!.history.changes.find((c) => c.kind === 'release_takeover')!;
    // Dated to its release, with the days counted to that date (was "first seen 2025-05-06", 524 days: to the window end).
    expect(raw).toMatchObject({ date: '2025-10-14', release: 'v0.13.0', daysSinceFirstSeen: 161 });
    expect(raw.text).toMatch(/first seen in this repository on 2025-05-06/);
    const merged = mergeIdentities(h);
    expect(merged.merged.displayName).toBeGreaterThanOrEqual(1);
    expect(aggregateHistory(merged.rec, at)!.history.changes.filter((c) => c.kind === 'release_takeover' && c.date > '2025-01-01')).toEqual([]);
    const { entry } = await tier0IdentityLabel('react-native-sound', '0.11.2', { asOf: JITSI });
    expect(s5aRule(entry)).toBe(false);
  });

  it('react-native-video: the 7.0.0-beta.9 pre-release says nothing about 6.19.1 in use; "fnwk" commits join the login fnwk', async () => {
    const { entry } = await tier0IdentityLabel('react-native-video', '6.19.1', { asOf: JITSI });
    expect(s5aRule(entry)).toBe(false);
    expect(entry.s5a.filter((e) => e.release === '7.0.0-beta.9' || e.release === '6.19.3')).toEqual([]);
  });

  it('stack-trace: an account that published 1.0.0-pre1 in 2021 is no newcomer at its first stable release 1.0.0 (2026)', async () => {
    const fx = (await import('./tier0.js')).loadTier0Identity();
    const v = fx.packages['stack-trace']!.packument.versions;
    expect([v['1.0.0-pre1']._npmUser.name, v['1.0.0']._npmUser.name]).toEqual(['niemyjski', 'niemyjski']);
    const { entry } = await tier0IdentityLabel('stack-trace', '0.0.10', { asOf: PARSE });
    expect(entry.s5a.filter((e) => e.release === '1.0.0' || e.release === '1.0.0-pre1')).toEqual([]);
    // The re-scan saw the account's address first 8 days before 1.0.0 (its 2021 activity was not in
    // the clone it read): the same history without that account's earlier commits and tags.
    const { npmContinuity } = await import('../../src/history/continuity.js');
    const h = await tier0IdentityHistory('stack-trace');
    const id = h.npmPublishers!.niemyjski!;
    const cut = Date.parse('2026-01-01T00:00:00Z') / 1000;
    const late = { ...h, commits: h.commits.filter((c) => !(c.author === id && c.at < cut) && !(c.committer === id && c.at < cut)), tags: h.tags.filter((t) => !(t.by === id && t.at < cut)) };
    const pubs = (await tier0IdentityLabel('stack-trace', '0.0.10', { asOf: PARSE })).facts.find((f) => f.kind === 'release_publishers')!.value as never;
    const at = new Date(PARSE);
    // Counted from the account's first stable release alone, 1.0.0 would read as a newcomer's …
    const naive = npmContinuity(late, { ...(pubs as object), accounts: (pubs as any).accounts.map((a: any) => ({ ...a, firstVersion: a.firstStableVersion, firstAt: a.firstStableAt, index: a.firstStableIndex })) } as never, at);
    expect(naive.changes.map((c) => c.release)).toContain('1.0.0');
    // … but the account had published 1.0.0-pre1 five years earlier: no observation.
    expect(npmContinuity(late, pubs, at, { stableOnly: true }).changes.map((c) => c.release)).not.toContain('1.0.0');
  });

  it('the real, benign observations stay (react-native-paper v5.15.0, react-native-safe-area-context 5.7.0): nothing is hidden wholesale', async () => {
    const paper = await tier0IdentityLabel('react-native-paper', '5.14.5', { asOf: JITSI });
    expect(paper.entry.s5a.map((e) => e.release)).toContain('v5.15.0');
    const sac = await tier0IdentityLabel('react-native-safe-area-context', '5.9.1', { asOf: JITSI });
    expect(sac.entry.s5a.map((e) => e.release)).toContain('5.7.0');
  });

  it('the attacks still fire: xz (Jia Tan takeover, also from a shallow clone) and event-stream (3.3.5 by a new npm account)', async () => {
    const xz = loadFixture('xz').record;
    const at = new Date('2024-02-01T00:00:00Z');
    expect(aggregateHistory(mergeIdentities(xz).rec, at)!.history.changes.some((c) => c.kind === 'release_takeover')).toBe(true);
    // The same history as a 60-month shallow clone would hold it.
    const since = Math.floor(Date.parse('2019-02-01T00:00:00Z') / 1000);
    const shallow = { ...xz, commits: xz.commits.filter((c) => c.at >= since), shallowSince: Math.min(...xz.commits.filter((c) => c.at >= since).map((c) => c.at)) };
    const sh = aggregateHistory(mergeIdentities(shallow).rec, at)!;
    expect(sh.history.changes.some((c) => c.kind === 'release_takeover')).toBe(true);
    expect(sh.history.readFrom).toMatch(/^2019-/);
    // Release tags older than the shallow boundary keep their own dates: no negative day counts.
    expect(sh.history.changes.filter((c) => (c.daysSinceFirstSeen ?? 0) < 0)).toEqual([]);
    const { loadSubjects, subjectHistory } = await import('./fixture.js');
    const { STABILITY_SUBJECTS } = await import('./subjects.js');
    const subjects = loadSubjects();
    const pkg = subjects.packages['event-stream']!;
    const es = STABILITY_SUBJECTS.find((x) => x.slug === 'event-stream')!;
    const when = new Date('2018-11-26T00:00:00Z');
    const { report } = await stabilityOf(productionInventory([{ name: 'event-stream', version: '3.3.6' }]), registryFacts(pkg, when, pkg.project, subjects.recordedAt), () => subjectHistory(es.history, 'event-stream'), when);
    expect(report.packages[0]!.s5a.some((e) => e.kind === 'npm_release_by_new_account' && e.release === '3.3.5')).toBe(true);
    expect(s5aRule(report.packages[0]!)).toBe(true);
  });

  it('a shallow history never makes someone first seen in its first two years "new"', () => {
    const DAY = 86400;
    const t0 = Date.parse('2021-10-12T00:00:00Z') / 1000;
    const commits = [];
    // An old maintainer whose first commit in the shallow window is day 30, releasing at day 900;
    // a newcomer first seen at day 1,500 releasing at day 1,550.
    for (let d = 0; d < 1800; d += 10) commits.push({ oid: `c${d}`, parents: 1, author: d >= 30 ? 'hash:old' : 'hash:other', committer: d >= 30 ? 'hash:old' : 'hash:other', at: t0 + d * DAY, signed: false });
    commits.push({ oid: 'n1', parents: 1, author: 'hash:new', committer: 'hash:new', at: t0 + 1500 * DAY, signed: false });
    const rec = { repo: 'https://github.com/x/y', head: 'c0', mailmap: false, bots: 0, commits: commits.reverse(), tags: [{ name: 'v1.0.0', commit: 'c900', by: 'hash:old', at: t0 + 900 * DAY, signed: false, annotated: true }, { name: 'v2.0.0', commit: 'n1', by: 'hash:new', at: t0 + 1550 * DAY, signed: false, annotated: true }], tzMonths: {}, lookup: [], shallowSince: t0 };
    const ch = aggregateHistory(rec, new Date((t0 + 1800 * DAY) * 1000))!.history.changes.filter((c) => c.kind === 'release_by_new_person');
    expect(ch.map((c) => c.release)).toEqual(['v2.0.0']);
  });
});

describe('Tier 0.5 (3): PyPI upkeep is labelled, or counted as Unknown with the reason', () => {
  it('flask: its 7 runtime PyPI packages get labels from the PyPI release record and Scorecard (recorded deps.dev / PyPI responses)', async () => {
    const { report, facts, warnings } = await tier05PypiReport('flask');
    expect(warnings).toEqual([]);
    const prod = report.packages.filter((p) => p.production);
    expect(prod.map((p) => p.name).sort()).toEqual(['blinker', 'click', 'colorama', 'itsdangerous', 'jinja2', 'markupsafe', 'werkzeug']);
    for (const p of prod) {
      expect(p.package.startsWith('pkg:pypi/'), p.name).toBe(true);
      if (p.label === 'unknown') expect(p.missing.length, p.name).toBeGreaterThan(0);
      expect(p.basis, p.name).toMatch(/pypi|none/);
    }
    expect(report.coverage!.production).toEqual({ total: 7, unknown: prod.filter((p) => p.label === 'unknown').length });
    expect(report.coverage!.line).toMatch(/^Upkeep assessed for \d+ of 93 \(PyPI \d+ of 93; Scorecard \/ registry fallback \d+\)/);
    expect(report.coverage!.line).toContain('production Unknown');
    // The release record came from PyPI itself: release dates, the last release, evidence on pypi.org.
    expect(facts.filter((f) => f.kind === 'release_age' && f.source === 'pypi').length).toBeGreaterThanOrEqual(7);
    const werkzeug = prod.find((p) => p.name === 'werkzeug')!;
    expect(werkzeug.context.find((c) => c.signal === 'S4')!.text).toMatch(/^Last release 3\.1\.\d+ on 2026-/);
    expect(werkzeug.context.find((c) => c.signal === 'S4')!.evidence).toEqual(['https://pypi.org/project/werkzeug/']);
  });

  it('superset: all 146 runtime PyPI packages are in the production denominator; Unknown under 10 %, each with its reason', async () => {
    const { report } = await tier05PypiReport('superset');
    const prod = report.packages.filter((p) => p.production);
    expect(prod).toHaveLength(146);
    expect(report.coverage!.production.total).toBe(146);
    expect(report.coverage!.byEcosystem!.pypi).toMatchObject({ packages: 312, production: 146 });
    const unknown = prod.filter((p) => p.label === 'unknown');
    expect(unknown.length / prod.length).toBeLessThan(0.1);
    for (const p of unknown) expect(p.summary, p.name).toMatch(/^Not enough data: /);
    // The archived repository google-auth-library-python while google-auth still releases: moved, not ended.
    const ga = prod.find((p) => p.name === 'google-auth')!;
    expect(rules(ga)).toEqual(['watch_moved']);
    expect(ga.action).toMatch(/^Moved: the declared repository github\.com\/googleapis\/google-auth-library-python is archived while PyPI releases continue/);
    // Archived and no release for years: still ended (backoff 2.2.1, last release 2022).
    expect(rules(prod.find((p) => p.name === 'backoff')!)).toContain('fragile_ended_production');
  });

  it('the HTML never says "No production package is labelled Fragile" while production packages are unassessed', async () => {
    const { stabilitySection } = await import('../../src/report/html-behind.js');
    const { report } = await tier05PypiReport('superset');
    const withoutFragile = { ...report, packages: report.packages.filter((p) => p.label !== 'fragile') };
    const html = stabilitySection({ stability: withoutFragile } as never);
    expect(html).not.toContain('No production package is labelled Fragile');
    expect(html).toMatch(/upkeep is not assessed for \d+ of \d+ production packages \(Unknown\)/);
    expect(html).toContain('Upkeep assessed for');
  });

  it('a production package of an ecosystem without an upkeep source is an Unknown entry with the reason, not left out', async () => {
    const { buildStabilityReport } = await import('../../src/stability/report.js');
    const asset = { id: 'repo:x', kind: 'repo' as const, name: 'x', environment: 'prod' as const, criticality: 3 as const, sourceFile: 'Dockerfile' };
    const inv = { assets: [asset], components: [{ purl: 'pkg:docker/library/python@3.12-slim' as const, ecosystem: 'docker' as const, name: 'library/python', version: '3.12-slim' }], edges: [{ from: asset.id, to: 'pkg:docker/library/python@3.12-slim' as const, scope: 'runtime' as const, direct: true }] };
    const r = buildStabilityReport(inv as never, [], new Date('2026-10-12T00:00:00Z'));
    expect(r.packages).toHaveLength(1);
    expect(r.packages[0]).toMatchObject({ label: 'unknown', production: true, basis: 'none' });
    expect(r.coverage!.production).toEqual({ total: 1, unknown: 1 });
    expect(r.coverage!.skipped).toEqual([{ reason: 'Docker: upkeep not assessed for this ecosystem', count: 1 }]);
  });

  it('PyPI project status and the Inactive classifier (PEP 792 / trove), from PyPI responses', async () => {
    const { pypiFacts } = await import('../../src/enrich/pypi/index.js');
    const { buildStabilityReport } = await import('../../src/stability/report.js');
    const asOf = new Date('2026-10-12T00:00:00Z');
    const project = { info: { version: '1.1.1', classifiers: ['Development Status :: 7 - Inactive'] }, releases: { '0.8.0': [{ upload_time_iso_8601: '2018-01-01T00:00:00Z' }], '0.9.0': [{ upload_time_iso_8601: '2018-06-01T00:00:00Z' }], '1.0.0': [{ upload_time_iso_8601: '2019-01-01T00:00:00Z' }], '1.1.0': [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }], '1.1.1': [{ upload_time_iso_8601: '2021-01-01T00:00:00Z', yanked: true, yanked_reason: 'broken wheel' }], '2.0rc1': [{ upload_time_iso_8601: '2021-06-01T00:00:00Z' }] } };
    const facts = pypiFacts('Old_Lib', ['1.1.1'], project, { 'project-status': { status: 'archived', reason: 'moved to new-lib' } }, asOf, asOf.toISOString());
    const age = facts.find((f) => f.kind === 'release_age')!;
    expect(age.subject).toBe('pkg:pypi/old-lib@1.1.1');
    expect(age.value).toMatchObject({ yanked: 'broken wheel', projectStatus: { status: 'archived', reason: 'moved to new-lib' }, latestVersion: '1.1.1' });
    expect(facts.find((f) => f.kind === 'release_cadence')!.value).toMatchObject({ lastRelease: { version: '1.1.1', date: '2021-01-01' } });
    expect(facts.find((f) => f.kind === 'declared_status')!.value).toEqual({ status: 'unmaintained', phrase: 'Development Status :: 7 - Inactive', via: 'pypi.classifier' });
    const inv = productionInventoryPypi('old-lib', '1.1.1');
    const e = buildStabilityReport(inv, facts, asOf).packages[0]!;
    expect(rules(e)).toContain('fragile_ended_production');
    expect(e.rules[0]!.facts[0]!.text).toBe('PyPI marks the project archived: "moved to new-lib" (project status).');
    expect(e.context.map((c) => c.text)).toContain('The version in use (1.1.1) is yanked on PyPI: "broken wheel".');
  });
});

function productionInventoryPypi(name: string, version: string) {
  const asset = { id: 'repo:gate', kind: 'repo' as const, name: 'gate', environment: 'prod' as const, criticality: 3 as const, sourceFile: 'requirements.txt' };
  const purl = `pkg:pypi/${name}@${version}` as const;
  return { assets: [asset], components: [{ purl, ecosystem: 'pypi' as const, name, version }], edges: [{ from: asset.id, to: purl, scope: 'runtime' as const, direct: true }] };
}

describe('Tier 0.5 (4, 5): history disk budget, shallow clones, funding URLs', () => {
  it('funding and profile pages are never history repositories (github.com/sponsors/encode, declared by flask dependencies)', async () => {
    expect(isHistoryRepoUrl('https://github.com/sponsors/encode')).toBe(false);
    expect(isHistoryRepoUrl('https://github.com/orgs/pallets')).toBe(false);
    expect(isHistoryRepoUrl('https://opencollective.com/babel')).toBe(false);
    expect(isHistoryRepoUrl('https://github.com/pallets/flask')).toBe(true);
    expect(isHistoryRepoUrl('https://gitlab.com/inkscape/inkscape')).toBe(true);
    expect(isFundingUrl('https://github.com/sponsors/encode')).toBe(true);
    const { createHistoryEnricher } = await import('../../src/enrich/history/index.js');
    const { HttpClient } = await import('../../src/core/http.js');
    const meta = { source: 'depsdev', fetchedAt: '2026-10-12T00:00:00Z' };
    const repoFacts: Fact[] = [
      makeFact('repo', 'pkg:pypi/httpx', { url: 'https://github.com/sponsors/encode', host: 'github', via: 'depsdev.links' }, meta),
      makeFact('repo', 'pkg:githubactions/actions/checkout', { url: 'https://github.com/actions/checkout', host: 'github', via: 'depsdev.links' }, meta),
    ];
    let sel: { declared: number } | undefined;
    const asked: string[] = [];
    await createHistoryEnricher({ repoFacts: () => repoFacts, recorded: (u) => (asked.push(u), undefined), onSelection: (s) => (sel = s) }).enrich({ assets: [], components: [], edges: [] }, { http: new HttpClient({ offline: true, cacheDir: false }), now: new Date('2026-10-12T00:00:00Z'), offline: true });
    // Neither the sponsors page nor a CI action (whose history no label would use) is selected.
    expect(sel!.declared).toBe(0);
    expect(asked).toEqual([]);
  });

  it('the clone cache stays under its budget: least recently used clones not in use are deleted first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'br-budget-'));
    try {
      const mk = (name: string, bytes: number, ageS: number) => {
        const p = join(dir, `${name}.git`);
        mkdirSync(p);
        writeFileSync(join(p, 'pack'), Buffer.alloc(bytes));
        const t = new Date(Date.now() - ageS * 1000);
        return import('node:fs').then((fs) => fs.utimesSync(p, t, t));
      };
      await mk('old', 400_000, 300);
      await mk('mid', 300_000, 200);
      await mk('new', 200_000, 100);
      // Budget 1 MB, 300 kB per clone: a new clone needs room for 300 kB.
      const b = new CloneBudget(dir, 1_000_000, 300_000);
      await b.acquire(join(dir, 'next.git'));
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(dir).sort()).toEqual(['mid.git', 'new.git']);
      expect(b.evicted).toBe(1);
      expect(b.peakBytes).toBe(900_000);
      // A clone in use is never deleted, even when it is the oldest.
      await b.acquire(join(dir, 'mid.git'));
      await b.acquire(join(dir, 'third.git'));
      expect(readdirSync(dir).sort()).toEqual(['mid.git']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
