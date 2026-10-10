import { describe, expect, it } from 'vitest';
import type { Asset, ScanResult } from '../core/types.js';
import { escapeHtml, renderHtml, renderJson, renderReport, renderSarif, RULE_FAMILIES, safeHttpUrl, toJsonReport, toSarif } from './index.js';

const XSS = '<script>alert("x")</script>';

function sample(): ScanResult {
  return {
    schemaVersion: '1',
    target: `./repo${XSS}`,
    generatedAt: '2026-06-01T00:00:00.000Z',
    inventory: { assets: 2, components: 3, edges: 4, directComponents: 2, byEcosystem: { npm: 3 }, byScope: { runtime: 3, build: 1 }, withInstallScripts: 1 },
    findings: [
      {
        purl: 'pkg:npm/evil@1.0.0',
        score: 100,
        level: 'critical',
        reasons: [
          {
            factor: 'malware',
            value: 1,
            weight: 1,
            contribution: 1,
            detail: `Listed as malicious in MAL-1: <img src=x onerror=alert(1)>`,
            evidence: ['https://osv.dev/vulnerability/MAL-1', 'javascript:alert(1)'],
          },
          { factor: 'install_script', value: 1, weight: 0.3, contribution: 0, detail: 'Runs install-time scripts (postinstall)', evidence: [] },
        ],
        blastRadius: {
          assets: [
            { assetId: 'repo:app', exposure: 1, paths: [['repo:app', 'pkg:npm/a@1.0.0', 'pkg:npm/evil@1.0.0']] },
            { assetId: 'workflow:.github/workflows/ci.yml', exposure: 0.96, paths: [['workflow:.github/workflows/ci.yml', 'pkg:npm/evil@1.0.0']] },
          ],
          score: 1.864,
        },
        entityChain: [
          { entityId: 'account:npm/x"><b>', relation: 'maintains', confidence: 1 },
          { entityId: 'INC-2026-0001', relation: 'incident', confidence: 0.9 },
        ],
      },
      {
        purl: 'pkg:npm/lib@2.0.0',
        score: 15,
        level: 'low',
        reasons: [{ factor: 'single_maintainer', value: 1, weight: 0.15, contribution: 0.15, detail: 'Package has a single registry maintainer account', evidence: [] }],
        blastRadius: { assets: [], score: 0 },
        entityChain: [],
      },
    ],
    outbound: [
      {
        assetId: 'workflow:.github/workflows/ci.yml',
        score: 54.2,
        reasons: [{ factor: 'privileged_trigger', value: 1, weight: 0.4, contribution: 0.4, detail: 'Uses privileged trigger(s): pull_request_target', evidence: [] }],
      },
    ],
    warnings: [`paths truncated ${XSS}`],
  };
}

const assets: Asset[] = [
  { id: 'repo:app', kind: 'repo', name: 'app', environment: 'prod', criticality: 5, sourceFile: 'package-lock.json' },
  { id: 'workflow:.github/workflows/ci.yml', kind: 'workflow', name: 'ci', environment: 'ci', criticality: 3, sourceFile: '.github/workflows/ci.yml' },
];

describe('escape helpers', () => {
  it('escapes HTML metacharacters and rejects non-http URLs', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('data:text/html,hi')).toBeUndefined();
    expect(safeHttpUrl('https://osv.dev/x')).toBe('https://osv.dev/x');
  });
});

