/**
 * End-to-end: CLI + pipeline against test/fixtures/e2e-repo, fully offline with recorded fixtures.
 * The fixture repo depends on ms (healthy) and on event-stream@3.3.6 → flatmap-stream@0.1.1,
 * and has a pull_request_target workflow with tag-pinned actions.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import type { Finding, ScanResult } from '../../src/core/types.js';
import { scan, type ScanOutput } from '../../src/pipeline.js';
import { buildProgram, EXIT_POLICY } from '../../src/cli.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO = join(ROOT, 'test/fixtures/e2e-repo');
const FIXTURES = join(ROOT, 'test/fixtures');
/** Shortly after the 2018-11-26 public advisory: the state of the world for this replay. */
const AS_OF = new Date('2018-11-27T00:00:00Z');

function offlineHttp(): HttpClient {
  // Any request without a fixture fails with OfflineMissError: nothing can reach the network.
  return new HttpClient({
    offline: true,
    fixturesDir: FIXTURES,
    cacheDir: false,
    minIntervalMs: 0,
    transport: async (req) => {
      throw new Error(`network access attempted in test: ${req.url}`);
    },
  });
}

let out: string;
let run: ScanOutput;
let http: HttpClient;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'br-e2e-'));
  http = offlineHttp();
  run = await scan({ target: REPO, outDir: join(out, 'api'), offline: true, now: AS_OF, http });
});

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

function byName(result: ScanResult, name: string): Finding {
  const f = result.findings.find((x) => x.purl.startsWith(`pkg:npm/${name}@`));
  if (!f) throw new Error(`no finding for ${name}`);
  return f;
}

