/**
 * Turn recorded stability fixtures into the facts a scan would have, through the product code:
 * npm facts from the trimmed packument (packumentFacts after slimPackument), Scorecard facts from the
 * recorded deps.dev / Scorecard response, and history facts from the real history enricher replaying
 * the recorded history. Then buildStabilityReport, as the pipeline does.
 */
import { HttpClient } from '../../src/core/http.js';
import { makeFact, npmPurl, type Fact, type Inventory, type StabilityReport } from '../../src/core/types.js';
import { scorecardFromApi, scorecardFromDepsDev } from '../../src/enrich/depsdev/index.js';
import { createHistoryEnricher } from '../../src/enrich/history/index.js';
import { needsTarballSize, packageSize, packumentFacts } from '../../src/enrich/npm/packument.js';
import { npmPackagePage } from '../../src/enrich/npm/registry.js';
import { osvRecordsToFacts } from '../../src/enrich/osv/index.js';
import { factsKnownAt } from '../../src/pipeline.js';
import { STABILITY_RULES } from '../../src/stability/rules.js';
import { slimPackument } from '../../src/enrich/npm/registry.js';
import type { HistoryRecord } from '../../src/history/record.js';
import { buildStabilityReport } from '../../src/stability/report.js';
import type { RecordedPackage } from './fixture.js';

const offlineHttp = () => new HttpClient({ offline: true, cacheDir: false, transport: () => Promise.reject(new Error('no network in tests')) });