describe('JSON report', () => {
  it('keeps ScanResult fields and adds reach, evidence, summary', () => {
    const j = toJsonReport(sample());
    expect(j.schemaVersion).toBe('1');
    expect(j.summary).toEqual({ findings: 2, byLevel: { critical: 1, high: 0, medium: 0, low: 1 }, maxScore: 100, maxBlastRadius: 1.864 });
    const f = j.findings[0]!;
    expect(f).toMatchObject({ name: 'evil', version: '1.0.0', score: 100, level: 'critical' });
    expect(f.reach).toEqual({ assets: 2, directAssets: 1, paths: 2, shortestPath: 1 });
    expect(f.evidence).toContain('https://osv.dev/vulnerability/MAL-1');
    expect(f.entityChain[1]).toEqual({ entityId: 'INC-2026-0001', relation: 'incident', confidence: 0.9 });
    expect(JSON.parse(renderJson(sample()))).toEqual(j);
    expect(renderReport(sample(), 'json')).toBe(renderJson(sample()));
  });
});

describe('SARIF report', () => {
  it('has valid 2.1.0 shape with one rule per factor family', () => {
    const log = JSON.parse(renderSarif(sample(), { assets })) as any;
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toMatch(/sarif-2\.1\.0/);
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0];
    expect(run.tool.driver.name).toBe('blastradius');
    const ruleIds = run.tool.driver.rules.map((r: any) => r.id);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    expect(ruleIds).toEqual(RULE_FAMILIES.map((r) => r.id));
    for (const r of run.tool.driver.rules) {
      expect(r.shortDescription.text).toBeTruthy();
      expect(r.properties['security-severity']).toMatch(/^\d+\.\d$/);
    }
    for (const res of run.results) {
      expect(ruleIds).toContain(res.ruleId);
      expect(run.tool.driver.rules[res.ruleIndex].id).toBe(res.ruleId);
      expect(['error', 'warning', 'note']).toContain(res.level);
      expect(typeof res.message.text).toBe('string');
      expect(res.locations.length).toBeGreaterThan(0);
      for (const loc of res.locations) {
        expect(loc.physicalLocation.artifactLocation.uri).not.toMatch(/^\//);
        expect(loc.physicalLocation.region.startLine).toBe(1);
      }
      expect(Object.keys(res.partialFingerprints)).toEqual(['blastradius/v1']);
    }
    // evil: malware (BR001) + install_script (BR004); lib: single maintainer (BR007); outbound (BR010)
    expect(run.results.map((r: any) => r.ruleId)).toEqual(['BR001', 'BR004', 'BR007', 'BR010']);
    const malware = run.results[0];
    expect(malware.level).toBe('error');
    expect(malware.locations.map((l: any) => l.physicalLocation.artifactLocation.uri)).toEqual(['.github/workflows/ci.yml', 'package-lock.json']);
    expect(run.results[2].level).toBe('note');
    expect(run.results[3].locations[0].physicalLocation.artifactLocation.uri).toBe('.github/workflows/ci.yml');
    expect(run.invocations[0].toolExecutionNotifications).toHaveLength(1);
  });

  it('falls back to paths derived from asset ids', () => {
    const run = (toSarif(sample()) as any).runs[0];
    expect(run.results[0].locations.map((l: any) => l.physicalLocation.artifactLocation.uri)).toEqual(['.github/workflows/ci.yml', 'package-lock.json']);
  });
});

describe('HTML report', () => {
  it('is self-contained and escapes all untrusted content', () => {
    const html = renderHtml(sample());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\/(?!osv\.dev)/);
    expect(html).not.toMatch(/<link\b/);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('account:npm/x&quot;&gt;&lt;b&gt;');
    expect(html).toContain('<a href="https://osv.dev/vulnerability/MAL-1"');
    expect(html).toContain('<code>javascript:alert(1)</code>');
    expect(html).toContain("Content-Security-Policy");
    // summary, why, paths, evidence
    expect(html).toContain('Top 2 of 2 findings');
    expect(html).toContain('repo:app → pkg:npm/a@1.0.0 → pkg:npm/evil@1.0.0');
    expect(html).toContain('Outbound blast radius');
  });

  it('limits to topN findings', () => {
    const html = renderHtml(sample(), { topN: 1 });
    expect(html).toContain('Top 1 of 2 findings');
    expect(html).not.toContain('id="f1"');
  });
});
