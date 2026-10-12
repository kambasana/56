/**
 * Tier 0 trust pass on recorded real data (docs/WHO-BEHIND-PLAN.md "Tier 0"; teardown problems 6
 * and 7). Fixtures, all from parse-server at the pinned commit 23d7bbca (scans/target-commits.txt):
 *
 *  - parse-server-facts.json.gz: the real entity facts of a scan (test/entities/record.ts);
 *  - teardown-parse-server-before.json.gz: the pre-Tier 0 engine's stored output for the same
 *    packages (the teardown scan), to prove the stored-data migration fixes it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeFact, npmPurl, type EntityChainEntry, type Fact, type Finding, type HealthEntry, type ScanResult } from '../../src/core/types.js';
import { buildEntityGraph, isKnownOrg, resolveEntities } from '../../src/entities/index.js';
import { trustPassResult } from '../../src/server/store/trust-pass.js';

const dir = path.join(import.meta.dirname, '..', 'fixtures', 'entities');
const load = <T>(file: string): T => JSON.parse(gunzipSync(readFileSync(path.join(dir, file))).toString('utf8')) as T;

const real = load<{ commit: string; facts: Fact[] }>('parse-server-facts.json.gz');
const before = load<{ commit: string; findings: Finding[]; health: HealthEntry[] }>('teardown-parse-server-before.json.gz');

describe('recorded fixtures', () => {
  it('are from the pinned parse-server commit', () => {
    expect(real.commit).toBe('23d7bbca9a6c9bdebdb12d166544375a83ef47fc');
    expect(before.commit).toBe(real.commit);
    expect(real.facts.length).toBeGreaterThan(1000);
    expect(JSON.stringify(real.facts)).not.toMatch(/"email"/);
  });
});

describe('resolution on real parse-server facts', () => {
  const graph = resolveEntities(real.facts);
  const g = buildEntityGraph(graph);
  const behind = (name: string): EntityChainEntry[] => g.ownershipOf(npmPurl(name));
  const pairs = (name: string) => behind(name).map((e) => `${e.relation} ${e.entityId}`);

  it('never marks a machine-derived link reviewed, and says how each was derived', () => {
    expect(graph.links.length).toBeGreaterThan(1000);
    expect(graph.links.filter((l) => l.reviewed)).toEqual([]);
    expect(new Set(graph.links.map((l) => l.method))).toEqual(new Set(['deterministic', 'probabilistic']));
  });

  it('types kevva, alexei, kornelski and feross as owners of unknown type, never orgs', () => {
    for (const login of ['kevva', 'alexei', 'kornelski', 'feross']) {
      expect(graph.entities.find((e) => e.id === `owner:github/${login}`)?.type).toBe('owner');
      expect(graph.entities.some((e) => e.id === `org:github/${login}`)).toBe(false);
      expect(isKnownOrg(`owner:github/${login}`)).toBe(false);
    }
    expect(pairs('decompress')).toContain('owns owner:github/kevva');
    expect(pairs('sprintf-js')).toContain('owns owner:github/alexei');
    expect(pairs('http-cache-semantics')).toContain('owns owner:github/kornelski');
    expect(pairs('ieee754')).toContain('owns owner:github/feross');
    // The GitHub API answered 403 while recording: no owner type is known, so no org at all.
    expect(graph.entities.filter((e) => e.type === 'org')).toEqual([]);
  });

  it('keeps a real org an org when its type is known (repo_owner from the GitHub API)', () => {
    const typed = makeFact(
      'repo_owner',
      npmPurl('babel-plugin-polyfill-corejs2'),
      { repo: 'github.com/babel/babel-polyfills', owner: 'babel', ownerType: 'Organization', url: 'https://github.com/babel/babel-polyfills' },
      { source: 'github', fetchedAt: '2026-10-12T00:00:00.000Z' },
    );
    const r = resolveEntities([...real.facts, typed], { probabilistic: false });
    expect(r.entities.find((e) => e.id === 'org:github/babel')?.type).toBe('org');
    expect(r.entities.some((e) => e.id === 'owner:github/babel')).toBe(false);
    // Still not kevva.
    expect(r.entities.some((e) => e.id === 'org:github/kevva')).toBe(false);
  });

  it('debug: qix, tootallnate and debug-js with evidence', () => {
    const b = behind('debug');
    expect(pairs('debug')).toEqual(expect.arrayContaining(['maintains account:npm/qix', 'maintains account:npm/tootallnate', 'owns owner:github/debug-js']));
    for (const e of b) expect(e.evidence!.length).toBeGreaterThan(0);
  });

  it('chalk: no Open Collective backers (the casino site is gone), funding pages it names only', () => {
    const backers = real.facts.filter((f) => f.kind === 'funding' && f.value.via === 'opencollective');
    expect(backers.length).toBeGreaterThan(0); // the recording did read backer lists
    // Every funding link is named by the package's own funding field or its repo's FUNDING.yml.
    const named = new Set<string>();
    for (const f of real.facts) {
      if (f.kind !== 'funding' || f.value.via === 'opencollective') continue;
      const pkg = f.subject.replace(/@[^@/]*$/, '');
      for (const src of f.value.sources) if (src.handle) named.add(`${pkg} ${src.handle.toLowerCase()}`);
    }
    for (const l of graph.links.filter((x) => x.relation === 'receives_funding_at')) expect(named.has(`${l.from} ${l.to.slice(l.to.indexOf('/') + 1)}`)).toBe(true);
    const ids = JSON.stringify(graph);
    expect(ids).not.toContain('casinoacademia');
    expect(graph.links.some((l) => l.relation === 'funds')).toBe(false);
    expect(graph.entities.some((e) => e.type === 'funder')).toBe(false);
    expect(pairs('chalk').sort()).toEqual([
      'maintains account:npm/sindresorhus',
      'owns owner:github/chalk',
      'receives_funding_at funding:github/chalk',
      'receives_funding_at funding:github/qix-',
      'receives_funding_at funding:github/sindresorhus',
      'receives_funding_at funding:opencollective/sindresorhus',
    ]);
  });

  it('opencollective/babel is a funding page babel packages name, never a funder of babel', () => {
    const babel = graph.links.filter((l) => l.to === 'funding:opencollective/babel');
    expect(babel.length).toBeGreaterThan(0);
    for (const l of babel) {
      expect(l.relation).toBe('receives_funding_at');
      expect(l.from.startsWith('pkg:npm/')).toBe(true);
      expect(l.evidence[0]).toBe('https://opencollective.com/babel');
    }
    expect(graph.entities.find((e) => e.id === 'funding:opencollective/babel')?.type).toBe('funding');
    expect(graph.entities.some((e) => e.id === 'funder:opencollective/babel')).toBe(false);
  });
});

describe('stored-data migration on the real pre-Tier 0 output', () => {
  const old = { schemaVersion: '1', target: 'parse-server', generatedAt: '2026-10-11T22:10:00.000Z', findings: before.findings, health: before.health } as unknown as ScanResult;
  const next = trustPassResult(old);
  const all = [...next.findings.flatMap((f) => [...(f.behind ?? []), ...f.entityChain]), ...(next.health ?? []).flatMap((h) => h.behind ?? [])];
  const was = [...old.findings.flatMap((f) => [...(f.behind ?? []), ...f.entityChain]), ...(old.health ?? []).flatMap((h) => h.behind ?? [])];

  it('the teardown data had every bug (before)', () => {
    expect(was.filter((e) => e.relation !== 'incident').every((e) => e.reviewed === true)).toBe(true);
    expect(was.some((e) => e.entityId === 'org:github/kevva')).toBe(true);
    expect(was.some((e) => e.entityId === 'funder:opencollective/casinoacademia' && e.from === 'org:github/chalk')).toBe(true);
    expect(was.some((e) => e.entityId === 'funder:opencollective/babel' && e.relation === 'funds')).toBe(true);
  });

  it('after: machine links unreviewed, owners untyped, no funds edges, sponsors as funding pages', () => {
    expect(all.filter((e) => e.relation !== 'incident' && e.reviewed)).toEqual([]);
    expect(all.some((e) => e.entityId.startsWith('org:') || e.from?.startsWith('org:'))).toBe(false);
    expect(all.some((e) => e.relation === 'funds' || e.entityId.startsWith('funder:'))).toBe(false);
    expect(JSON.stringify(next)).not.toContain('casinoacademia');
    for (const login of ['kevva', 'alexei', 'kornelski', 'feross']) expect(all.some((e) => e.entityId === `owner:github/${login}`)).toBe(true);
    const chalk = next.health!.find((h) => h.purl === 'pkg:npm/chalk@2.4.2')!.behind!;
    expect(chalk.map((e) => `${e.relation} ${e.entityId}`)).toEqual(
      expect.arrayContaining(['maintains account:npm/sindresorhus', 'owns owner:github/chalk', 'receives_funding_at funding:github/sindresorhus']),
    );
    const debug = next.health!.find((h) => h.purl === 'pkg:npm/debug@4.4.3')!.behind!;
    expect(debug.map((e) => e.entityId)).toEqual(['account:npm/qix', 'account:npm/tootallnate', 'owner:github/debug-js']);
  });
});

describe('migration 13 data step on a store holding the pre-Tier 0 output', () => {
  it('rewrites the stored result, finding rows and hashes, and fills scan_package_behind', async () => {
    const { openStore, createOrg, createUser, createProject, enqueueScan, markScanRunning, completeScan, getScanResult, reportJsonSha256, MIGRATIONS, SCHEMA_VERSION } = await import('../../src/server/store/index.js');
    const { trustPassMigration } = await import('../../src/server/store/trust-pass.js');
    expect(SCHEMA_VERSION).toBe(13);
    expect(MIGRATIONS.find((m) => m.version === 13)?.run).toBeTypeOf('function');
    const s = openStore();
    const user = createUser(s, { email: 'a@example.test', name: 'A', password: 'correct horse battery staple' });
    const org = createOrg(s, { name: 'Acme' }, user.id);
    const p = createProject(s, org.id, { name: 'parse-server', tier: 'Standard', target: 'https://github.com/parse-community/parse-server' }, user.id);
    const scan = enqueueScan(s, org.id, p.id, { requestedBy: user.id });
    markScanRunning(s, scan.id);
    const old = { schemaVersion: '1', target: 'parse-server', generatedAt: '2026-10-11T22:10:00.000Z', inventory: { assets: 1, components: 9, edges: 0, directComponents: 0, withInstallScripts: 0 }, outbound: [], findings: before.findings, health: before.health } as unknown as ScanResult;
    completeScan(s, scan.id, { result: old });
    // Simulate a database written before migration 13: no behind rows yet.
    s.db.exec('DELETE FROM scan_package_behind');
    trustPassMigration(s.db);
    const stored = getScanResult(s, org.id, scan.id)!;
    expect(JSON.stringify(stored.result)).not.toMatch(/casinoacademia|"funds"|org:github\//);
    expect(stored.sha256).toBe(createHashHex(JSON.stringify(stored.result)));
    expect((s.db.prepare('SELECT report_sha256 FROM scan WHERE id = ?').get(scan.id) as { report_sha256: string }).report_sha256).toBe(reportJsonSha256(stored.result));
    const rows = s.db.prepare('SELECT behind, finding_json FROM finding WHERE scan_id = ?').all(scan.id) as { behind: string | null; finding_json: string }[];
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.finding_json).not.toMatch(/"reviewed":true|org:github\//);
    expect(rows.map((r) => JSON.parse(r.behind ?? 'null')?.entityId).sort()).toEqual(['owner:github/alexei', 'owner:github/kevva', 'owner:github/kornelski']);
    const behindRows = s.db.prepare('SELECT name FROM scan_package_behind WHERE scan_id = ? ORDER BY name').all(scan.id) as { name: string }[];
    expect(behindRows.map((r) => r.name)).toEqual(['babel-plugin-polyfill-corejs2', 'chalk', 'debug', 'express', 'ieee754', 'strip-ansi']);
  });
});

function createHashHex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