/** npm + Scorecard facts for one recorded package. Scorecard is today's: only used for scans at the recording time. */
export function registryFacts(pkg: RecordedPackage, asOf: Date, project: Record<string, any> | undefined, recordedAt: string): Fact[] {
  const p = slimPackument(pkg.packument);
  const facts: Fact[] = [];
  for (const v of pkg.versions) {
    for (const f of packumentFacts(p, pkg.name, v, { now: asOf, fetchedAt: recordedAt })) {
      if (f.subject === npmPurl(pkg.name) && facts.some((g) => g.kind === f.kind && g.subject === f.subject)) continue;
      facts.push(f);
    }
    // Size from the recorded tarball when the registry has none, as the npm enricher does (index.ts).
    const t = pkg.tarballs?.[v];
    if (t && !facts.some((f) => f.kind === 'package_size' && f.subject === npmPurl(pkg.name, v)) && needsTarballSize(p, asOf, STABILITY_RULES.inactiveMonths)) {
      const size = packageSize(p, v, t);
      if (size) facts.push(makeFact('package_size', npmPurl(pkg.name, v), size, { source: 'npm', fetchedAt: recordedAt, evidence: [npmPackagePage(pkg.name, v)] }));
    }
    // OSV advisories for the version in use, as the OSV enricher turns them into facts; the pipeline
    // drops those published after the scan time.
    const osv = pkg.osv?.[v];
    if (osv) facts.push(...factsKnownAt(osvRecordsToFacts({ purl: npmPurl(pkg.name, v), name: pkg.name }, osv, asOf), asOf));
  }
  const live = Math.abs(Date.parse(recordedAt) - asOf.getTime()) < 7 * 86_400_000;
  if (project && live && pkg.repo) {
    const id = pkg.repo.url.replace(/^https:\/\//, '').toLowerCase();
    const value = project.source === 'scorecard' ? scorecardFromApi(project as any, id) : scorecardFromDepsDev(project as any, id);
    if (value) facts.push(makeFact('scorecard', npmPurl(pkg.name), value, { source: project.source === 'scorecard' ? 'scorecard' : 'depsdev', fetchedAt: recordedAt, evidence: [`https://scorecard.dev/viewer/?uri=${id}`] }));
  }
  return facts;
}

/** History facts through the real enricher, replaying `histories` (repository key → record). */
export async function historyFacts(inventory: Inventory, facts: Fact[], histories: (url: string) => HistoryRecord | undefined, asOf: Date): Promise<Fact[]> {
  const warnings: string[] = [];
  const enricher = createHistoryEnricher({ repoFacts: () => facts, recorded: histories, salt: 'unused-recorded-histories-are-hashed' });
  return enricher.enrich(inventory, { http: offlineHttp(), now: asOf, offline: true, warn: (m) => warnings.push(m) });
}

/** A one-asset inventory where every package is a direct runtime (production) dependency. */
export function productionInventory(pkgs: readonly { name: string; version: string }[]): Inventory {
  const asset = { id: 'repo:gate', kind: 'repo' as const, name: 'gate', environment: 'prod' as const, criticality: 3 as const, sourceFile: 'package.json' };
  return {
    assets: [asset],
    components: pkgs.map((p) => ({ purl: npmPurl(p.name, p.version), ecosystem: 'npm' as const, name: p.name, version: p.version })),
    edges: pkgs.map((p) => ({ from: asset.id, to: npmPurl(p.name, p.version), scope: 'runtime' as const, direct: true })),
  };
}

/** Advisories were recorded (OSV) for every package in the fixture: the scan's OSV lookup "ran". */
export function advisoriesRecorded(pkgs: readonly RecordedPackage[]): boolean {
  return pkgs.every((p) => p.versions.every((v) => p.osv?.[v] !== undefined));
}

export async function stabilityOf(inventory: Inventory, registry: Fact[], histories: (url: string) => HistoryRecord | undefined, asOf: Date, advisoriesChecked = false): Promise<{ report: StabilityReport; facts: Fact[] }> {
  const facts = [...registry];
  facts.push(...(await historyFacts(inventory, facts, histories, asOf)));
  return { report: buildStabilityReport(inventory, facts, asOf, { advisoriesChecked }), facts };
}

/** Labels of the control repositories (test/replay/data/org) on the recorded control fixture. */
export async function controlLabels(control: import('./fixture.js').ControlFixture): Promise<{ repo: string; report: StabilityReport }[]> {
  const { join } = await import('node:path');
  const { scan } = await import('../../src/pipeline.js');
  const { decodeFixture } = await import('../../src/history/fixture.js');
  const { controlRepos, ORG_DIR } = await import('./subjects.js');
  const asOf = new Date(control.recordedAt);
  const decoded = new Map<string, HistoryRecord>();
  const histories = (url: string) => {
    const fx = control.histories[url];
    if (!fx) return undefined;
    let r = decoded.get(url);
    if (!r) decoded.set(url, (r = decodeFixture(fx)));
    return r;
  };
  const out: { repo: string; report: StabilityReport }[] = [];
  for (const d of controlRepos()) {
    const res = await scan({ target: join(ORG_DIR, d), formats: [], offline: true, cacheDir: false, enrichers: () => [] });
    // The population is the production dependencies that were recorded (versions as locked).
    const { productionComponents } = await import('../../src/stability/production.js');
    const prod = productionComponents(res.inventory);
    const components = res.inventory.components.filter((c) => c.ecosystem === 'npm' && prod.has(c.purl) && control.packages[c.name]?.versions.includes(c.version));
    const recorded: Inventory = { ...res.inventory, components };
    const versions = new Map<string, Set<string>>();
    for (const c of components) versions.set(c.name, (versions.get(c.name) ?? new Set()).add(c.version));
    const registry: Fact[] = [];
    for (const [name, vs] of versions) {
      const pkg = control.packages[name]!;
      const key = pkg.repo ? pkg.repo.url.replace(/\.git$/, '').replace(/\/+$/, '') : undefined;
      const projectKey = key?.startsWith('https://github.com/') ? key.toLowerCase() : key;
      registry.push(...registryFacts({ ...pkg, versions: [...vs].sort() }, asOf, projectKey ? control.projects[projectKey] : undefined, control.recordedAt));
    }
    const { report } = await stabilityOf(recorded, registry, histories, asOf, advisoriesRecorded([...versions.keys()].map((n) => control.packages[n]!)));
    out.push({ repo: d.replace('__', '/'), report });
  }
  return out;
}
