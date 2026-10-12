/**
 * Tier 0 gates (docs/WHO-BEHIND-PLAN.md, Tier 0) on recorded real data: trimmed manifests of the
 * teardown repositories at their pinned commits (test/tier0/targets.ts) and the OSV, deps.dev and
 * ClearlyDefined responses recorded for them (test/tier0/record.ts). Fully offline.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { scan } from '../../src/pipeline.js';
import { createOsvEnricher } from '../../src/enrich/osv/index.js';
import { createLicenseEnricher } from '../../src/enrich/licenses/index.js';
import { componentScopes, productionSet } from '../../src/core/scope.js';
import { searchExposure } from '../../src/watch/match.js';
import { pathsTo } from '../../src/server/reach.js';
import { toSarif } from '../../src/report/sarif.js';
import { toCycloneDxBom, renderCycloneDx } from '../../src/report/sbom.js';
import { renderHtml } from '../../src/report/html.js';
import { formatSummary } from '../../src/summary.js';
import { buildProgram, EXIT_NOT_ANALYSED } from '../../src/cli.js';
import { npmPurl } from '../../src/core/types.js';
import { TIER0_NOW } from './targets.js';

const FIX = fileURLToPath(new URL('../fixtures/tier0/', import.meta.url));
const caseScan = (id: string, enrichers = () => [createOsvEnricher()]) =>
  scan({ target: path.join(FIX, id, 'repo'), offline: true, fixturesDir: path.join(FIX, id, 'http'), cacheDir: false, now: TIER0_NOW, enrichers });

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('Tier 0 · parse-server (lockfile subset at 23d7bbca, recorded OSV)', async () => {
  const out = await caseScan('parse-server');
  const { result, inventory } = out;
  const scopes = componentScopes(inventory);
  const finding = (purl: string) => result.findings.find((f) => f.purl === purl);
  const stored = [{ projectId: 'p', projectName: 'parse-server', inventory }];

  it('ranks proxy-addr@2.0.7 (GHSA-jqcg-44mw-7w3h, CVSS 9.1, fixed in 2.0.8) first, as critical, and says why', () => {
    const f = finding(npmPurl('proxy-addr', '2.0.7'))!;
    expect(f).toBeDefined();
    expect(result.findings[0]!.purl).toBe(f.purl);
    expect(f.scope).toBe('runtime');
    expect(f.level).toBe('critical');
    expect(f.gate?.rule).toBe('runtime_critical_fix');
    expect(f.gate?.detail).toMatch(/GHSA-jqcg-44mw-7w3h \(CVSS 9\.1\).*2\.0\.8.*above every non-production finding/);
    expect(f.gate?.detail).toMatch(/brought in by express/);
  });

  it('lists every production finding (runtime, peer, optional: Tier 0.5) before any CI or dev-only one', () => {
    const prod = (f: (typeof result.findings)[number]) => f.scope === 'runtime' || f.scope === 'peer' || f.scope === 'optional' || f.gate?.rule === 'install_time';
    const tiers = result.findings.map((f) => (prod(f) ? 0 : 1));
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    const n = result.findings.filter(prod).length;
    expect(n).toBeGreaterThan(0);
    expect(result.findings.slice(0, Math.min(10, n)).every(prod)).toBe(true);
  });

  it('keeps dev-only advisories (decompress CVSS 9.1 in CI tooling) below high and after runtime', () => {
    const f = finding(npmPurl('decompress', '4.2.1'))!;
    expect(f.scope).toBe('dev');
    expect(f.score).toBeLessThan(60);
    expect(f.gate?.rule).toBe('non_runtime_cap');
    expect(result.findings.indexOf(f)).toBeGreaterThan(result.findings.indexOf(finding(npmPurl('proxy-addr', '2.0.7'))!));
    for (const x of result.findings) if (x.scope === 'dev' && x.gate?.rule !== 'install_time') expect(['medium', 'low']).toContain(x.level);
  });

  it('agent-base@7.1.4 has one answer in every view: runtime, production', () => {
    const purl = npmPurl('agent-base', '7.1.4');
    expect(scopes.get(purl)).toBe('runtime'); // findings / SARIF / SBOM read this
    expect(productionSet(inventory).has(purl)).toBe(true); // the helper stability imports
    const hit = searchExposure(stored, { name: 'agent-base', version: '7.1.4' });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.production).toBe(true); // /api/search/exposure
    expect(hit[0]!.scope).toBe('runtime');
    expect(pathsTo(inventory, purl).some((p) => p.production)).toBe(true); // /api/packages/reach
    // The runtime introducer is named first, not the dev tool (@semantic-release/github).
    expect(hit[0]!.reachText).toMatch(/^Brought in by @parse\/push-adapter/);
  });

  it('debug@4.4.3 is "brought in by" its runtime introducer first, not @babel/core', () => {
    const hit = searchExposure(stored, { name: 'debug', version: '4.4.3' });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.production).toBe(true);
    expect(hit[0]!.reachText).toMatch(/^Brought in by (express|@parse\/push-adapter)/);
    expect(hit[0]!.reachText.indexOf('@babel/core')).not.toBe(0);
    const p = pathsTo(inventory, npmPurl('debug', '4.4.3'));
    expect(p[0]!.production).toBe(true);
    expect(p[0]!.scope).toBe('runtime');
  });

  it('fsevents (optional under a dev tool) is never production', () => {
    const purl = npmPurl('fsevents', '2.3.3');
    expect(scopes.get(purl)).toBe('dev');
    expect(productionSet(inventory).has(purl)).toBe(false);
    const hit = searchExposure(stored, { name: 'fsevents' });
    expect(hit[0]!.production).toBe(false);
    expect(hit[0]!.reachText).not.toMatch(/production/);
  });

  it('every finding carries its scope; SARIF has no posture-only results and says the scope', () => {
    expect(result.findings.every((f) => f.scope !== undefined)).toBe(true);
    const run = (toSarif(result, { assets: inventory.assets }) as { runs: { results: { ruleId: string; properties: { scope?: string } }[] }[] }).runs[0]!;
    expect(run.results.some((r) => ['BR005', 'BR006', 'BR007', 'BR008'].includes(r.ruleId))).toBe(false);
    expect(run.results.every((r) => typeof r.properties.scope === 'string')).toBe(true);
  });

  it('the SBOM scope is the same scope', () => {
    const bom = JSON.parse(renderCycloneDx(result, inventory)) as { components: { purl: string; scope?: string; properties?: { name: string; value: string }[] }[] };
    const comp = (purl: string) => bom.components.find((c) => c.purl === purl)!;
    expect(comp(npmPurl('proxy-addr', '2.0.7')).scope).toBe('required');
    expect(comp(npmPurl('decompress', '4.2.1')).scope).toBe('excluded');
    expect(comp(npmPurl('agent-base', '7.1.4')).properties).toContainEqual({ name: 'blastradius:scope', value: 'runtime' });
    expect(toCycloneDxBom(result, inventory).components.size).toBe(inventory.components.length);
  });

  it('the CLI summary is production first and states the reason', () => {
    const text = formatSummary(result, { top: 3 });
    expect(text).toMatch(/top 3, production first/);
    expect(text).toMatch(/\[CRITICAL\].*proxy-addr@2\.0\.7 {2}\[runtime\]/);
    expect(text).toMatch(/rank: Runtime dependency \(brought in by express\) with GHSA-jqcg-44mw-7w3h/);
  });
});

describe('Tier 0 · posture is a tie-breaker (real values from the parse-server scan)', async () => {
  // sprintf-js@1.0.3 was HIGH 65.2 on weak_posture (Scorecard 2.5/10 for alexei/sprintf.js) plus a
  // low advisory, abandoned, no provenance and a single maintainer.
  const { scoreInventory } = await import('../../src/scoring/index.js');
  const { makeFact } = await import('../../src/core/types.js');
  const purl = npmPurl('sprintf-js', '1.0.3');
  const meta = { source: 'test', fetchedAt: TIER0_NOW };
  const inv = {
    assets: [{ id: 'repo:parse-server', kind: 'repo' as const, name: 'parse-server', environment: 'prod' as const, criticality: 3 as const, sourceFile: 'package.json' }],
    components: [{ purl, ecosystem: 'npm' as const, name: 'sprintf-js', version: '1.0.3' }],
    edges: [{ from: 'repo:parse-server', to: purl, scope: 'runtime' as const, direct: true }],
  };
  const facts = [
    makeFact('scorecard', 'pkg:npm/sprintf-js', { score: 2.5, repo: 'github.com/alexei/sprintf.js', checks: [{ name: 'Branch-Protection', score: 0 }] }, meta),
    makeFact('vuln', purl, { id: 'GHSA-xxxx-sprintf', aliases: [], severity: 'medium', cvss: 5.3, fixedVersions: [] }, meta),
    makeFact('provenance', purl, { hasProvenance: false }, meta),
    makeFact('maintainers', 'pkg:npm/sprintf-js', { maintainers: [{ name: 'alexei' }], count: 1 }, meta),
  ];

  it('never raises a finding to high: the level comes from the advisory alone', () => {
    const f = scoreInventory(inv, facts, { now: TIER0_NOW }).findings[0]!;
    expect(f.gate!.signalScore).toBeLessThan(30);
    expect(f.level).toBe('low');
    expect(f.score - f.gate!.signalScore).toBeLessThanOrEqual(0.9);
    expect(f.score).toBeLessThan(30);
  });
});

describe('Tier 0 · jitsi-meet placeholders (react-native-sdk/package.json at 36d4c1c7, no lockfile)', async () => {
  const { result, inventory } = await caseScan('jitsi-meet');

  it('has no component, finding, licence row or SBOM component at 0.0.0', () => {
    expect(inventory.components.filter((c) => c.version === '0.0.0')).toEqual([]);
    expect(result.findings.filter((f) => f.purl.endsWith('@0.0.0'))).toEqual([]);
    expect((result.licenses?.components ?? []).filter((c) => c.version === '0.0.0')).toEqual([]);
    const bom = JSON.parse(renderCycloneDx(result, inventory)) as { components: { version?: string }[] };
    expect(bom.components.filter((c) => c.version === '0.0.0')).toEqual([]);
  });

  it('drops the invented @xmldom/xmldom CVSS 9.8 finding (the locked 0.8.15 has no advisory)', () => {
    expect(result.findings.some((f) => f.purl.startsWith('pkg:npm/%40xmldom/xmldom'))).toBe(false);
    expect(inventory.components.map((c) => c.purl)).toContain(npmPurl('@xmldom/xmldom', '0.8.15'));
  });

  it('turns the manifest into one "unresolved manifest entries" warning and a not-analysed entry', () => {
    const w = (result.warnings ?? []).filter((x) => x.startsWith('react-native-sdk/package.json'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/9 unresolved manifest entries \(9 placeholder 0\.0\.0\)/);
    expect(result.notAnalysed).toContainEqual({ file: 'react-native-sdk/package.json', ecosystem: 'npm', reason: 'no package-lock.json: versions not resolved', packages: 9 });
  });

  it('lists Ruby and Gradle manifests as not analysed, with a package count', () => {
    const na = result.notAnalysed ?? [];
    expect(na.find((n) => n.file === 'Gemfile.lock')).toMatchObject({ ecosystem: 'gem', reason: 'Gemfile.lock is not supported yet' });
    expect(na.find((n) => n.file === 'Gemfile.lock')!.packages).toBeGreaterThan(10);
    expect(na.some((n) => n.file === 'Gemfile')).toBe(false); // counted once, through its lockfile
    expect(na.find((n) => n.file === 'android/app/build.gradle')).toMatchObject({ ecosystem: 'maven' });
  });

  it('every report says so: summary, HTML, SARIF run properties, SBOM metadata', () => {
    expect(formatSummary(result)).toMatch(/!! NOT ANALYSED: .*Gemfile\.lock.*~\d+ packages/);
    expect(renderHtml(result)).toMatch(/id="not-analysed"><strong>NOT ANALYSED: \d+ manifest\(s\), about \d+ package\(s\)/);
    const run = (toSarif(result) as { runs: { properties: { notAnalysedSummary?: string } }[] }).runs[0]!;
    expect(run.properties.notAnalysedSummary).toMatch(/^NOT ANALYSED: /);
    const bom = JSON.parse(renderCycloneDx(result, inventory)) as { metadata: { properties?: { name: string; value: string }[] } };
    expect(bom.metadata.properties?.some((p) => p.name === 'blastradius:notAnalysed:summary')).toBe(true);
  });
});

describe('Tier 0 · flask (uv.lock subset at d086db85, recorded OSV, deps.dev, ClearlyDefined)', async () => {
  const { result, inventory } = await caseScan('flask', () => [createOsvEnricher(), createLicenseEnricher()]);
  const scopes = componentScopes(inventory);

  it('yields real PyPI components with one scope each', () => {
    expect(inventory.components.every((c) => c.ecosystem === 'pypi')).toBe(true);
    expect(scopes.get('pkg:pypi/werkzeug@3.1.8')).toBe('runtime');
    expect(scopes.get('pkg:pypi/jinja2@3.1.6')).toBe('runtime');
    expect(scopes.get('pkg:pypi/asgiref@3.12.1')).toBe('optional');
    expect([...scopes].find(([p]) => p.startsWith('pkg:pypi/ruff@'))?.[1]).toBe('dev');
    expect(inventory.components.find((c) => c.name === 'werkzeug')?.integrity).toMatch(/^sha256-/);
    expect(result.notAnalysed).toBeUndefined(); // pyproject.toml is resolved by uv.lock
  });

  it('finds the PyPI advisory and the licences', () => {
    expect(result.findings.find((f) => f.purl === 'pkg:pypi/werkzeug@3.1.8')?.reasons[0]?.detail).toMatch(/GHSA-g6x2-hccm-hh4m/);
    const lic = (name: string) => result.licenses!.components.find((c) => c.name === name)!;
    expect(lic('werkzeug').expressions).toEqual(['BSD-3-Clause']);
    expect(lic('flask') ?? null).toBeNull(); // the project itself is not a third-party component
  });
});

describe('Tier 0 · superset requirements/base.txt (at 42bbfa49, recorded deps.dev and ClearlyDefined)', async () => {
  const { result, inventory } = await caseScan('superset', () => [createOsvEnricher(), createLicenseEnricher()]);
  const lic = (name: string) => result.licenses!.components.find((c) => c.name === name)!;

  it('reads the pinned requirements and their pip-compile graph', () => {
    expect(inventory.components.map((c) => c.purl)).toEqual(expect.arrayContaining(['pkg:pypi/paramiko@3.5.1', 'pkg:pypi/pyxlsb@1.0.10']));
    expect(inventory.edges).toContainEqual({ from: 'pkg:pypi/paramiko@3.5.1', to: 'pkg:pypi/bcrypt@4.3.0', scope: 'runtime', direct: false });
    expect(componentScopes(inventory).get('pkg:pypi/paramiko@3.5.1')).toBe('runtime');
  });

  it('reports paramiko as LGPL and pyxlsb as LGPLv3+ (weak copyleft)', () => {
    expect(lic('paramiko')).toMatchObject({ expressions: ['LGPL-2.1-or-later'], category: 'weak_copyleft' });
    expect(lic('pyxlsb')).toMatchObject({ expressions: ['LGPL-3.0-or-later'], category: 'weak_copyleft' });
    expect(lic('pyxlsb').sources.find((s) => s.source === 'depsdev')?.raw).toEqual(['LGPLv3+']);
  });

  it('finds a PyPI package with exposure search, by name or purl', () => {
    const stored = [{ projectId: 's', projectName: 'superset', inventory }];
    expect(searchExposure(stored, { name: 'Paramiko' }).map((h) => h.purl)).toEqual(['pkg:pypi/paramiko@3.5.1']);
    expect(searchExposure(stored, { name: 'pkg:pypi/pyxlsb@1.0.10' })[0]).toMatchObject({ ecosystem: 'pypi', production: true, scope: 'runtime' });
  });
});

describe('Tier 0 · --strict', () => {
  const run = async (target: string | Record<string, string>, extra: string[] = []) => {
    let dir: string;
    if (typeof target === 'string') dir = target;
    else {
      dir = mkdtempSync(path.join(os.tmpdir(), 'br-strict-'));
      tmpDirs.push(dir);
      for (const [f, text] of Object.entries(target)) writeFileSync(path.join(dir, f), text);
    }
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'br-strict-out-'));
    tmpDirs.push(outDir);
    const out: string[] = [];
    const err: string[] = [];
    process.exitCode = undefined;
    await buildProgram({ stdout: (s) => void out.push(s), stderr: (s) => void err.push(s) })
      .exitOverride()
      .parseAsync(['node', 'blastradius', 'scan', dir, '--no-cache', '--strict', '--format', 'json', '--out', outDir, ...extra]);
    const code = process.exitCode;
    process.exitCode = undefined;
    return { code, out: out.join(''), err: err.join('') };
  };

  it('exits non-zero when a manifest was not analysed, and says which', async () => {
    const r = await run({ 'go.mod': 'module example.com/x\n\ngo 1.22\n\nrequire (\n\tgolang.org/x/text v0.14.0\n\tgithub.com/pkg/errors v0.9.1\n)\n' }, ['--offline']);
    expect(r.code).toBe(EXIT_NOT_ANALYSED);
    expect(r.out).toMatch(/!! NOT ANALYSED: go\.mod, ~2 packages/);
    expect(r.err).toMatch(/NOT ANALYSED: go\.mod, ~2 packages \(--strict\)/);
  });

  it('exits non-zero when OSV did not answer: a failed security source is not a clean result', async () => {
    const r = await run({ 'requirements.txt': 'six==1.16.0\n' }, ['--offline']);
    expect(r.code).toBe(EXIT_NOT_ANALYSED);
    expect(r.out).toMatch(/!! SECURITY SOURCE INCOMPLETE: osv failed/);
    expect(r.out).toMatch(/sources: {3}osv failed/);
    expect(r.err).toMatch(/SECURITY SOURCE INCOMPLETE: osv failed .*\(--strict\)/);
  });

  it('exits 0 when every manifest was analysed and OSV answered (recorded superset responses)', async () => {
    const r = await run(path.join(FIX, 'superset', 'repo'), ['--fixtures', path.join(FIX, 'superset', 'http')]);
    expect(r.code ?? 0).toBe(0);
    expect(r.out).not.toMatch(/NOT ANALYSED/);
    expect(r.out).toMatch(/sources: {3}osv ok/);
  });
});

describe('Tier 0 · source coverage', async () => {
  const { sourceCoverage } = await import('../../src/pipeline.js');
  it('failed when nothing came back with problems, partial when some did, ok otherwise', () => {
    expect(sourceCoverage('osv', 0, ['osv: querybatch for 1569 package(s): fetch failed'], false, 1569)).toMatchObject({ status: 'failed', security: true });
    expect(sourceCoverage('github', 40, ['github: API returned 403', 'x'], false, 1569)).toMatchObject({ status: 'partial', security: false, reason: 'github: API returned 403 (+1 more)' });
    expect(sourceCoverage('osv', 0, [], false, 10)).toMatchObject({ status: 'ok' });
    expect(sourceCoverage('npm', 0, ['enricher npm failed: boom'], true, 10)).toMatchObject({ status: 'failed' });
  });
});
