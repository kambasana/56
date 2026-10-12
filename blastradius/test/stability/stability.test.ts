/**
 * P3 gate (docs/WHO-BEHIND-PLAN.md §6, §8, §10) on recorded real data, replayed offline:
 *   - §8 rows for request, moment, left-pad, colors / faker and core-js (plus event-stream's S5a and
 *     the controls express, webpack, @babel/core), with the misses written up in the plan;
 *   - the hand-review sample: 30 Fragile/Watch labels drawn with a fixed seed from the production
 *     dependencies of the control repositories (the review itself is the table in the plan);
 *   - fixtures and outputs carry no e-mail address and no contributor id.
 * Fixtures: test/fixtures/stability/recorded/ (record.ts) and the P2 histories.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StabilityEntry, StabilityReport } from '../../src/core/types.js';
import { findJudgementWord } from '../../src/incidents/schema.js';
import { advisoriesRecorded, controlLabels, productionInventory, registryFacts, stabilityOf } from './build.js';
import { loadControl, loadSubjects, STABILITY_DIR, subjectHistory } from './fixture.js';
import { reviewPopulation, reviewSample } from './sample.js';
import { STABILITY_SUBJECTS } from './subjects.js';

const subjects = loadSubjects();

async function label(slug: string, asOf?: string): Promise<StabilityEntry> {
  const s = STABILITY_SUBJECTS.find((x) => x.slug === slug)!;
  const pkg = subjects.packages[slug]!;
  const at = new Date(asOf ? `${asOf}T00:00:00Z` : subjects.recordedAt);
  const hist = subjectHistory(s.history, slug);
  const { report } = await stabilityOf(productionInventory([{ name: s.name, version: s.version }]), registryFacts(pkg, at, pkg.project, subjects.recordedAt), () => hist, at, advisoriesRecorded([pkg]));
  return report.packages[0]!;
}

const rules = (e: StabilityEntry) => e.rules.map((r) => r.rule);
const facts = (e: StabilityEntry) => e.rules.flatMap((r) => r.facts.map((f) => f.text));

describe('§8 subjects on recorded data (P3 gate)', () => {
  it('row 6 request: Fragile in production because npm deprecated it; the repository is not archived', async () => {
    const e = await label('request');
    expect(e.label).toBe('fragile');
    // P3 refinement: OSV also lists an advisory for 2.88.2 with no fixed release (SSRF, GHSA-p8p7-x288-28g6).
    expect(rules(e)).toEqual(['fragile_ended_production', 'fragile_unfixed_advisory_inactive']);
    expect(facts(e)[0]).toBe('npm marks the latest release (2.88.2) deprecated: "request has been deprecated, see https://github.com/request/request/issues/3142".');
    expect(facts(e)).toContain('OSV advisory GHSA-p8p7-x288-28g6 affects version 2.88.2; OSV lists no fixed release.');
    expect(e.s3).toMatchObject({ state: 'ended', confidence: 'high', lastRelease: '2020-02-11', declared: 'deprecated' });
    expect(e.context.some((c) => c.source === 'scorecard' && /0 commit\(s\)/.test(c.text))).toBe(true);
    expect(JSON.stringify(e)).not.toContain('project is archived');
    expect(e.summary).toBe('Deprecated on npm, used in production; Open advisory with no fixed release.');
  });

  it('row 7 moment: Watch, not Fragile; the declared maintenance mode is context only (miss: no second fact, S4 not irregular)', async () => {
    const e = await label('moment');
    expect(e.label).toBe('watch');
    // Tier 0: the git-side "release by a new account" for 2.31.0 is context (this history has no
    // resolved identities; with them, 2.31.0 went out through npm trusted publishing: tier0.test.ts).
    expect(rules(e)).toEqual(['watch_single_contributor']);
    expect(e.s3).toMatchObject({ state: 'active', declared: 'maintenance_mode', lastRelease: '2026-09-15' });
    expect(e.context.find((c) => c.source === 'npm.readme')?.text).toMatch(/legacy project, now in maintenance mode/);
    expect(e.s4).toMatchObject({ irregular: false, cv: 1.32, latestGapDays: expect.closeTo(992.6, 0) });
    expect(e.caf).toMatchObject({ value: 1, commits: 68 });
  });

  it('row 4 left-pad: S3 ended (deprecated latest release, archived repository) → Fragile in production', async () => {
    const e = await label('left-pad');
    expect(e.label).toBe('fragile');
    expect(facts(e).join(' ')).toMatch(/"project is archived"/);
    expect(facts(e).join(' ')).toMatch(/deprecated: "use String.prototype.padStart\(\)"/);
    expect(e.caf).toMatchObject({ value: 2, commits: 24, to: '2019-03-14' });
    // Small (1.3.0 is a few kB) but deprecated: never "finished", stays Fragile.
    expect(rules(e)).toEqual(['fragile_ended_production']);
    expect(e.finished?.state).toBe('no');
    expect(e.finished?.notMet).toContain('deprecated or archived');
  });

  it('row 3 colors before January 2022: CAF 1 and inactive since 2019 → Fragile (miss: the plan expected Watch)', async () => {
    const before = await label('colors', '2021-12-31');
    expect(before.label).toBe('fragile');
    expect(rules(before)).toEqual(['fragile_single_contributor_inactive']);
    expect(before.s3).toMatchObject({ state: 'inactive', lastCommit: '2019-12-31', lastRelease: '2019-09-22' });
    expect(before.caf).toMatchObject({ value: 1, commits: 116 });
    const now = await label('colors');
    expect(now.label).toBe('watch');
    expect(now.s3).toMatchObject({ state: 'inactive', lastCommit: '2022-01-08' });
  });

  it('row 3 faker: the repository is gone and no faker release is deprecated on npm (miss); Tier 0 fallback: Watch for no release in 18 months', async () => {
    expect(subjects.packages.faker!.historyError).toMatch(/could not read Username/);
    for (const at of [undefined, '2021-12-31']) {
      const e = await label('faker', at);
      expect(e.s3.state).toBe('unknown');
      expect(e.missing[0]).toMatch(/Marak\/Faker\.js was not read/);
      // Without git history the label falls back to the npm release record (5.5.3, 2021-03-23): a
      // release within 12 months at the end of 2021, none in 18 months now.
      expect(e.basis).toBe('npm');
      expect(e.label).toBe(at ? 'steady' : 'watch');
      if (!at) expect(rules(e)).toEqual(['watch_no_recent_release']);
    }
    const versions = subjects.packages.faker!.packument.versions as Record<string, { deprecated?: string }>;
    expect(Object.values(versions).filter((v) => v.deprecated)).toEqual([]);
  });

  it('row 5 core-js: CAF 1 → Watch (repository-level history for the monorepo package)', async () => {
    const e = await label('core-js');
    expect(e.label).toBe('watch');
    expect(rules(e)).toEqual(['watch_single_contributor']);
    expect(e.caf).toMatchObject({ value: 1, commits: 1635 });
    expect(e.context.some((c) => /subdirectory packages\/core-js/.test(c.text))).toBe(true);
  });

  it('row 1 event-stream before the advisory: Watch with S5a (npm and git side), no claim of intent', async () => {
    const e = await label('event-stream', '2018-11-26');
    expect(e.label).toBe('watch');
    expect(rules(e)).toEqual(expect.arrayContaining(['watch_single_contributor', 'watch_release_continuity']));
    const npm = e.s5a.find((x) => x.kind === 'npm_release_by_new_account')!;
    expect(npm).toMatchObject({ release: '3.3.5', daysSinceFirstSeen: 1, date: '2018-09-05', source: 'npm+git' });
    expect(npm.text).toBe('Release 3.3.5 was published on npm by an account first seen in this repository 1 days earlier (release 82 of the package; account matched by its registry e-mail address).');
    expect((await label('event-stream')).label).toBe('fragile');
  });

  it('controls: express Steady (C1 alone stays context), @babel/core Steady, webpack Watch (CAF 1, the P2 miss)', async () => {
    const express = await label('express');
    expect(express.label).toBe('steady');
    expect(express.caf?.value).toBe(6);
    const babel = await label('babel-core');
    expect(babel.label).toBe('steady');
    const webpack = await label('webpack');
    expect(webpack.label).toBe('watch');
    expect(rules(webpack)).toEqual(['watch_single_contributor']);
  });

  it('every generated sentence passes the judgement-word lint and names no person', async () => {
    for (const s of STABILITY_SUBJECTS) {
      const e = await label(s.slug);
      for (const t of [e.summary, ...facts(e), ...e.context.map((c) => c.text), ...e.missing, ...e.s5a.map((x) => x.text)]) {
        expect(findJudgementWord(t), t).toBeUndefined();
        // Repository and registry URLs name an owner (repo-level); the sentences themselves name no account.
        expect(t.replace(/(https:\/\/)?(github\.com|www\.npmjs\.com)\/\S+/g, ''), t).not.toMatch(/hash:|right9ctrl|dominictarr|marak/i);
      }
    }
  });
});

describe('control repositories and the hand-review sample', () => {
  let reports: { repo: string; report: StabilityReport }[] = [];
  beforeAll(async () => {
    reports = await controlLabels(loadControl());
  }, 120_000);

  it('labels every recorded production dependency; counts by label', () => {
    const pop = reviewPopulation(reports);
    const all = new Map<string, StabilityEntry>();
    for (const r of reports) for (const p of r.report.packages) if (p.production && !all.has(p.name)) all.set(p.name, p);
    expect(all.size).toBe(227);
    const by = { fragile: 0, watch: 0, steady: 0, unknown: 0 };
    for (const p of all.values()) by[p.label]++;
    // P3 refinement: 26 small, finished packages move from Fragile to Watch (was 72 / 131 / 8 / 16).
    // Tier 0: the no-clone fallback labels 6 of the 16 Unknown (3 Steady from a recent release or
    // Scorecard, 3 Watch for no release in 18 months); vue and vue-router are Watch "Moved"; ajv,
    // proxy-addr, semver and serve-static were Watch only from git-only S5a or C1, which are context
    // without resolved identities (these histories were recorded before display-name keys).
    expect(by).toEqual({ fragile: 46, watch: 156, steady: 15, unknown: 10 });
    expect(pop).toHaveLength(199);
    const finished = [...all.values()].filter((p) => p.rules.some((r) => r.rule === 'watch_finished_single_contributor_inactive'));
    expect(finished.map((p) => p.name).sort()).toEqual(FINISHED);
    for (const p of finished) {
      expect(p.label).toBe('watch');
      expect(p.summary).toBe('Small, finished package: single maintainer, no recent activity.');
      expect(p.finished?.state).toBe('yes');
    }
    // Fragile stays for CAF 1 + inactive on packages that are not small and finished, with the reason shown.
    const stillFragile = [...all.values()].filter((p) => p.rules.some((r) => r.rule === 'fragile_single_contributor_inactive'));
    expect(stillFragile).toHaveLength(33);
    for (const p of stillFragile) expect(p.finished?.state).not.toBe('yes');
  });

  it('the P3 reviewed sample (seed 20261011, table in the plan) keeps its labels, except the Tier 0 changes listed', () => {
    // Tier 0 changed the population (git-only S5a and C1 are context without resolved identities),
    // so the sample is no longer redrawn: the 30 reviewed packages are checked by name instead.
    const all = new Map<string, StabilityEntry>();
    for (const r of reports) for (const p of r.report.packages) if (p.production && !all.has(p.name)) all.set(p.name, p);
    const now = REVIEWED.map((x) => x.split(':')[0]!).map((n) => `${n}:${all.get(n)!.label}`);
    const TIER0: Record<string, string> = { 'semver:watch': 'semver:steady' };
    expect(now).toEqual(REVIEWED.map((x) => TIER0[x] ?? x));
  });

  it('labels, facts and fixtures carry no e-mail address and no contributor id', () => {
    const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;
    for (const r of reports) {
      const json = JSON.stringify(r.report);
      expect(json).not.toMatch(EMAIL);
      expect(json).not.toContain('hash:');
    }
    expect(gunzipSync(readFileSync(join(STABILITY_DIR, 'control.json.gz'))).toString('utf8')).not.toMatch(EMAIL);
  });
});

/** Packages the finished / low-surface tier moved from Fragile to Watch (all 26 reviewed by hand, plan §10). */
const FINISHED = [
  'aws-sign2',
  'browser-request',
  'bytes',
  'combined-stream',
  'cookie-signature',
  'core-util-is',
  'depd',
  'destroy',
  'ecc-jsbn',
  'escape-html',
  'extend',
  'from',
  'from2',
  'getpass',
  'http-https',
  'is-property',
  'json-schema-traverse',
  'json-stringify-safe',
  'oauth-sign',
  'patch-package-json',
  'safe-buffer',
  'stream-combiner',
  'stream-each',
  'stream-shift',
  'unpipe',
  'utils-merge',
];

/** The 30 labels reviewed by hand (docs/WHO-BEHIND-PLAN.md §10 P3), in sample order. */
const REVIEWED = [
  'clone-stats:watch',
  'finalhandler:watch',
  'hoek:fragile',
  'once:watch',
  'rimraf:watch',
  'aurelia-event-aggregator:watch',
  'path-is-absolute:fragile',
  'concat-with-sourcemaps:watch',
  'jsprim:watch',
  'forwarded:watch',
  'aurelia-http-client:watch',
  'debug:watch',
  'jsonpointer:watch',
  'vue-router:watch',
  'accepts:watch',
  'buffer-from:watch',
  'inherits:watch',
  'http-https:watch', // Fragile before the finished / low-surface tier
  'requirejs:watch',
  'graceful-fs:watch',
  'aurelia-bootstrapper:watch',
  'semver:watch',
  'event-stream:fragile',
  'getpass:watch', // Fragile before the finished / low-surface tier
  'aurelia-pal-browser:fragile',
  'destroy:watch', // Fragile before the finished / low-surface tier
  'aurelia-router:watch',
  'aurelia-polyfills:watch',
  'glob:watch',
  'co:watch',
];
