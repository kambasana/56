/**
 * HTML report sections (docs/WHO-BEHIND-PLAN.md "Tier 0"): who is behind the dependencies, upkeep
 * (Stability), and the NOT ANALYSED banner. Same rules as html.ts: no scripts, every value escaped.
 *
 * - Who is behind: npm accounts that can publish the most production packages (reach), repository
 *   owners, and the funding pages packages name. Every link says how a machine found it and
 *   whether a person reviewed it; machine-derived links are never called reviewed.
 * - Stability: the production Fragile list with the action and the evidence of each rule.
 * - NOT ANALYSED: manifests the scan found but did not read (filled by the scope stream; read from
 *   `notAnalysed` or `coverage.notAnalysed`, whichever the result carries).
 */
import { unversionedPurl, type EntityChainEntry, type ScanResult, type StabilityEntry } from '../core/types.js';
import { escapeHtml as h, safeHttpUrl } from './escape.js';

/** A manifest the scan found but did not analyse (the scope stream's NotAnalysedManifest shape). */
export interface NotAnalysedItem {
  file: string;
  ecosystem?: string;
  reason?: string;
  packages?: number;
}

/** Tier 0 fields read structurally, so this module works whichever stream adds them first. */
type Tier0Result = ScanResult & {
  notAnalysed?: NotAnalysedItem[];
  coverage?: { notAnalysed?: NotAnalysedItem[] };
};

export function notAnalysedOf(result: ScanResult): NotAnalysedItem[] {
  const r = result as Tier0Result;
  const list = r.notAnalysed ?? r.coverage?.notAnalysed ?? [];
  return Array.isArray(list) ? list.filter((x) => x && typeof x.file === 'string') : [];
}

/** The NOT ANALYSED banner: empty when the scan read everything it found. */
export function notAnalysedBanner(result: ScanResult): string {
  const items = notAnalysedOf(result);
  if (items.length === 0) return '';
  const pkgs = items.reduce((n, i) => n + (typeof i.packages === 'number' ? i.packages : 0), 0);
  return `<section class="banner" role="alert" id="not-analysed"><strong>NOT ANALYSED: ${h(items.length)} manifest(s)${pkgs ? `, about ${h(pkgs)} package(s)` : ''}.</strong> These were found but not read, so this report is not an all-clear for them.
<ul>${items
    .slice(0, 50)
    .map((i) => `<li><code>${h(i.file)}</code>${i.ecosystem ? ` <span class="muted">(${h(i.ecosystem)})</span>` : ''}${i.reason ? `: ${h(i.reason)}` : ''}${typeof i.packages === 'number' ? ` <span class="muted">· ${h(i.packages)} package(s)</span>` : ''}</li>`)
    .join('')}${items.length > 50 ? `<li class="muted">… ${h(items.length - 50)} more</li>` : ''}</ul></section>`;
}

function linkList(urls: readonly string[], max = 3): string {
  const items = [...new Set(urls)].slice(0, max);
  if (items.length === 0) return '<span class="muted">no source</span>';
  return items
    .map((u) => {
      const safe = safeHttpUrl(u);
      return safe ? `<a href="${h(safe)}" rel="noopener noreferrer nofollow">${h(u.replace(/^https:\/\//, ''))}</a>` : `<code>${h(u)}</code>`;
    })
    .join('<br>');
}

/** "machine-derived (deterministic)" or "reviewed": the two are never merged. */
export function reviewState(e: Pick<EntityChainEntry, 'method' | 'reviewed'>): string {
  return e.reviewed ? 'reviewed' : `machine-derived (${e.method ?? 'deterministic'})`;
}

