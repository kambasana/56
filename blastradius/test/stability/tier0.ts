/** Load the Tier 0 "Ended" fixture (record-tier0.ts) and label one scan's Ended set through the product code. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { StabilityReport } from '../../src/core/types.js';
import { productionInventory, registryFacts, stabilityOf } from './build.js';
import { STABILITY_DIR, type RecordedPackage } from './fixture.js';

export interface Tier0EndedFixture {
  _note: string;
  recordedAt: string;
  scans: Record<string, { asOf: string; ended: Record<string, string[]> }>;
  packages: Record<string, RecordedPackage>;
  projects: Record<string, Record<string, any>>;
}

export function loadTier0Ended(): Tier0EndedFixture {
  return JSON.parse(gunzipSync(readFileSync(join(STABILITY_DIR, 'tier0-ended.json.gz'))).toString('utf8')) as Tier0EndedFixture;
}

/** Labels of one scan's Ended set as of that scan (registry + the Scorecard the deps.dev enricher would see; no git history). */
export async function tier0Labels(fx: Tier0EndedFixture, repo: string): Promise<StabilityReport> {
  const s = fx.scans[repo]!;
  const asOf = new Date(s.asOf);
  const pkgs = Object.entries(s.ended).filter(([n]) => fx.packages[n]);
  const inv = productionInventory(pkgs.flatMap(([name, vs]) => vs.map((version) => ({ name, version }))));
  const facts = pkgs.flatMap(([name, vs]) => {
    const pkg = { ...fx.packages[name]!, versions: vs };
    return registryFacts(pkg, asOf, pkg.repo ? fx.projects[pkg.repo.url.toLowerCase()] : undefined, fx.recordedAt);
  });
  return (await stabilityOf(inv, facts, () => undefined, asOf)).report;
}

/**
 * The scan's Ended set as an inventory with its real dependency edges between those packages (from
 * the recorded `dependencies` of each version in use): a package no other member depends on is a
 * direct runtime dependency of the asset.
 */
export async function tier0FamilyReport(fx: Tier0EndedFixture, repo: string): Promise<StabilityReport> {
  const { npmPurl } = await import('../../src/core/types.js');
  const s = fx.scans[repo]!;
  const asOf = new Date(s.asOf);
  const pkgs = Object.entries(s.ended).filter(([n]) => fx.packages[n]);
  const asset = { id: 'repo:gate', kind: 'repo' as const, name: repo, environment: 'prod' as const, criticality: 3 as const, sourceFile: 'package.json' };
  const edges: import('../../src/core/types.js').DepEdge[] = [];
  const hasParent = new Set<string>();
  for (const [name, vs] of pkgs) {
    for (const v of vs) {
      const deps = fx.packages[name]!.packument.versions?.[v]?.dependencies ?? {};
      for (const dep of Object.keys(deps)) {
        const target = s.ended[dep];
        if (!target) continue;
        for (const tv of target) edges.push({ from: npmPurl(name, v), to: npmPurl(dep, tv), scope: 'runtime', direct: false });
        hasParent.add(dep);
      }
    }
  }
  for (const [name, vs] of pkgs) if (!hasParent.has(name)) for (const v of vs) edges.push({ from: asset.id, to: npmPurl(name, v), scope: 'runtime', direct: true });
  const inv = { assets: [asset], components: pkgs.flatMap(([name, vs]) => vs.map((version) => ({ purl: npmPurl(name, version), ecosystem: 'npm' as const, name, version }))), edges };
  const facts = pkgs.flatMap(([name, vs]) => {
    const pkg = { ...fx.packages[name]!, versions: vs };
    return registryFacts(pkg, asOf, pkg.repo ? fx.projects[pkg.repo.url.toLowerCase()] : undefined, fx.recordedAt);
  });
  return (await stabilityOf(inv, facts, () => undefined, asOf)).report;
}

export interface Tier0IdentityFixture {
  _note: string;
  recordedAt: string;
  packages: Record<string, RecordedPackage & { project?: Record<string, any>; historyError?: string }>;
}

export function loadTier0Identity(): Tier0IdentityFixture {
  return JSON.parse(readFileSync(join(STABILITY_DIR, 'tier0-identity.json'), 'utf8')) as Tier0IdentityFixture;
}

export async function tier0IdentityHistory(slug: string): Promise<import('../../src/history/record.js').HistoryRecord> {
  const { decodeFixture } = await import('../../src/history/fixture.js');
  return decodeFixture(JSON.parse(readFileSync(join(STABILITY_DIR, 'history', `tier0-${slug}.json`), 'utf8')));
}

/**
 * Label of an identity subject at the real scan's time (2026-10-11), through the npm facts and the
 * real history enricher. `strip` removes the display-name keys and npm-account ids (the history as
 * an earlier version read it) to compare.
 */
export async function tier0IdentityLabel(slug: string, version: string, opts: { strip?: boolean; asOf?: string } = {}): Promise<{ entry: import('../../src/core/types.js').StabilityEntry; facts: import('../../src/core/types.js').Fact[] }> {
  const fx = loadTier0Identity();
  const pkg = fx.packages[slug]!;
  const asOf = new Date(opts.asOf ?? '2026-10-11T12:00:00Z');
  let hist = await tier0IdentityHistory(slug);
  if (opts.strip) {
    const { names: _n, npmPublisherIds: _i, ...rest } = hist;
    hist = rest;
  }
  const { report, facts } = await stabilityOf(productionInventory([{ name: pkg.name, version }]), registryFacts({ ...pkg, versions: [version] }, asOf, pkg.project, fx.recordedAt), () => hist, asOf);
  return { entry: report.packages[0]!, facts };
}
