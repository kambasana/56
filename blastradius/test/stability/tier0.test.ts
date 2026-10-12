/**
 * Tier 0 trust pass, problem 3 (moved repositories, release dates, families) on recorded real data:
 * every package the real --history scans of parse-server, jitsi-meet and superset labelled
 * "Fragile: ended in production", replayed through the product code (record-tier0.ts).
 *
 * Hand check (2026-10-12): every row that stays "ended" was checked against npm (the latest
 * release's deprecation message, quoted in the label) or GitHub (archived flag through the GitHub
 * search API, independent of the Scorecard run that the label cites). HAND_CHECKED records how.
 */
import { describe, expect, it } from 'vitest';
import type { StabilityEntry } from '../../src/core/types.js';
import { loadTier0Ended, tier0FamilyReport, tier0Labels } from './tier0.js';

const fx = loadTier0Ended();
const rules = (e: StabilityEntry) => e.rules.map((r) => r.rule);
const ended = (e: StabilityEntry) => rules(e).includes('fragile_ended_production');

/** Remaining Ended rows and how each was verified by hand. */
const NPM = 'npm: latest release deprecated';
const GH = 'GitHub: repository archived (search API) and Scorecard "project is archived"';
const SC = 'Scorecard "project is archived" (API run 2026-08/10), latest release in that repository, no newer repository declared';
export const HAND_CHECKED: Record<string, string> = {
  '@ldapjs/asn1': NPM, '@ldapjs/attribute': NPM, '@ldapjs/change': NPM, '@ldapjs/controls': NPM, '@ldapjs/dn': NPM, '@ldapjs/filter': NPM, '@ldapjs/messages': NPM, '@ldapjs/protocol': NPM,
  ldapjs: NPM, 'crypto-js': NPM, npmlog: NPM, gauge: NPM, 'are-we-there-yet': NPM, inflight: NPM, '@mui/base': NPM, 'node-domexception': NPM,
  '@types/long': NPM, '@types/mime': NPM, '@types/parse-json': NPM, '@types/color-convert': NPM, '@types/expect': NPM, '@types/mapbox-gl': NPM, '@types/pako': NPM,
  '@babel/plugin-proposal-private-property-in-object': NPM, abab: GH, 'bc-css-flags': NPM, 'dot-case': NPM, 'lower-case': NPM, 'no-case': NPM, 'snake-case': NPM,
  'find-cache-dir': NPM, 'pkg-dir': NPM, 'read-pkg-up': NPM, 'intersection-observer': NPM, 'path-dirname': NPM, 'path-is-absolute': NPM, 'sourcemap-codec': NPM, stable: GH,
  'text-encoding': NPM, 'whatwg-encoding': NPM, 'buf-compare': NPM, 'core-assert': NPM, 'deep-strict-equal': NPM, 'lodash.get': NPM, 'lodash.isequal': NPM, topojson: NPM,
  'blueimp-md5': GH, 'cross-env': GH, 'loader-utils': GH, 'prop-types': GH, 'regenerator-runtime': GH, 'regenerator-transform': GH, denque: GH, xtend: GH, 'd3-collection': GH,
  gtoken: GH, 'node-int64': GH, '@mapbox/extent': GH, format: GH, 'node-environment-flags': GH,
  'buffer-equal-constant-time': SC, 'cluster-key-slot': SC, 'config-chain': SC, 'current-executing-script': SC, 'image-capture': SC, lazystream: SC, 'null-loader': SC, pwacompat: SC,
  'd3-tip': SC, 'd3-voronoi': SC, bytewise: SC, typewise: SC, 'redux-undo': SC, 'require-from-string': SC, timers: SC,
};

