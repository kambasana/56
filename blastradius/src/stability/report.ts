/**
 * ScanResult.stability: one label per npm and PyPI package in the inventory (docs/WHO-BEHIND-PLAN.md
 * §4; PyPI since Tier 0.5), and an Unknown entry, with the reason, for every production package of an
 * ecosystem without an upkeep source (Docker images, …), so no production package goes uncounted.
 * Stability is not risk: nothing here feeds findings or scores.
 *
 * Tier 0 additions: decision rows (a family such as ldapjs + 9 @ldapjs/* packages becomes one row
 * naming the direct dependency to change) and the coverage line ("Upkeep assessed for N of M: …").
 */
import { STABILITY_LABELS, unversionedPurl, type Fact, type HttpCacheUsage, type IdentityMergeTotals, type Inventory, type PurlString, type StabilityCoverage, type StabilityDecision, type StabilityEntry, type StabilityLabel, type StabilityReport } from '../core/types.js';
import { labelPackage } from './label.js';
import { productionComponents } from './production.js';
import { packagePriorities } from './priority.js';
import { collectInputs } from './signals.js';

export const STABILITY_DISCLAIMER = 'Stability describes upkeep from public records (registry, repository, Scorecard). It is not a security verdict and not a finding of wrongdoing.';

const LABEL_ORDER: Record<StabilityLabel, number> = { fragile: 0, watch: 1, unknown: 2, steady: 3 };

export function emptyLabelCounts(): Record<StabilityLabel, number> {
  return Object.fromEntries(STABILITY_LABELS.map((l) => [l, 0])) as Record<StabilityLabel, number>;
}

/** Ecosystems with an upkeep source (registry release record, Scorecard, git history). */
export const LABELLED: ReadonlySet<string> = new Set(['npm', 'pypi']);

const ECOSYSTEM_NAME: Record<string, string> = { npm: 'npm', pypi: 'PyPI', docker: 'Docker', githubactions: 'GitHub Actions', maven: 'Maven', golang: 'Go', cargo: 'Cargo', nuget: 'NuGet', gem: 'RubyGems', composer: 'Composer' };
export const ecosystemName = (e: string) => ECOSYSTEM_NAME[e] ?? e;

/** Unknown entry for a production package of an ecosystem without an upkeep source (Tier 0.5). */
function unassessedEntry(purl: PurlString, name: string, ecosystem: string, versions: string[], production: boolean): StabilityEntry {
  return {
    package: purl,
    name,
    versions,
    production,
    label: 'unknown',
    summary: `Not enough data: upkeep is not assessed for ${ecosystemName(ecosystem)} packages (no registry release record or repository source).`,
    rules: [],
    context: [],
    missing: [`Upkeep is not assessed for ${ecosystemName(ecosystem)} packages in this version: no release record or source repository is read for them.`],
    s3: { state: 'unknown', confidence: 'low' },
    s5a: [],
    funding: 'not_assessed',
    basis: 'none',
  };
}

export interface StabilityReportOptions {
  /**
   * The scan's OSV lookup ran to completion, so a package without a vuln fact has no known advisory.
   * Without it the finished / low-surface test cannot pass (an absent fact proves nothing).
   */
  advisoriesChecked?: boolean;
  /** Git history selection of the scan (history enricher), for the coverage line. */
  historySelection?: { declared: number; read: string[]; capped: string[]; failed: string[]; maxRepos: number; tooLarge?: string[]; budget?: { maxMb: number; perCloneMb: number; peakMb: number; evicted: number; shallowMonths: number }; identity?: IdentityMergeTotals };
  /** Tier 0.6: the HTTP cache budget and use (said in the coverage line). */
  httpCache?: HttpCacheUsage;
  historyStatus?: StabilityReport['historyStatus'];
}

