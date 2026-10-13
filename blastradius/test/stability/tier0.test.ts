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
import { loadTier0Ended, loadTier0Identity, tier0FamilyReport, tier0IdentityHistory, tier0IdentityLabel, tier0Labels } from './tier0.js';

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
      counts[repo] = { before: Object.keys(fx.scans[repo]!.ended).length, after: after.length, moved: r.packages.filter((p) => rules(p).includes('watch_moved')).length, stubs: r.packages.filter((p) => rules(p).includes('watch_stub_types')).map((p) => p.name).sort() } as never;
    }
    // Before → after on the real scans (teardown numbers: 34 / 40 / 34; 14 parse-server false).
    // Tier 0.6: deprecated @types stubs ("X provides its own type definitions") are Watch "Remove:
    // stub types", no longer Ended (was 20 / 37 / 29).
    expect(counts).toEqual({
      'parse-server': { before: 34, after: 18, moved: 14, stubs: ['@types/long', '@types/mime'] },
      'jitsi-meet': { before: 40, after: 35, moved: 2, stubs: ['@types/long', '@types/parse-json'] },
      superset: { before: 34, after: 24, moved: 2, stubs: ['@types/color-convert', '@types/expect', '@types/mapbox-gl', '@types/pako', '@types/parse-json'] },
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

  it('an organisation release bot is not "single maintainer" (gaxios: google-wombot only, recorded packument)', async () => {
    const { slimPackument } = await import('../../src/enrich/npm/registry.js');
    const { packumentFacts } = await import('../../src/enrich/npm/packument.js');
    const { scoreInventory } = await import('../../src/scoring/index.js');
    const { isReleaseBot, RELEASE_BOTS } = await import('../../src/history/bots.js');
    const pkg = fx.packages.gaxios!;
    expect(pkg.packument.maintainers).toEqual([{ name: 'google-wombot' }]);
    const asOf = new Date(fx.scans['parse-server']!.asOf);
    const facts = packumentFacts(slimPackument(pkg.packument), 'gaxios', '7.3.1', { now: asOf });
    const m = facts.find((f) => f.kind === 'maintainers')!;
    expect(m.value).toMatchObject({ count: 1, releaseBots: 1 });
    const r = await tier0Labels(fx, 'parse-server');
    expect(r.packages.find((p) => p.name === 'gaxios')!.context.find((c) => c.signal === 'S1')!.text).toBe('npm lists 1 maintainer with publish rights (an organisation release bot, not a person).');
    const { productionInventory } = await import('./build.js');
    const score = scoreInventory(productionInventory([{ name: 'gaxios', version: '7.3.1' }]), facts, { now: asOf });
    expect(JSON.stringify(score)).not.toContain('single_maintainer');
    // Every allow-list entry names its source.
    for (const b of RELEASE_BOTS) expect(b.source).toMatch(/^https:\/\//);
    for (const n of ['google-wombot', 'github-actions[bot]', 'release-please[bot]', 'semantic-release-bot', 'renovate[bot]', 'dependabot[bot]', 'changeset-bot']) expect(isReleaseBot(n), n).toBe(true);
    expect(isReleaseBot('stephenplusplus')).toBe(false);
  });
});

describe('Tier 0: identity resolution and takeover signals (teardown problem 4), recorded real histories', () => {
  const s5aKinds = (e: StabilityEntry) => e.s5a.map((x) => `${x.kind}:${x.release ?? ''}`);

  it('nanoid: the author moving to a new e-mail address is not a takeover once display names are compared', async () => {
    // Without the merge the aggregate reads the new address as a new top committer making 21 of 22 releases.
    const { aggregateHistory } = await import('../../src/history/aggregate.js');
    const raw = aggregateHistory(await tier0IdentityHistory('nanoid'), new Date('2026-10-11T12:00:00Z'))!;
    expect(raw.history.changes.some((c) => c.kind === 'release_takeover' && /made 21 of the 22 releases/.test(c.text))).toBe(true);
    const after = await tier0IdentityLabel('nanoid', '3.3.19');
    const h2 = (after.facts.find((f) => f.kind === 'commit_history') as any).value;
    // Tier 0.6: the npm account's two registry addresses join them (strong); the name match is the other.
    expect(h2.identity).toMatchObject({ resolved: true, merged: { npmPublisher: 1, displayName: 1, keptDespiteNameMatch: 0 } });
    expect(h2.changes.filter((c: any) => ['release_takeover', 'release_by_new_person'].includes(c.kind))).toEqual([]);
    expect(after.entry.rules.map((r) => r.rule)).not.toContain('watch_release_continuity');
  });

  it('picocolors: the creator, first seen on the repository\'s first day, never "takes over"', async () => {
    const { entry, facts } = await tier0IdentityLabel('picocolors', '1.1.1');
    expect((facts.find((f) => f.kind === 'commit_history') as any).value.changes.filter((c: any) => c.kind === 'release_takeover')).toEqual([]);
    expect(entry.s5a).toEqual([]);
  });

  it('moment 2.31.0 went out through npm trusted publishing: not a release by a new person', async () => {
    const { entry, facts } = await tier0IdentityLabel('moment', '2.31.0');
    const changes = (facts.find((f) => f.kind === 'commit_history') as any).value.changes;
    expect(changes.filter((c: any) => c.release === '2.31.0')).toEqual([]);
    expect(entry.rules.map((r) => r.rule)).toEqual(['watch_single_contributor']);
    // The aggregate alone (as before Tier 0) has a release by a new person and a takeover for 2.31.0.
    const { aggregateHistory } = await import('../../src/history/aggregate.js');
    const raw = aggregateHistory(await tier0IdentityHistory('moment'), new Date('2026-10-11T12:00:00Z'))!;
    expect(raw.history.changes.filter((c) => c.release === '2.31.0' && c.kind !== 'release_handover').map((c) => c.kind).sort()).toEqual(['release_by_new_person', 'release_takeover']);
  });

  it('react: the address change is not a takeover; v19.0.1 went to npm through the org release bot (react-bot)', async () => {
    const { aggregateHistory } = await import('../../src/history/aggregate.js');
    const { mergeIdentities } = await import('../../src/history/merge.js');
    // The aggregate alone dates the observation to its causing release, not to the scan day.
    const raw = aggregateHistory(mergeIdentities(await tier0IdentityHistory('react')).rec, new Date('2026-10-11T12:00:00Z'))!;
    expect(raw.history.changes.find((c) => c.kind === 'release_takeover')).toMatchObject({ date: '2025-12-03', release: 'v19.0.1' });
    const pk = loadTier0Identity().packages.react!.packument;
    expect(pk.versions['19.0.1']._npmUser.name).toBe('react-bot');
    // With the npm publisher of that release (an org release bot) it is not a person's takeover.
    const { entry } = await tier0IdentityLabel('react', '18.3.1');
    expect(s5aKinds(entry).filter((k) => k.startsWith('release_takeover'))).toEqual([]);
    expect(entry.rules.map((r) => r.rule)).not.toContain('watch_release_continuity');
  });

  it('jitsi-meet re-scan cases: the npm publisher is the actor (xmldom 0.8.12), and a tag the package never published is not its release (react v19.0.1 on scheduler)', async () => {
    const { aggregateHistory } = await import('../../src/history/aggregate.js');
    const { mergeIdentities } = await import('../../src/history/merge.js');
    const at = new Date('2026-10-11T12:00:00Z');
    const rawX = aggregateHistory(mergeIdentities(await tier0IdentityHistory('xmldom')).rec, at)!;
    expect(rawX.history.changes.filter((c) => c.release === '0.8.12').map((c) => c.kind)).toEqual(expect.arrayContaining(['release_by_new_person', 'release_takeover']));
    const fx = loadTier0Identity();
    expect(fx.packages.xmldom!.packument.versions['0.8.12']._npmUser.name).toBe(fx.packages.xmldom!.packument.versions['0.8.11']._npmUser.name);
    const x = await tier0IdentityLabel('xmldom', '0.8.12');
    expect(x.entry.s5a.filter((e) => e.release === '0.8.12')).toEqual([]);
    expect(fx.packages.scheduler!.packument.versions['19.0.1']).toBeUndefined();
    const sch = await tier0IdentityLabel('scheduler', '0.26.0');
    expect(sch.entry.s5a.filter((e) => e.release === 'v19.0.1')).toEqual([]);
  });

  it('without resolved identities the git-only S5a is context only (the histories as read before Tier 0)', async () => {
    for (const [slug, v] of [['nanoid', '3.3.19'], ['react', '18.3.1'], ['moment', '2.31.0']] as const) {
      const { entry } = await tier0IdentityLabel(slug, v, { strip: true });
      expect(entry.s5a.filter((x) => x.kind !== 'npm_release_by_new_account'), slug).toEqual([]);
    }
  });

  it('fixtures keep only salted hashes: no e-mail address, no display name', async () => {
    // Tier 0.5 recordings add weak (short one-word) keys and login keys, salted the same way.
    for (const slug of ['nanoid', 'react', 'picocolors', 'moment', 'process-warning', 'react-native-sound', 'react-native-video', 'react-native-paper', 'react-native-safe-area-context', 'stack-trace']) {
      const h = await tier0IdentityHistory(slug);
      for (const k of [...Object.values(h.names ?? {}), ...Object.values(h.loginNames ?? {})]) expect(k).toMatch(/^w?name:[0-9a-f]{16}$/);
      for (const l of Object.keys(h.loginNames ?? {})) expect(l).toMatch(/^[A-Za-z0-9-]+$/);
      const ids = new Set([...h.commits.flatMap((c) => [c.author, c.committer])]);
      for (const id of ids) expect(id).toMatch(/^(hash:[0-9a-f]{16}|[A-Za-z0-9-]+)$/);
      expect(JSON.stringify(h)).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    }
  });
});

describe('Tier 0: maintainer additions that are a team event (the npm/cli case)', () => {
  it('an account added across sibling npm/cli packages is not scored; recorded packuments at parse-server\'s locked versions', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { gunzipSync } = await import('node:zlib');
    const { STABILITY_DIR } = await import('./fixture.js');
    const { NPMCLI } = await import('./record-tier0-maintainers.js');
    const { packumentFacts } = await import('../../src/enrich/npm/packument.js');
    const { markSiblingMaintainers } = await import('../../src/enrich/npm/siblings.js');
    const { scoreInventory } = await import('../../src/scoring/index.js');
    const { productionInventory } = await import('./build.js');
    const fx = JSON.parse(gunzipSync(readFileSync(join(STABILITY_DIR, 'tier0-maintainers.json.gz'))).toString('utf8'));
    const now = new Date(fx.asOf);
    const facts = Object.entries(NPMCLI).flatMap(([n, v]) => packumentFacts(fx.packuments[n], n, v, { now }));
    const changes = facts.filter((f) => f.kind === 'maintainer_change' && f.value.added.length > 0);
    expect(changes.length).toBeGreaterThanOrEqual(8);
    const inv = productionInventory(Object.entries(NPMCLI).map(([name, version]) => ({ name, version })));
    const before = JSON.stringify(scoreInventory(inv, facts, { now }));
    expect(before).toMatch(/Maintainer list changed/);
    expect(markSiblingMaintainers(facts)).toBe(changes.length);
    for (const c of changes) expect((c as any).value.sibling).toMatchObject({ by: expect.stringMatching(/scope|repository/) });
    expect(JSON.stringify(scoreInventory(inv, facts, { now }))).not.toMatch(/Maintainer list changed/);
  });

  it('a lone package gaining an account no sibling has keeps the signal', async () => {
    const { markSiblingMaintainers } = await import('../../src/enrich/npm/siblings.js');
    const { makeFact } = await import('../../src/core/types.js');
    const meta = { source: 'npm', fetchedAt: '2026-10-11T00:00:00Z' };
    const facts = [
      makeFact('maintainers', 'pkg:npm/%40acme/a', { maintainers: [{ name: 'old' }, { name: 'newcomer' }], count: 2 }, meta),
      makeFact('maintainers', 'pkg:npm/%40acme/b', { maintainers: [{ name: 'old' }], count: 1 }, meta),
      makeFact('maintainer_change', 'pkg:npm/%40acme/a@2.0.0', { added: ['newcomer'], removed: [], changedAt: '2026-10-01T00:00:00Z', version: '2.0.0' }, meta),
    ];
    expect(markSiblingMaintainers(facts)).toBe(0);
  });
});

