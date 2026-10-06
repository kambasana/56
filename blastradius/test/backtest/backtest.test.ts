/**
 * Historical replays (PLAN §6). Each case scans a small lockfile offline with recorded /
 * reconstructed fixtures at a reference time (`now`): registry history after `now`, incidents
 * dated after `now` and advisories published after `now` are ignored. See README.md.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import type { Finding, ScanResult } from '../../src/core/types.js';
import { scan } from '../../src/pipeline.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = join(ROOT, 'test/fixtures');

async function replay(repo: string, asOf: string): Promise<{ result: ScanResult; requests: number }> {
  const http = new HttpClient({
    offline: true,
    fixturesDir: FIXTURES,
    cacheDir: false,
    minIntervalMs: 0,
    transport: async (req) => {
      throw new Error(`network access attempted in backtest: ${req.url}`);
    },
  });
  const { result } = await scan({ target: join(ROOT, 'test/backtest/repos', repo), offline: true, now: new Date(asOf), http });
  return { result, requests: http.requestCount };
}

function finding(result: ScanResult, purl: string): Finding {
  const f = result.findings.find((x) => x.purl === purl);
  if (!f) throw new Error(`no finding for ${purl}; got ${result.findings.map((x) => x.purl).join(', ')}`);
  return f;
}

describe('backtest (a): event-stream 3.3.6, 2018', () => {
  it('after disclosure (2018-11-27): critical, top reason malware, publisher change explained', async () => {
    const { result, requests } = await replay('event-stream-2018', '2018-11-27T00:00:00Z');
    expect(requests).toBe(0);
    for (const purl of ['pkg:npm/event-stream@3.3.6', 'pkg:npm/flatmap-stream@0.1.1']) {
      const f = finding(result, purl);
      expect(f.level).toBe('critical');
      expect(f.reasons[0]!.factor).toBe('malware');
      expect(f.blastRadius.assets.map((a) => a.assetId)).toContain('repo:bt-event-stream-app');
    }
    const es = finding(result, 'pkg:npm/event-stream@3.3.6');
    const pc = es.reasons.find((r) => r.factor === 'publisher_change');
    expect(pc?.detail).toMatch(/right9ctrl.*dominictarr/);
    // The KB incident (INC-2018-0001, dated 2018-11-20) is in effect at this date.
    expect(es.reasons.some((r) => r.factor === 'malware' && r.detail.includes('INC-2018-0001'))).toBe(true);
  });

  it('before disclosure (2018-09-10): no advisory yet, the publisher change alone ranks it first', async () => {
    const { result } = await replay('event-stream-2018', '2018-09-10T00:00:00Z');
    const es = finding(result, 'pkg:npm/event-stream@3.3.6');
    expect(es.reasons.some((r) => r.factor === 'malware')).toBe(false);
    expect(es.reasons[0]!.factor).toBe('publisher_change');
    expect(['high', 'critical']).toContain(es.level);
    expect(result.findings[0]!.purl).toBe('pkg:npm/event-stream@3.3.6');
    // flatmap-stream had no advisory and no incident yet.
    const fm = result.findings.find((f) => f.purl === 'pkg:npm/flatmap-stream@0.1.1');
    expect(fm === undefined || fm.level === 'low' || fm.level === 'medium').toBe(true);
  });
});

describe('backtest (b): ua-parser-js 0.7.29, 2021', () => {
  it('day after the compromise (2021-10-23): critical, top reason malware, install script recorded', async () => {
    const { result, requests } = await replay('ua-parser-js-2021', '2021-10-23T00:00:00Z');
    expect(requests).toBe(0);
    const f = finding(result, 'pkg:npm/ua-parser-js@0.7.29');
    expect(f.level).toBe('critical');
    expect(f.reasons[0]!.factor).toBe('malware');
    expect(f.reasons[0]!.detail).toContain('INC-2021-0001');
    expect(f.reasons.find((r) => r.factor === 'vuln')?.detail).toContain('GHSA-pjwm-rvh2-c87w');
    expect(f.reasons.map((r) => r.factor)).toContain('install_script');
    expect(f.blastRadius.assets[0]!.assetId).toBe('repo:bt-ua-parser-app');
  });
});

describe('backtest (b′): ua-parser-js 0.7.29 before the advisory', () => {
  // 0.7.29 was published 2021-10-22T12:15Z; GHSA-pjwm was published 20:38Z the same day.
  it('2021-10-22T13:00Z: no advisory or KB hindsight, but the newly added preinstall is flagged', async () => {
    const { result, requests } = await replay('ua-parser-js-2021', '2021-10-22T13:00:00Z');
    expect(requests).toBe(0);
    const f = finding(result, 'pkg:npm/ua-parser-js@0.7.29');
    const factors = f.reasons.map((r) => r.factor);
    expect(factors).not.toContain('malware');
    expect(factors).not.toContain('vuln');
    expect(f.reasons.some((r) => r.detail.includes('INC-2021-0001'))).toBe(false);
    const install = f.reasons.find((r) => r.factor === 'install_script')!;
    expect(install.value).toBe(1);
    expect(install.detail).toContain('preinstall newly added in this version (previous release 0.7.28 had none)');
    expect(install.detail).toContain('new_install_hook');
    expect(f.level).not.toBe('critical');
  });
});

describe('backtest (c): healthy control', () => {
  it('well-known stable packages with no advisories produce no critical or high finding', async () => {
    const { result, requests } = await replay('healthy-control', '2026-01-01T00:00:00Z');
    expect(requests).toBe(0);
    expect(result.inventory.components).toBe(5);
    const severe = result.findings.filter((f) => f.level === 'critical' || f.level === 'high');
    expect(severe).toEqual([]);
    expect(result.findings.flatMap((f) => f.reasons).some((r) => r.factor === 'malware' || r.factor === 'vuln')).toBe(false);
  });
});
