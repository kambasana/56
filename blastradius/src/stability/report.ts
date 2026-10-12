/**
 * ScanResult.stability: one label per npm package in the inventory (docs/WHO-BEHIND-PLAN.md §4).
 * Stability is not risk: nothing here feeds findings or scores.
 *
 * Tier 0 additions: decision rows (a family such as ldapjs + 9 @ldapjs/* packages becomes one row
 * naming the direct dependency to change) and the coverage line ("Upkeep assessed for N of M: …").
 */
import { STABILITY_LABELS, unversionedPurl, type Fact, type Inventory, type PurlString, type StabilityCoverage, type StabilityDecision, type StabilityEntry, type StabilityLabel, type StabilityReport } from '../core/types.js';
import { labelPackage } from './label.js';
import { productionComponents } from './production.js';
import { packagePriorities } from './priority.js';
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
  /** Git history selection of the scan (history enricher), for the coverage line. */
  historySelection?: { declared: number; read: string[]; capped: string[]; failed: string[]; maxRepos: number };
  historyStatus?: StabilityReport['historyStatus'];
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
  const report: StabilityReport = { asOf: asOf.toISOString(), rulesVersion: 3, packages, counts, disclaimer: STABILITY_DISCLAIMER };
  report.decisions = stabilityDecisions(inventory, packages);
  report.coverage = stabilityCoverage(inventory, packages, opts.historySelection);
  if (opts.historyStatus) report.historyStatus = opts.historyStatus;
  return report;
}

/** Labels that call for a decision: Fragile in production, or moved and still released. */
function needsDecision(e: StabilityEntry): boolean {
  return e.production && (e.label === 'fragile' || e.rules.some((r) => r.rule === 'watch_moved'));
}