describe('Tier 0: moved repositories (teardown problem 3)', () => {
  it('parse-server: the packages that moved to a monorepo and are still released are Watch "Moved", not Fragile-ended', async () => {
    const r = await tier0Labels(fx, 'parse-server');
    const by = new Map(r.packages.map((p) => [p.name, p]));
    for (const n of ['@google-cloud/firestore', 'gaxios', 'google-gax', 'retry-request', 'agent-base', 'gcp-metadata']) {
      const e = by.get(n)!;
      expect(ended(e), n).toBe(false);
      expect(e.label, n).toBe('watch');
      expect(rules(e), n).toContain('watch_moved');
    }
    expect(by.get('agent-base')!.action).toBe('Moved: upgrade to 9.x (repo github.com/TooTallNate/proxy-agents, packages/agent-base)');
    expect(by.get('@google-cloud/firestore')!.action).toBe('Moved: upgrade to 9.x (repo github.com/googleapis/google-cloud-node, handwritten/firestore)');
    // The old repository's archived flag is shown as context, never as "ended".
    expect(by.get('agent-base')!.context.map((c) => c.text).join(' ')).toMatch(/earlier repository github\.com\/TooTallNate\/node-agent-base .*not used/);
    expect(by.get('agent-base')!.repo).toEqual({ current: 'https://github.com/TooTallNate/proxy-agents', directory: 'packages/agent-base', previous: ['https://github.com/TooTallNate/node-agent-base'] });
  });

  it('real ends stay Fragile: ldapjs (and @ldapjs/*), crypto-js, npmlog / gauge, @mui/base', async () => {
    const ps = await tier0Labels(fx, 'parse-server');
    const jm = await tier0Labels(fx, 'jitsi-meet');
    const by = new Map([...ps.packages, ...jm.packages].map((p) => [p.name, p]));
    for (const n of ['ldapjs', '@ldapjs/asn1', '@ldapjs/filter', 'crypto-js', 'npmlog', 'gauge', '@mui/base']) {
      expect(by.get(n)!.label, n).toBe('fragile');
      expect(ended(by.get(n)!), n).toBe(true);
    }
  });

  it('false Ended under 5 % on all three repositories; every remaining Ended row is hand-checked', async () => {
    const counts: Record<string, { before: number; after: number; moved: number }> = {};
    for (const repo of Object.keys(fx.scans)) {
      const r = await tier0Labels(fx, repo);
      const after = r.packages.filter(ended);
      for (const e of after) expect(HAND_CHECKED[e.name], `${repo} ${e.name} not hand-checked`).toBeDefined();
      counts[repo] = { before: Object.keys(fx.scans[repo]!.ended).length, after: after.length, moved: r.packages.filter((p) => rules(p).includes('watch_moved')).length };
    }
    // Before → after on the real scans (teardown numbers: 34 / 40 / 34; 14 parse-server false).
    expect(counts).toEqual({
      'parse-server': { before: 34, after: 20, moved: 14 },
      'jitsi-meet': { before: 40, after: 37, moved: 2 },
      superset: { before: 34, after: 29, moved: 2 },
    });
  });

  it('shows "last release <date> (N ago)" before any cadence statistic (cluster-key-slot: not "latest gap 35 days")', async () => {
    const r = await tier0Labels(fx, 'parse-server');
    const cks = r.packages.find((p) => p.name === 'cluster-key-slot')!;
    const s4 = cks.context.find((c) => c.signal === 'S4')!.text;
    expect(s4).toMatch(/^Last release 1\.1\.2 on 2022-11-0\d \(\d years ago\)\. /);
    expect(s4).not.toMatch(/latest gap/);
  });

  it('groups a family into one decision row naming the direct dependency (ldapjs + 8 @ldapjs/*)', async () => {
    const r = await tier0FamilyReport(fx, 'parse-server');
    const ldap = r.decisions!.filter((d) => d.packages.some((p) => p.startsWith('@ldapjs/') || p === 'ldapjs'));
    expect(ldap).toHaveLength(1);
    expect(ldap[0]!.direct).toBe('ldapjs');
    expect(ldap[0]!.packages[0]).toBe('ldapjs');
    expect(ldap[0]!.packages).toHaveLength(9);
    expect(ldap[0]!.action).toMatch(/^Replace or upgrade ldapjs \(direct dependency\): it and 8 packages of the same family it brings in are Fragile/);
    // Moved packages get an upgrade row, not a Fragile one.
    expect(r.decisions!.find((d) => d.packages.includes('agent-base'))!.label).toBe('watch');
  });
});
