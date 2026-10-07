/**
 * The proof run as a CI gate (docs/NEXT-LEVEL.md "What proven means"). Replays every recorded
 * incident offline; any regression in detection, early warning, org exposure or noise fails CI.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runProof, type IncidentResult } from './proof.js';

let results: IncidentResult[];
beforeAll(async () => {
  results = await runProof();
}, 300_000);

const bad = () => results.flatMap((r) => r.bad.map((b) => ({ incident: r.id, ...b })));

describe('proof on recorded real events', () => {
  it('every bad release is critical once its advisory exists', () => {
    expect(bad().length).toBeGreaterThanOrEqual(15);
    expect(bad().filter((b) => b.afterAdvisory?.level !== 'critical').map((b) => `${b.name}@${b.version}`)).toEqual([]);
  });

  it('early warnings before any advisory do not regress (11 of 15 today)', () => {
    const warned = bad().filter((b) => (b.earlyWarning?.signals.length ?? 0) > 0).map((b) => `${b.name}@${b.version}`);
    expect(warned).toEqual(
      expect.arrayContaining(['event-stream@3.3.6', 'ua-parser-js@0.7.29', 'coa@2.0.3', 'rc@1.2.9', 'chalk@5.6.1', 'eslint-config-prettier@8.10.1', 'nx@21.5.0', 'nx@20.9.0']),
    );
    expect(warned.length).toBeGreaterThanOrEqual(11);
    // The longest lead: event-stream's new publisher, months before the advisory.
    const es = bad().find((b) => b.name === 'event-stream')!;
    expect(es.exposureHours).toBeGreaterThan(24 * 70);
    expect(es.earlyWarning?.signals).toContain('publisher_change');
  });

  it('org exposure: the right projects, production only where it really is, in milliseconds', () => {
    const hits = results.flatMap((r) => r.org.hits.map((h) => `${h.project} ${h.component}${h.production ? ' PROD' : ''}`));
    expect([...new Set(hits)].sort()).toEqual(
      [
        'davglass/registry-static event-stream@3.3.6 PROD',
        'davglass/registry-static flatmap-stream@0.1.1 PROD',
        'Esri/a11y-map event-stream@3.3.6',
        'Esri/a11y-map flatmap-stream@0.1.1',
        'Esger/Pentominos2 ua-parser-js@0.7.29',
        'FinnLeh/vs-code-obsidian chalk@5.6.1',
        'FinnLeh/vs-code-obsidian debug@4.4.2',
      ].sort(),
    );
    for (const r of results) expect(r.org.ms, r.id).toBeLessThan(1000);
  });
});