/** Family of a package: its repository owner (ldapjs/node-ldapjs and ldapjs/asn1 → "ldapjs"), else its npm scope, else its name. */
function familyOf(e: StabilityEntry): string {
  const repo = e.repo?.current.replace(/^https?:\/\//, '').toLowerCase().split('/');
  if (repo && repo.length >= 3) return `${repo[0]}/${repo[1]}`;
  const scope = /^@([^/]+)\//.exec(e.name);
  return scope ? `@${scope[1]}` : e.name;
}

/**
 * Decision rows: production packages that need a decision, grouped by family and by the direct
 * dependencies that bring them in. Each row names one direct dependency to change.
 */
export function stabilityDecisions(inv: Inventory, entries: readonly StabilityEntry[]): StabilityDecision[] {
  const wanted = entries.filter(needsDecision);
  if (wanted.length === 0) return [];
  const assets = new Set(inv.assets.map((a) => a.id));
  const PROD = new Set(['runtime', 'optional', 'peer']);
  const children = new Map<string, string[]>();
  const directOf = new Map<string, string>();
  for (const e of inv.edges) {
    if (!PROD.has(e.scope)) continue;
    if (assets.has(e.from)) {
      directOf.set(e.to, inv.components.find((c) => c.purl === e.to)?.name ?? e.to);
      continue;
    }
    const l = children.get(e.from) ?? [];
    l.push(e.to);
    children.set(e.from, l);
  }
  // Which direct dependencies (names) reach each package (unversioned).
  const reachedBy = new Map<PurlString, Set<string>>();
  for (const [purl, name] of directOf) {
    const seen = new Set<string>([purl]);
    const stack = [purl];
    while (stack.length) {
      const n = stack.pop()!;
      const key = unversionedPurl(n as PurlString);
      let s = reachedBy.get(key);
      if (!s) reachedBy.set(key, (s = new Set()));
      s.add(name);
      for (const c of children.get(n) ?? []) if (!seen.has(c)) (seen.add(c), stack.push(c));
    }
  }
  const groups = new Map<string, { direct: string; others: string[]; members: StabilityEntry[] }>();
  for (const e of wanted) {
    const via = [...(reachedBy.get(e.package) ?? [])].sort();
    // The package itself when it is a direct dependency; else the first direct dependency by name.
    const direct = via.includes(e.name) ? e.name : (via[0] ?? e.name);
    const kind = e.label === 'fragile' ? 'fragile' : 'moved';
    const key = `${direct}\u0000${familyOf(e)}\u0000${kind}`;
    const g = groups.get(key) ?? { direct, others: via.filter((v) => v !== direct), members: [] };
    g.members.push(e);
    groups.set(key, g);
  }
  const rows: StabilityDecision[] = [];
  for (const g of groups.values()) {
    const members = [...g.members].sort((a, b) => Number(b.name === g.direct) - Number(a.name === g.direct) || a.name.localeCompare(b.name));
    const label: StabilityLabel = members.some((m) => m.label === 'fragile') ? 'fragile' : 'watch';
    const rules = [...new Set(members.flatMap((m) => m.rules.map((r) => r.rule)))].sort();
    const self = members[0]!.name === g.direct;
    const names = members.map((m) => m.name);
    const list = names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    const why = members[0]!.summary.replace(/\.$/, '');
    const also = g.others.length ? ` (also reached through ${g.others.slice(0, 3).join(', ')}${g.others.length > 3 ? ', …' : ''})` : '';
    let action: string;
    if (label === 'watch') {
      const moved = members.map((m) => m.action).filter(Boolean);
      action = self && members.length === 1 ? `${moved[0]}.` : `Upgrade ${g.direct} (direct dependency${also}): it brings in ${list}, which moved to another repository and are still released${moved[0] ? ` (${moved[0]})` : ''}.`;
    } else if (self) {
      action = members.length === 1 ? `Replace or upgrade ${g.direct} (direct dependency): ${why.charAt(0).toLowerCase()}${why.slice(1)}.` : `Replace or upgrade ${g.direct} (direct dependency): it and ${members.length - 1} package${members.length === 2 ? '' : 's'} of the same family it brings in are Fragile (${why.charAt(0).toLowerCase()}${why.slice(1)}).`;
    } else {
      action = `Upgrade or replace ${g.direct} (direct dependency${also}): it brings in ${list}, labelled Fragile (${why.charAt(0).toLowerCase()}${why.slice(1)}).`;
    }
    rows.push({ direct: g.direct, label, packages: names, rules, action });
  }
  return rows.sort((a, b) => LABEL_ORDER[a.label] - LABEL_ORDER[b.label] || b.packages.length - a.packages.length || a.direct.localeCompare(b.direct));
}

const fmt = (n: number) => n.toLocaleString('en-US');

function skipReason(e: StabilityEntry): string {
  if (!e.repo) return 'no source repository declared';
  if (e.basis === 'git') return 'fewer than 5 commits in the last active 24 months';
  if (e.basis === 'none') return 'no npm release record';
  return 'git history not read, last release 12–18 months ago and no Scorecard result';
}

export function stabilityCoverage(inv: Inventory, entries: readonly StabilityEntry[], sel?: StabilityReportOptions['historySelection']): StabilityCoverage {
  const prio = packagePriorities(inv);
  const known = (e: StabilityEntry) => e.label !== 'unknown';
  const direct = entries.filter((e) => prio.get(e.package)?.direct);
  const transitive = entries.filter((e) => e.production && !prio.get(e.package)?.direct);
  const prod = entries.filter((e) => e.production);
  const byBasis = { git: 0, 'scorecard+npm': 0, npm: 0 };
  for (const e of entries) if (known(e) && e.basis && e.basis !== 'none') byBasis[e.basis]++;
  const reasons = new Map<string, number>();
  for (const e of entries) if (!known(e)) reasons.set(skipReason(e), (reasons.get(skipReason(e)) ?? 0) + 1);
  const skipped = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const assessed = entries.filter(known).length;
  const d = { total: direct.length, assessed: direct.filter(known).length };
  const r = { total: transitive.length, assessed: transitive.filter(known).length };
  const part = (x: { total: number; assessed: number }, what: string) => (x.assessed === x.total ? `all ${fmt(x.total)} ${what}` : `${fmt(x.assessed)} of ${fmt(x.total)} ${what}`);
  const sources = [byBasis.git ? `git history ${fmt(byBasis.git)}` : '', byBasis['scorecard+npm'] + byBasis.npm ? `Scorecard / npm fallback ${fmt(byBasis['scorecard+npm'] + byBasis.npm)}` : ''].filter(Boolean).join(', ');
  let line = `Upkeep assessed for ${fmt(assessed)} of ${fmt(entries.length)}${sources ? ` (${sources})` : ''}: ${part(d, 'direct')}, ${part(r, 'runtime transitive')}; skipped: ${skipped.length ? skipped.map((s) => `${fmt(s.count)} ${s.reason}`).join('; ') : 'none'}.`;
  if (sel) line += ` Git history read for ${fmt(sel.read.length)} of ${fmt(sel.declared)} repositories${sel.capped.length ? ` (${fmt(sel.capped.length)} over the cap of ${fmt(sel.maxRepos)}, picked by priority)` : ''}${sel.failed.length ? `; ${fmt(sel.failed.length)} could not be read` : ''}.`;
  const out: StabilityCoverage = {
    packages: entries.length,
    assessed,
    byBasis,
    direct: d,
    runtimeTransitive: r,
    production: { total: prod.length, unknown: prod.filter((e) => !known(e)).length },
    skipped,
    line,
  };
  if (sel) out.history = { declared: sel.declared, read: sel.read.length, capped: sel.capped.length, failed: sel.failed.length, maxRepos: sel.maxRepos };
  return out;
}
