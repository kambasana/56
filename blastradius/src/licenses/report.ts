/**
 * Licence report for a scan (ScanResult.licenses): one row per component with every source's
 * statement, the chosen value and whether sources disagree, plus the licence changes of the
 * packages in use. Policy results are added when read (withPolicy), so a policy edit applies to
 * stored scans at once.
 */
import {
  LICENSE_CATEGORIES,
  unversionedPurl,
  type ComponentLicense,
  type Fact,
  type Inventory,
  type LicenseCategory,
  type LicenseChangeEntry,
  type LicenseReport,
  type LicenseSourceValue,
} from '../core/types.js';
import { CLASSIFICATION_SOURCES, NOT_LEGAL_ADVICE } from './classify.js';
import { changeRelation, isCategoryChange } from './history.js';
import { evaluatePolicy, type LicensePolicy, type PolicyDecision } from './policy.js';

/**
 * Preference when sources disagree: deps.dev (primary), ClearlyDefined, the package registry's
 * own metadata (only asked where deps.dev has no data), then what the repo declares.
 */
export const SOURCE_ORDER = ['depsdev', 'clearlydefined', 'registry', 'lockfile', 'sbom'] as const;

export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  depsdev: 'deps.dev',
  clearlydefined: 'ClearlyDefined',
  registry: 'Package registry',
  lockfile: 'package-lock.json',
  sbom: 'SBOM',
  none: 'No source',
};

function rank(source: string): number {
  const i = (SOURCE_ORDER as readonly string[]).indexOf(source);
  return i < 0 ? SOURCE_ORDER.length : i;
}

function isKnown(v: Pick<LicenseSourceValue, 'expressions' | 'status'>): boolean {
  return v.status === 'unlicensed' || (v.expressions.length > 0 && (v.status === 'spdx' || v.status === 'corrected'));
}

export function emptyCategoryCounts(): Record<LicenseCategory, number> {
  return Object.fromEntries(LICENSE_CATEGORIES.map((c) => [c, 0])) as Record<LicenseCategory, number>;
}

export function buildLicenseReport(inventory: Inventory, facts: readonly Fact[]): LicenseReport {
  const byPurl = new Map<string, LicenseSourceValue[]>();
  const changesByPkg = new Map<string, Extract<Fact, { kind: 'license_change' }>[]>();
  for (const f of facts) {
    if (f.kind === 'license') {
      const v: LicenseSourceValue = { source: f.source, raw: f.value.raw, expressions: f.value.expressions, status: f.value.status, category: f.value.category };
      if (f.evidence?.length) v.evidence = f.evidence;
      if (f.value.corrected?.length) v.corrected = f.value.corrected;
      if (f.value.score !== undefined) v.score = f.value.score;
      if (f.value.basis) v.basis = f.value.basis;
      const list = byPurl.get(f.subject) ?? [];
      if (!list.some((x) => x.source === v.source)) list.push(v);
      byPurl.set(f.subject, list);
    } else if (f.kind === 'license_change') {
      const list = changesByPkg.get(f.subject) ?? [];
      list.push(f);
      changesByPkg.set(f.subject, list);
    }
  }

  const counts = emptyCategoryCounts();
  const components: ComponentLicense[] = [];
  const inUse = new Map<string, { name: string; versions: Set<string> }>();
  for (const c of [...inventory.components].sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0))) {
    const sources = (byPurl.get(c.purl) ?? []).sort((a, b) => rank(a.source) - rank(b.source));
    const chosen = sources.find(isKnown) ?? sources[0];
    const known = sources.filter(isKnown);
    const keys = new Set(known.map((s) => (s.status === 'unlicensed' ? 'UNLICENSED' : s.expressions.join('\u0000'))));
    const row: ComponentLicense = {
      purl: c.purl,
      name: c.name,
      version: c.version,
      ecosystem: c.ecosystem,
      expressions: chosen?.expressions ?? [],
      status: chosen?.status ?? 'unknown',
      category: chosen && isKnown(chosen) ? chosen.category : 'unknown',
      source: chosen?.source ?? 'none',
      sources,
      disagreement: keys.size > 1,
    };
    counts[row.category]++;
    components.push(row);
    let pkg: string;
    try {
      pkg = unversionedPurl(c.purl);
    } catch {
      continue;
    }
    const u = inUse.get(pkg) ?? { name: c.name, versions: new Set<string>() };
    u.versions.add(c.version);
    inUse.set(pkg, u);
  }

  const changes: LicenseChangeEntry[] = [];
  for (const [pkg, list] of changesByPkg) {
    const u = inUse.get(pkg);
    if (!u) continue;
    const versions = [...u.versions].sort();
    for (const f of list) {
      const rel = new Set(versions.map((v) => changeRelation(f.value, v)));
      const relation: LicenseChangeEntry['relation'] = rel.size === 1 ? [...rel][0]! : 'mixed';
      const e: LicenseChangeEntry = { ...f.value, purl: pkg, name: u.name, inUse: versions, relation, categoryChange: isCategoryChange(f.value), source: f.source };
      if (f.evidence?.length) e.evidence = f.evidence;
      changes.push(e);
    }
  }
  changes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.date ?? '') < (b.date ?? '') ? -1 : 1));

  return {
    components,
    changes,
    counts,
    classification: CLASSIFICATION_SOURCES.map((s) => ({ ...s })),
    note: NOT_LEGAL_ADVICE,
  };
}

export interface PolicyRow {
  decision: PolicyDecision;
  rule: string;
}

/** Policy result for each component row (same order as report.components). */
export function applyPolicy(report: Pick<LicenseReport, 'components'>, policy: LicensePolicy): PolicyRow[] {
  return report.components.map((c) => evaluatePolicy(c.expressions, c.status, policy));
}

/** Counts by decision for a list of policy rows. */
export function decisionCounts(rows: readonly PolicyRow[]): Record<PolicyDecision, number> {
  const out: Record<PolicyDecision, number> = { allow: 0, review: 0, deny: 0 };
  for (const r of rows) out[r.decision]++;
  return out;
}