describe('e2e: offline scan of test/fixtures/e2e-repo', () => {
  it('never touches the network', () => {
    expect(http.requestCount).toBe(0);
  });

  it('builds the inventory: repo + workflow assets, npm + action components', () => {
    const ids = run.inventory.assets.map((a) => a.id).sort();
    expect(ids).toEqual(['repo:e2e-app', 'workflow:.github/workflows/pr-check.yml']);
    expect(run.inventory.assets.find((a) => a.id === 'repo:e2e-app')!.environment).toBe('prod');
    const purls = run.inventory.components.map((c) => c.purl);
    expect(purls).toEqual(expect.arrayContaining(['pkg:npm/event-stream@3.3.6', 'pkg:npm/flatmap-stream@0.1.1', 'pkg:npm/ms@2.1.1', 'pkg:githubactions/actions/checkout@v4']));
  });

  it('scores event-stream and flatmap-stream critical', () => {
    for (const name of ['event-stream', 'flatmap-stream']) {
      const f = byName(run.result, name);
      expect(f.level).toBe('critical');
      expect(f.score).toBeGreaterThanOrEqual(80);
      expect(f.reasons[0]!.factor).toBe('malware');
    }
    // The two critical findings are the top of the list.
    expect(run.result.findings.slice(0, 2).map((f) => f.level)).toEqual(['critical', 'critical']);
  });

  it('explains event-stream with malware and the publisher change', () => {
    const factors = byName(run.result, 'event-stream').reasons.map((r) => r.factor);
    expect(factors).toContain('malware');
    expect(factors).toContain('publisher_change');
    const pc = byName(run.result, 'event-stream').reasons.find((r) => r.factor === 'publisher_change')!;
    expect(pc.detail).toContain('right9ctrl');
    expect(pc.evidence.every((u) => u.startsWith('https://'))).toBe(true);
  });

  it('computes a blast radius that reaches the prod asset, including the transitive path', () => {
    const es = byName(run.result, 'event-stream');
    const fm = byName(run.result, 'flatmap-stream');
    for (const f of [es, fm]) {
      const prod = f.blastRadius.assets.find((a) => a.assetId === 'repo:e2e-app');
      expect(prod).toBeDefined();
      expect(prod!.exposure).toBe(1); // runtime scope
      expect(f.blastRadius.score).toBeGreaterThan(0);
    }
    const fmPath = fm.blastRadius.assets.find((a) => a.assetId === 'repo:e2e-app')!.paths[0];
    expect(fmPath).toEqual(['repo:e2e-app', 'pkg:npm/event-stream@3.3.6', 'pkg:npm/flatmap-stream@0.1.1']);
  });

  it('keeps the healthy dependency out of critical/high', () => {
    // ms@2.1.1 is in the inventory; it must either produce no finding or a low/medium one.
    expect(run.inventory.components.map((c) => c.purl)).toContain('pkg:npm/ms@2.1.1');
    const ms = run.result.findings.find((f) => f.purl === 'pkg:npm/ms@2.1.1');
    expect(ms === undefined || ms.level === 'low' || ms.level === 'medium').toBe(true);
  });

  // Regression: the decisive incident must be machine-readable in entityChain, not only reason text.
  it('emits the KB incident hop as a non-empty entity chain with evidence', async () => {
    const es = byName(run.result, 'event-stream');
    expect(es.entityChain).toEqual([
      expect.objectContaining({ from: 'pkg:npm/event-stream', entityId: 'INC-2018-0001', relation: 'incident', method: 'deterministic', reviewed: true }),
    ]);
    expect(es.entityChain[0]!.evidence!.length).toBeGreaterThan(0);
    expect(es.entityChain[0]!.evidence!.every((u) => u.startsWith('https://'))).toBe(true);
    const json = JSON.parse(await readFile(join(out, 'api/blastradius.json'), 'utf8'));
    const jes = json.findings.find((f: { purl: string }) => f.purl === 'pkg:npm/event-stream@3.3.6');
    expect(jes.entityChain[0].entityId).toBe('INC-2018-0001');
    expect(jes.entityChain[0].evidence.length).toBeGreaterThan(0);
  });

  it('scores the pull_request_target workflow on the outbound side', () => {
    const wf = run.result.outbound?.find((o) => o.assetId === 'workflow:.github/workflows/pr-check.yml');
    expect(wf).toBeDefined();
    const factors = wf!.reasons.map((r) => r.factor);
    expect(factors).toEqual(expect.arrayContaining(['pr_head_checkout', 'unpinned_actions', 'write_permissions']));
  });

  it('reports offline gaps as warnings instead of failing', () => {
    expect(run.result.warnings?.some((w) => w.includes('offline'))).toBe(true);
  });

  it('writes JSON, SARIF and HTML reports', async () => {
    expect(run.files.map((f) => f.split('/').pop())).toEqual(['blastradius.json', 'blastradius.sarif', 'blastradius.html']);
    const json = JSON.parse(await readFile(join(out, 'api/blastradius.json'), 'utf8'));
    expect(json.schemaVersion).toBe('1');
    expect(json.summary.byLevel.critical).toBe(2);
    expect(json.summary.byLevel.high).toBe(0);

    const sarif = JSON.parse(await readFile(join(out, 'api/blastradius.sarif'), 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    const results = sarif.runs[0].results as { ruleId: string; level: string; locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[];
    expect(results.some((r) => r.level === 'error')).toBe(true);
    expect(results.flatMap((r) => r.locations.map((l) => l.physicalLocation.artifactLocation.uri))).toContain('package.json');

    const html = await readFile(join(out, 'api/blastradius.html'), 'utf8');
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('flatmap-stream');
    expect(html).not.toMatch(/<script/i);
  });
});

describe('e2e: CLI', () => {
  it('scan writes reports, prints a summary and honours --fail-on', async () => {
    const outDir = join(out, 'cli');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const prev = process.exitCode;
    try {
      await buildProgram({ stdout: (s) => void stdout.push(s), stderr: (s) => void stderr.push(s) })
        .exitOverride()
        .parseAsync(['node', 'blastradius', 'scan', REPO, '--fixtures', FIXTURES, '--no-cache', '--as-of', '2018-11-27', '--out', outDir, '--fail-on', 'critical']);
      expect(process.exitCode).toBe(EXIT_POLICY);
    } finally {
      process.exitCode = prev;
    }
    const text = stdout.join('');
    expect(text).toContain('findings:  critical 2');
    expect(text).toMatch(/\[CRITICAL\] 100\.0 {2}pkg:npm\/(event|flatmap)-stream/);
    expect(text).toContain('malware:');
    for (const f of ['blastradius.json', 'blastradius.sarif', 'blastradius.html']) {
      expect((await readFile(join(outDir, f), 'utf8')).length).toBeGreaterThan(100);
    }
  });
});