export function buildStabilityReport(inventory: Inventory, facts: readonly Fact[], asOf: Date, opts: StabilityReportOptions = {}): StabilityReport {
  const inputs = collectInputs(facts);
  const prod = productionComponents(inventory);
  const byPkg = new Map<PurlString, { name: string; ecosystem: string; versions: Set<string>; production: boolean }>();
  for (const c of inventory.components) {
    const key = unversionedPurl(c.purl);
    const p = byPkg.get(key) ?? { name: c.name, ecosystem: c.ecosystem, versions: new Set<string>(), production: false };
    p.versions.add(c.version);
    p.production ||= prod.has(c.purl);
    byPkg.set(key, p);
  }
  const counts = emptyLabelCounts();
  const packages = [...byPkg]
    // Labelled ecosystems: every package. Others: production packages only, as Unknown with the reason.
    .filter(([, p]) => LABELLED.has(p.ecosystem) || p.production)
    .map(([purl, p]) =>
      LABELLED.has(p.ecosystem)
        ? labelPackage(inputs.get(purl) ?? { package: purl, licenseChanges: [] }, { name: p.name, versions: [...p.versions].sort(), production: p.production, advisoriesChecked: opts.advisoriesChecked === true }, asOf)
        : unassessedEntry(purl, p.name, p.ecosystem, [...p.versions].sort(), p.production),
    )
    .sort((a, b) => LABEL_ORDER[a.label] - LABEL_ORDER[b.label] || Number(b.production) - Number(a.production) || a.name.localeCompare(b.name));
  for (const e of packages) counts[e.label]++;
  const report: StabilityReport = { asOf: asOf.toISOString(), rulesVersion: 3, packages, counts, disclaimer: STABILITY_DISCLAIMER };
  report.decisions = stabilityDecisions(inventory, packages);
  report.coverage = stabilityCoverage(inventory, packages, opts.historySelection, opts.httpCache);
  // Packages of ecosystems without an upkeep source outside production (CI actions, dev images).
  const notAssessed: Record<string, number> = {};
  for (const p of byPkg.values()) if (!LABELLED.has(p.ecosystem) && !p.production) notAssessed[p.ecosystem] = (notAssessed[p.ecosystem] ?? 0) + 1;
  if (Object.keys(notAssessed).length) {
    report.coverage.notAssessed = notAssessed;
    report.coverage.line += ` Not assessed (no upkeep source, outside production): ${Object.entries(notAssessed)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([e, n]) => `${fmt(n)} ${ecosystemName(e)}`)
      .join(', ')}.`;
  }
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

function ecosystemOf(e: StabilityEntry): string {
  return /^pkg:([^/]+)\//.exec(e.package)?.[1] ?? 'npm';
}

function skipReason(e: StabilityEntry): string {
  const eco = ecosystemOf(e);
  if (!LABELLED.has(eco)) return `${ecosystemName(eco)}: upkeep not assessed for this ecosystem`;
  const pre = eco === 'npm' ? '' : `${ecosystemName(eco)}: `;
  if (e.basis === 'git') return `${pre}fewer than 5 commits in the last active 24 months`;
  if (!e.repo && e.basis === 'none') return `${pre}no ${ecosystemName(eco)} release record and no source repository declared`;
  if (!e.repo) return `${pre}no source repository declared`;
  if (e.basis === 'none') return `${pre}no ${ecosystemName(eco)} release record`;
  return `${pre}git history not read, last release 12–18 months ago and no Scorecard result`;
}

/** Tier 0.6: identity merges per evidence type, for the coverage line. */
export function identityLine(t: IdentityMergeTotals): string {
  const strong = t.npmPublisher + t.githubLogin + t.signingKey;
  const weak = t.displayName + t.loginName;
  return (
    `Identity merges: strong ${fmt(strong)} (npm publisher ${fmt(t.npmPublisher)}, GitHub login ${fmt(t.githubLogin)}, verified signature ${fmt(t.signingKey)}; .mailmap applied in ${fmt(t.mailmapRepos)} of ${fmt(t.repos)} repositories); ` +
    `name-only ${fmt(weak)} (display name ${fmt(t.displayName)}, name = login ${fmt(t.loginName)}), used for contributor counts only; ` +
    `${fmt(t.keptDespiteNameMatch)} continuity signal${t.keptDespiteNameMatch === 1 ? '' : 's'} kept despite a name match (annotated).`
  );
}

export function stabilityCoverage(inv: Inventory, entries: readonly StabilityEntry[], sel?: StabilityReportOptions['historySelection'], http?: HttpCacheUsage): StabilityCoverage {
  const prio = packagePriorities(inv);
  const known = (e: StabilityEntry) => e.label !== 'unknown';
  const direct = entries.filter((e) => prio.get(e.package)?.direct);
  const transitive = entries.filter((e) => e.production && !prio.get(e.package)?.direct);
  const prod = entries.filter((e) => e.production);
  const byBasis: StabilityCoverage['byBasis'] = { git: 0, 'scorecard+npm': 0, npm: 0 };
  for (const e of entries) if (known(e) && e.basis && e.basis !== 'none') byBasis[e.basis] = (byBasis[e.basis] ?? 0) + 1;
  const byEcosystem: NonNullable<StabilityCoverage['byEcosystem']> = {};
  for (const e of entries) {
    const b = (byEcosystem[ecosystemOf(e)] ??= { packages: 0, assessed: 0, production: 0, productionUnknown: 0 });
    b.packages++;
    if (known(e)) b.assessed++;
    if (e.production) {
      b.production++;
      if (!known(e)) b.productionUnknown++;
    }
  }
  const reasons = new Map<string, number>();
  for (const e of entries) if (!known(e)) reasons.set(skipReason(e), (reasons.get(skipReason(e)) ?? 0) + 1);
  const skipped = [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const assessed = entries.filter(known).length;
  const d = { total: direct.length, assessed: direct.filter(known).length };
  const r = { total: transitive.length, assessed: transitive.filter(known).length };
  const part = (x: { total: number; assessed: number }, what: string) => (x.assessed === x.total ? `all ${fmt(x.total)} ${what}` : `${fmt(x.assessed)} of ${fmt(x.total)} ${what}`);
  const fallbackN = byBasis['scorecard+npm'] + byBasis.npm + (byBasis['scorecard+pypi'] ?? 0) + (byBasis.pypi ?? 0);
  const sources = [byBasis.git ? `git history ${fmt(byBasis.git)}` : '', fallbackN ? `Scorecard / registry fallback ${fmt(fallbackN)}` : ''].filter(Boolean).join(', ');
  // Per ecosystem (Tier 0.5): "npm 1,100 of 1,150, PyPI 60 of 146"; ecosystems without an upkeep source say so.
  const ecoOrder = Object.keys(byEcosystem).sort((a, b) => Number(LABELLED.has(b)) - Number(LABELLED.has(a)) || (a === 'npm' ? -1 : b === 'npm' ? 1 : a.localeCompare(b)));
  const perEco = ecoOrder.map((k) => `${ecosystemName(k)} ${fmt(byEcosystem[k]!.assessed)} of ${fmt(byEcosystem[k]!.packages)}${LABELLED.has(k) ? '' : ' (production, no upkeep source)'}`).join(', ');
  const prodTotal = prod.length;
  const prodUnknown = prod.filter((e) => !known(e)).length;
  let line = `Upkeep assessed for ${fmt(assessed)} of ${fmt(entries.length)} (${perEco}${sources ? `; ${sources}` : ''}): ${part(d, 'direct')}, ${part(r, 'runtime transitive')}; production Unknown ${fmt(prodUnknown)} of ${fmt(prodTotal)}; skipped: ${skipped.length ? skipped.map((s) => `${fmt(s.count)} ${s.reason}`).join('; ') : 'none'}.`;
  if (sel) {
    const skippedRepos = [
      sel.capped.length ? `${fmt(sel.capped.length)} over the cap of ${fmt(sel.maxRepos)} repositories (--history-max), picked by priority` : '',
      sel.tooLarge?.length ? `${fmt(sel.tooLarge.length)} larger than the per-repository cap of ${fmt(sel.budget?.perCloneMb ?? 0)} MB of the ${fmt(sel.budget?.maxMb ?? 0)} MB disk budget (--history-max-mb)` : '',
      sel.failed.length ? `${fmt(sel.failed.length)} could not be read` : '',
    ].filter(Boolean);
    line += ` Git history read for ${fmt(sel.read.length)} of ${fmt(sel.declared)} repositories${skippedRepos.length ? `; skipped: ${skippedRepos.join('; ')}` : ''}.`;
    if (sel.budget) line += ` Clone cache: ${sel.budget.shallowMonths ? `shallow clones of the last ${sel.budget.shallowMonths} months` : 'whole histories'}, peak ${fmt(sel.budget.peakMb)} MB of the ${fmt(sel.budget.maxMb)} MB budget${sel.budget.evicted ? `, ${fmt(sel.budget.evicted)} older clones deleted to stay under it` : ''}.`;
    if (sel.identity && sel.identity.repos > 0) line += ` ${identityLine(sel.identity)}`;
  }
  if (http) line += ` HTTP cache: peak ${fmt(http.peakMb)} MB of the ${fmt(http.maxMb)} MB budget (--cache-max-mb)${http.evicted ? `, ${fmt(http.evicted)} least recently used entries deleted to stay under it` : ''}.`;
  const out: StabilityCoverage = {
    packages: entries.length,
    assessed,
    byBasis,
    direct: d,
    runtimeTransitive: r,
    production: { total: prodTotal, unknown: prodUnknown },
    byEcosystem,
    skipped,
    line,
  };
  if (sel) out.history = { declared: sel.declared, read: sel.read.length, capped: sel.capped.length, failed: sel.failed.length, maxRepos: sel.maxRepos, ...(sel.tooLarge ? { tooLarge: sel.tooLarge.length } : {}), ...(sel.budget ? { budget: sel.budget } : {}), ...(sel.identity ? { identity: sel.identity } : {}) };
  if (http) out.httpCache = http;
  return out;
}