const nameOf = (purl: string): string => {
  try {
    const u = unversionedPurl(purl);
    return decodeURIComponent(u.replace(/^pkg:[^/]+\//, ''));
  } catch {
    return purl;
  }
};

const entityName = (id: string): string => id.slice(id.indexOf(':') + 1);

interface PackageBehind {
  name: string;
  production: boolean | null;
  behind: EntityChainEntry[];
}

/** One row per package (findings and health entries), with its production flag from the stability report when known. */
function packagesBehind(result: ScanResult): PackageBehind[] {
  const prod = new Map<string, boolean>();
  for (const p of result.stability?.packages ?? []) prod.set(p.name, p.production);
  const out = new Map<string, PackageBehind>();
  for (const x of [...result.findings, ...(result.health ?? [])]) {
    const name = nameOf(x.purl);
    const row = out.get(name) ?? { name, production: prod.has(name) ? prod.get(name)! : null, behind: [] };
    for (const e of x.behind ?? []) if (!row.behind.some((b) => b.entityId === e.entityId && b.relation === e.relation)) row.behind.push(e);
    out.set(name, row);
  }
  return [...out.values()];
}

interface Tally {
  id: string;
  packages: string[];
  production: number;
  methods: Set<string>;
  reviewed: number;
  links: number;
  evidence: string[];
}

function tally(rows: readonly PackageBehind[], pick: (e: EntityChainEntry) => boolean): Tally[] {
  const by = new Map<string, Tally>();
  for (const r of rows) {
    for (const e of r.behind) {
      if (!pick(e)) continue;
      const t = by.get(e.entityId) ?? { id: e.entityId, packages: [], production: 0, methods: new Set<string>(), reviewed: 0, links: 0, evidence: [] };
      if (!t.packages.includes(r.name)) {
        t.packages.push(r.name);
        if (r.production) t.production++;
      }
      t.methods.add(e.method ?? 'deterministic');
      t.links++;
      if (e.reviewed) t.reviewed++;
      for (const u of e.evidence ?? []) if (t.evidence.length < 3 && !t.evidence.includes(u)) t.evidence.push(u);
      by.set(e.entityId, t);
    }
  }
  return [...by.values()];
}

function stateOf(t: Tally): string {
  const machine = t.links - t.reviewed;
  const methods = [...t.methods].sort().join(', ');
  if (t.reviewed === 0) return `machine-derived (${h(methods)})`;
  return machine === 0 ? 'reviewed' : `${h(t.reviewed)} reviewed, ${h(machine)} machine-derived (${h(methods)})`;
}

/** Who is behind: top accounts by reach, repository owners, funding pages. */
export function behindSection(result: ScanResult, opts: { top?: number } = {}): string {
  const rows = packagesBehind(result);
  const withLinks = rows.filter((r) => r.behind.length > 0);
  if (withLinks.length === 0) return '';
  const top = opts.top ?? 15;
  const known = rows.some((r) => r.production !== null);
  const sortByReach = (a: Tally, b: Tally) => b.production - a.production || b.packages.length - a.packages.length || a.id.localeCompare(b.id);
  const accounts = tally(withLinks, (e) => e.entityId.startsWith('account:npm/') && (e.relation === 'maintains' || e.relation === 'publishes')).sort(sortByReach);
  const owners = tally(withLinks, (e) => e.relation === 'owns').sort(sortByReach);
  const funding = tally(withLinks, (e) => e.relation === 'receives_funding_at').sort(sortByReach);
  const all = withLinks.flatMap((r) => r.behind);
  const reviewed = all.filter((e) => e.reviewed).length;
  const prodLabel = known ? 'Production packages' : 'Packages';

  const accountRows = accounts
    .slice(0, top)
    .map(
      (t) =>
        `<tr><td><code>${h(entityName(t.id))}</code></td><td class="num">${h(known ? t.production : t.packages.length)}</td><td class="num">${h(t.packages.length)}</td><td>${h(t.packages.slice(0, 6).join(', '))}${t.packages.length > 6 ? ', …' : ''}</td><td>${stateOf(t)}</td><td>${linkList(t.evidence, 1)}</td></tr>`,
    )
    .join('');
  const ownerKind = (id: string) => (id.startsWith('org:') ? 'organisation' : id.startsWith('account:') ? 'user' : 'type unknown');
  const ownerRows = owners
    .slice(0, top)
    .map((t) => `<tr><td><code>${h(entityName(t.id))}</code></td><td>${h(ownerKind(t.id))}</td><td class="num">${h(known ? t.production : t.packages.length)}</td><td class="num">${h(t.packages.length)}</td><td>${stateOf(t)}</td><td>${linkList(t.evidence, 1)}</td></tr>`)
    .join('');
  const fundingRows = funding
    .slice(0, top)
    .map((t) => `<tr><td><code>${h(entityName(t.id))}</code></td><td class="num">${h(t.packages.length)}</td><td>${h(t.packages.slice(0, 6).join(', '))}${t.packages.length > 6 ? ', …' : ''}</td><td>${linkList(t.evidence, 2)}</td></tr>`)
    .join('');
  const unknownOwners = owners.filter((t) => t.id.startsWith('owner:')).length;

  return `<h2 id="who-is-behind">Who is behind</h2>
<p class="muted">Public registry and repository records for ${h(withLinks.length)} package(s): ${h(all.length - reviewed)} link(s) machine-derived, ${h(reviewed)} reviewed by a person. Machine-derived means a registry or repository field read as-is (method shown); only a review decision makes a link reviewed. A repository owner whose type could not be read is "type unknown" and is never treated as an organisation. Not a finding of wrongdoing.</p>
<h3>Accounts that can publish the most ${h(prodLabel.toLowerCase())}</h3>
${accounts.length ? `<div class="scroll"><table><thead><tr><th>npm account</th><th>${h(prodLabel)}</th><th>All packages</th><th>Packages</th><th>State</th><th>Source</th></tr></thead><tbody>${accountRows}</tbody></table></div>` : '<p class="muted">No npm accounts recorded.</p>'}
<h3>Repository owners</h3>
${owners.length ? `<p class="muted">${h(unknownOwners)} of ${h(owners.length)} owner(s) have an unknown type (the type lookup failed or was not made).</p><div class="scroll"><table><thead><tr><th>Owner</th><th>Type</th><th>${h(prodLabel)}</th><th>All packages</th><th>State</th><th>Source</th></tr></thead><tbody>${ownerRows}</tbody></table></div>` : '<p class="muted">No repository owners recorded.</p>'}
<h3>Funding pages the packages name</h3>
<p class="muted">Where a package's own funding field or its repository's FUNDING.yml says money can be sent. Who pays whom is not shown.</p>
${funding.length ? `<div class="scroll"><table><thead><tr><th>Funding page</th><th>Packages</th><th>Names</th><th>Source</th></tr></thead><tbody>${fundingRows}</tbody></table></div>` : '<p class="muted">None named.</p>'}`;
}

/** Evidence URLs behind a label: every rule's facts. */
function stabilityEvidence(e: StabilityEntry): string[] {
  return [...new Set(e.rules.flatMap((r) => r.facts.flatMap((f) => f.evidence ?? [])))];
}

/** The action for an entry: the label's own action when the rules give one, else what the rules say. */
function actionOf(e: StabilityEntry): string {
  const own = (e as StabilityEntry & { action?: string }).action;
  if (typeof own === 'string' && own) return own;
  return e.s3.state === 'ended' ? 'Plan a replacement or upgrade: upkeep has ended.' : 'Review: check upkeep before relying on it further.';
}

/** Stability: production Fragile packages with the action and evidence; counts for the rest. */
export function stabilitySection(result: ScanResult): string {
  const st = result.stability;
  if (!st) return '';
  const fragile = st.packages.filter((p) => p.label === 'fragile' && p.production).sort((a, b) => a.name.localeCompare(b.name));
  const rows = fragile
    .slice(0, 100)
    .map(
      (p) =>
        `<tr><td><code>${h(p.name)}</code><div class="muted">${h(p.versions.join(', '))}</div></td><td>${h(p.summary)}<div class="muted">${h(p.rules.map((r) => r.name).join('; '))}</div></td><td>${h(actionOf(p))}</td><td>${linkList(stabilityEvidence(p))}</td></tr>`,
    )
    .join('');
  const c = st.counts;
  // Tier 0.5: never an all-clear while production packages are unassessed (Python read as clean).
  const prod = st.packages.filter((p) => p.production);
  const unassessed = prod.filter((p) => p.label === 'unknown');
  const none = unassessed.length
    ? `<p class="muted">No assessed production package is labelled Fragile, but upkeep is not assessed for ${h(unassessed.length)} of ${h(prod.length)} production packages (Unknown): ${h(
        unassessed
          .slice(0, 8)
          .map((p) => p.name)
          .join(', '),
      )}${unassessed.length > 8 ? ', …' : ''}.</p>`
    : prod.length
      ? '<p class="muted">No production package is labelled Fragile.</p>'
      : '<p class="muted">No production package was labelled: upkeep was not assessed for this scan.</p>';
  const coverage = st.coverage?.line ? `<p class="muted">${h(st.coverage.line)}</p>` : '';
  return `<h2 id="stability">Stability</h2>
<p class="muted">Upkeep labels from public records (as of ${h(st.asOf)}): fragile ${h(c.fragile)}, watch ${h(c.watch)}, steady ${h(c.steady)}, unknown ${h(c.unknown)}. ${h(st.disclaimer)}</p>
${coverage}
<h3>Fragile in production (${h(fragile.length)})</h3>
${fragile.length ? `<div class="scroll"><table><thead><tr><th>Package</th><th>Why</th><th>Action</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>${fragile.length > 100 ? `<p class="muted">… ${h(fragile.length - 100)} more in the JSON report.</p>` : ''}${unassessed.length ? `<p class="muted">Upkeep is not assessed for ${h(unassessed.length)} of ${h(prod.length)} production packages (Unknown).</p>` : ''}` : none}`;
}
