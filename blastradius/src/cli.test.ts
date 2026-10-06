import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram, parseAsOf, parseFormats } from './cli.js';
import { failsThreshold, formatSummary, countByLevel } from './summary.js';
import type { Finding, ScanResult } from './core/types.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) } };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('cli options', () => {
  it('parses report formats', () => {
    expect(parseFormats('all')).toEqual(['json', 'sarif', 'html']);
    expect(parseFormats('sarif, json,sarif')).toEqual(['sarif', 'json']);
    expect(() => parseFormats('xml')).toThrow(/unknown format/);
  });

  it('parses --as-of dates', () => {
    expect(parseAsOf('2018-11-27').toISOString()).toBe('2018-11-27T00:00:00.000Z');
    expect(parseAsOf('2021-10-23T12:00:00Z').toISOString()).toBe('2021-10-23T12:00:00.000Z');
    expect(() => parseAsOf('yesterday')).toThrow();
  });

  it('rejects unknown formats and --fail-on levels', async () => {
    for (const args of [
      ['scan', '.', '--format', 'xml'],
      ['scan', '.', '--fail-on', 'medium'],
    ]) {
      const p = buildProgram(capture().io).exitOverride();
      p.commands.forEach((c) => c.exitOverride().configureOutput({ writeErr: () => {} }));
      await expect(p.parseAsync(['node', 'blastradius', ...args])).rejects.toThrow();
    }
  });

  it('validates the bundled incident KB', async () => {
    const c = capture();
    await buildProgram(c.io).exitOverride().parseAsync(['node', 'blastradius', 'kb', 'validate']);
    expect(c.out.join('')).toMatch(/^\d+ file\(s\) checked, 0 error\(s\)/);
    expect(process.exitCode).toBeUndefined();
  });

  it('accepts a directory with no incident files', async () => {
    const c = capture();
    await buildProgram(c.io).exitOverride().parseAsync(['node', 'blastradius', 'kb', 'validate', 'test/fixtures/ingest/no-lock']);
    // No YAML files there: nothing to validate is not an error.
    expect(c.out.join('')).toMatch(/file\(s\) checked/);
  });
});

function finding(purl: string, score: number, level: Finding['level']): Finding {
  return {
    purl,
    score,
    level,
    reasons: [{ factor: 'vuln', value: 1, weight: 1, contribution: 1, detail: 'CVE\u001b[31m test', evidence: [] }],
    blastRadius: { assets: [], score: 0 },
    entityChain: [],
  };
}

describe('terminal summary', () => {
  const result: ScanResult = {
    schemaVersion: '1',
    target: 'x',
    generatedAt: '2020-01-01T00:00:00.000Z',
    inventory: { assets: 1, components: 2, edges: 2, directComponents: 1, byEcosystem: {}, byScope: {}, withInstallScripts: 0 },
    findings: [finding('pkg:npm/a@1.0.0', 85, 'critical'), finding('pkg:npm/b@1.0.0', 40, 'medium')],
  };

  it('counts levels and applies --fail-on thresholds', () => {
    expect(countByLevel(result)).toEqual({ critical: 1, high: 0, medium: 1, low: 0 });
    expect(failsThreshold(result, 'critical')).toBe(true);
    expect(failsThreshold({ ...result, findings: [result.findings[1]!] }, 'high')).toBe(false);
  });

  // Regression: a dangerous publishing workflow must trip --fail-on even with no dependency findings.
  it('applies --fail-on to outbound workflow findings', () => {
    const outbound = { ...result, findings: [], outbound: [{ assetId: 'workflow:.github/workflows/release.yml', score: 64.3, reasons: [] }] };
    expect(failsThreshold(outbound, 'high')).toBe(true);
    expect(failsThreshold(outbound, 'critical')).toBe(false);
  });

  it('lists top findings with their top reason and strips control characters', () => {
    const s = formatSummary(result, { top: 1 });
    expect(s).toContain('critical 1 | high 0 | medium 1 | low 0');
    expect(s).toContain('[CRITICAL]  85.0  pkg:npm/a@1.0.0');
    expect(s).toContain('vuln: CVE [31m test');
    expect(s).not.toContain('\u001b');
    expect(s).not.toContain('pkg:npm/b@1.0.0');
  });
});