describe('Tier 0: upkeep events are threshold crossings between two stored scans', () => {
  async function eventStreamAt(asOf: string) {
    const { loadSubjects, subjectHistory } = await import('./fixture.js');
    const { STABILITY_SUBJECTS } = await import('./subjects.js');
    const { productionInventory, registryFacts, stabilityOf } = await import('./build.js');
    const subjects = loadSubjects();
    const s = STABILITY_SUBJECTS.find((x) => x.slug === 'event-stream')!;
    const pkg = subjects.packages['event-stream']!;
    const at = new Date(`${asOf}T00:00:00Z`);
    const hist = subjectHistory(s.history, 'event-stream');
    return (await stabilityOf(productionInventory([{ name: 'event-stream', version: '3.3.6' }]), registryFacts(pkg, at, pkg.project, subjects.recordedAt), () => hist, at)).report;
  }

  it('event-stream: the 3.3.5 release by a new npm account is one event, dated to the release, between scans of 2018-08-31 and 2018-11-26', async () => {
    const { stabilityEvents } = await import('../../src/stability/events.js');
    const before = await eventStreamAt('2018-08-31');
    const after = await eventStreamAt('2018-11-26');
    expect(stabilityEvents(null, after)).toMatchObject({ baseline: true, events: [] });
    const r = stabilityEvents(before, after);
    expect(r.baseline).toBe(false);
    const s5a = r.events.filter((e) => e.kind === 'release_continuity');
    expect(s5a.map((e) => [e.date, e.release, e.rules[0]])).toContainEqual(['2018-09-05', '3.3.5', 'npm_release_by_new_account']);
    for (const e of r.events) expect(e.date >= '2018-08-28').toBe(true);
    expect(r.events.length).toBeLessThanOrEqual(20);
  });

  it('rising stability is not an event; the same scan twice has none; dev-only packages are left out', async () => {
    const { stabilityEvents } = await import('../../src/stability/events.js');
    const before = await eventStreamAt('2018-08-31');
    const after = await eventStreamAt('2018-11-26');
    expect(stabilityEvents(after, before).events.filter((e) => e.kind === 'label_worsened')).toEqual([]);
    expect(stabilityEvents(after, after).events).toEqual([]);
    const dev = { ...after, packages: after.packages.map((p) => ({ ...p, production: false })) };
    const r = stabilityEvents(before, dev);
    expect(r.events).toEqual([]);
    expect(r.omitted.notProduction).toBeGreaterThan(0);
  });
});

describe('Tier 0: monorepo release tags belong to their own package', () => {
  it('googleapis/google-cloud-node tags from parse-server\'s real scan: projectify / logging-winston releases are not gaxios releases', async () => {
    const { tagBelongsTo } = await import('../../src/enrich/history/index.js');
    expect(tagBelongsTo('projectify-v5.0.0', 'gaxios', 'core/packages/gaxios')).toBe(false);
    expect(tagBelongsTo('logging-winston-v6.0.1', '@google-cloud/firestore', 'handwritten/firestore')).toBe(false);
    expect(tagBelongsTo('projectify-v5.0.0', '@google-cloud/projectify', 'core/projectify')).toBe(true);
    expect(tagBelongsTo('gaxios-v8.2.0', 'gaxios', 'core/packages/gaxios')).toBe(true);
    // Unprefixed tags belong to every package of the repository (protobufjs v6.11.5, xz v5.2.11).
    expect(tagBelongsTo('v6.11.5', '@protobufjs/utf8')).toBe(true);
    expect(tagBelongsTo('v5.2.11', 'xz')).toBe(true);
    expect(tagBelongsTo('xz-5.2', 'xz')).toBe(true);
  });
});
