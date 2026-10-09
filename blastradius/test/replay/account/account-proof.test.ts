/**
 * Account-level proof as a CI gate (PREREGISTRATION.md). It pins what the recorded data shows,
 * including the hypotheses that FAIL, so a change in code or data cannot move a verdict silently.
 * Offline: everything comes from test/replay/account/data and test/replay/data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runAccountProof, type AccountProof } from './proof-account.js';

let p: AccountProof;
beforeAll(async () => {
  p = await runAccountProof();
}, 300_000);

const h1 = (incident: string) => p.h1.find((a) => a.incident === incident)!;

describe('account-level proof on recorded real events', () => {
  it('verdicts match the pre-registered rules', () => {
    expect(p.verdicts.map((v) => `${v.hypothesis} ${v.scope} ${v.pass ? 'pass' : 'fail'}`)).toEqual([
      'H1 chalk-debug-2025 pass',
      'H1 event-stream-2018 fail',
      'H1 shai-hulud-1 fail',
      'H1 shai-hulud-2 pass',
      'H2 N≥5, W=6h fail',
      'H2-24h N≥5, W=24h fail',
    ]);
  });

  it('H1 chalk/debug: the account query names all 19 bad packages at the first advisory', () => {
    const a = h1('chalk-debug-2025');
    expect(a.account).toBe('qix');
    expect(a.t0).toBe('2025-09-08T14:26:51Z');
    expect(a.badPackages.map((b) => b.name)).toEqual(expect.arrayContaining(['chalk', 'debug', 'ansi-styles', 'strip-ansi', 'supports-color', 'error-ex', 'color', 'backslash']));
    expect(a.badPackages).toHaveLength(19);
    expect(a.badPackages.every((b) => b.publishableAtT0)).toBe(true);
    expect([a.badNamedByAccount, a.badNamedByAdvisories, a.advisoriesAtT0]).toEqual([19, 1, 1]);
    expect(a.medianGainPerPackageH).toBe(2.7);
    expect([a.org.named, a.org.namedBad, a.org.namedByAdvisoriesAtT0, a.org.precision]).toEqual([204, 204, 21, 1]);
    expect(a.org.medianGainPerExposureH).toBe(2.7);
    expect(a.org.versionHits).toHaveLength(21);
    expect(a.org.versionHits.filter((v) => v.namedAtT0)).toHaveLength(21);
    expect(a.org.versionHits.filter((v) => v.advisoryAtT0)).toHaveLength(1);
  });

  it('H1 event-stream adds nothing (single takeover)', () => {
    const a = h1('event-stream-2018');
    expect(a.medianGainPerPackageH).toBe(0);
    expect(a.org.named).toBe(a.org.namedByAdvisoriesAtT0);
  });

  it('H1 Shai-Hulud: no gain in wave 1, a small one in wave 2, at low precision', () => {
    const [w1, w2] = p.h1Shai;
    expect([w1!.wave, w1!.medianGainH, w1!.namedEarly]).toEqual(['shai-hulud-1', 0, 37]);
    expect([w2!.wave, w2!.medianGainH, w2!.namedEarly]).toEqual(['shai-hulud-2', 1.3, 245]);
    expect(w2!.precision).toBeLessThan(0.5);
    // Most deleted bad versions have no recoverable publisher; they are excluded, not guessed.
    for (const u of p.data.shaiUnattributed) expect(u.unattributed / u.versions).toBeGreaterThan(0.5);
  });

  it('H2: bursts precede the advisories, but normal accounts burst about twice a month', () => {
    const prim = p.h2.find((r) => r.rule.n === 5 && r.rule.windowH === 6)!;
    expect(prim.incidents.find((i) => i.account === 'qix')?.leadH).toBe(1.1);
    expect(prim.incidents.find((i) => i.account === 'right9ctrl')?.firedAt).toBeNull();
    const shai = prim.incidents.filter((i) => i.incident.startsWith('shai') && i.badPackages >= 5);
    expect(shai.every((i) => (i.leadH ?? 0) > 0)).toBe(true);
    expect(prim.falseAlarmsPerAccountMonth).toBe(2.095);
    expect(prim.falseAlarmsPerAccountMonthExBots).toBeGreaterThan(1);
    expect(prim.controls.find((c) => c.account === 'sindresorhus')?.episodes).toBe(11);
  });

  it('H3 is reported for every project', () => {
    expect(p.h3).toHaveLength(13);
    for (const r of p.h3) {
      expect(r.publishers).toBeGreaterThan(40);
      expect(r.topMaintainerShare).toBeLessThan(0.3);
    }
  });
});
