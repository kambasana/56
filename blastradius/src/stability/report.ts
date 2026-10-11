/**
 * ScanResult.stability: one label per npm package in the inventory (docs/WHO-BEHIND-PLAN.md §4).
 * Stability is not risk: nothing here feeds findings or scores.
 */
import { STABILITY_LABELS, unversionedPurl, type Fact, type Inventory, type PurlString, type StabilityLabel, type StabilityReport } from '../core/types.js';
import { labelPackage } from './label.js';
import { productionComponents } from './production.js';
import { collectInputs } from './signals.js';

export const STABILITY_DISCLAIMER = 'Stability describes upkeep from public records (registry, repository, Scorecard). It is not a security verdict and not a finding of wrongdoing.';

const LABEL_ORDER: Record<StabilityLabel, number> = { fragile: 0, watch: 1, unknown: 2, steady: 3 };

export function emptyLabelCounts(): Record<StabilityLabel, number> {
  return Object.fromEntries(STABILITY_LABELS.map((l) => [l, 0])) as Record<StabilityLabel, number>;
}

export interface StabilityReportOptions {
  /**
   * The scan's OSV lookup ran to completion, so a package without a vuln fact has no known advisory.
   * Without it the finished / low-surface test cannot pass (an absent fact proves nothing).
   */
  advisoriesChecked?: boolean;
}

export function buildStabilityReport(inventory: Inventory, facts: readonly Fact[], asOf: Date, opts: StabilityReportOptions = {}): StabilityReport {
  const inputs = collectInputs(facts);
  const prod = productionComponents(inventory);
  const byPkg = new Map<PurlString, { name: string; versions: Set<string>; production: boolean }>();
  for (const c of inventory.components) {
    if (c.ecosystem !== 'npm') continue;
    const key = unversionedPurl(c.purl);
    const p = byPkg.get(key) ?? { name: c.name, versions: new Set<string>(), production: false };
    p.versions.add(c.version);
    p.production ||= prod.has(c.purl);
    byPkg.set(key, p);
  }
  const counts = emptyLabelCounts();
  const packages = [...byPkg]
    .map(([purl, p]) => labelPackage(inputs.get(purl) ?? { package: purl, licenseChanges: [] }, { name: p.name, versions: [...p.versions].sort(), production: p.production, advisoriesChecked: opts.advisoriesChecked === true }, asOf))
    .sort((a, b) => LABEL_ORDER[a.label] - LABEL_ORDER[b.label] || Number(b.production) - Number(a.production) || a.name.localeCompare(b.name));
  for (const e of packages) counts[e.label]++;
  return { asOf: asOf.toISOString(), rulesVersion: 2, packages, counts, disclaimer: STABILITY_DISCLAIMER };
}
