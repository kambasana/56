/**
 * Intrinsic risk of a component version (PLAN §3.6 step 1):
 *   intrinsic(p) = 1 − Π (1 − wᵢ · fᵢ(p)),  with a malware override to 1.0.
 */
import { factsFor, npmPurl, type Component, type Fact, type Incident, type Reason } from '../core/types.js';
import {
  ABANDONED_DAYS,
  ABANDONED_VALUES,
  COMPROMISED_RELEASE_TYPES,
  DEFAULT_WEIGHTS,
  INSTALL_SCRIPT,
  KNOWN_PUBLISHER_FACTOR,
  OWNERSHIP_DECAY_DAYS,
  REPO_TRANSFER_UNDATED_VALUE,
  VULN,
  type FactorWeights,
} from './weights.js';
import { incidentsAffectingExactly } from './incidents.js';
import { clamp01, cleanEvidence, cmpStr, daysSince, noisyOr, round, short, sortReasons } from './util.js';

export interface IntrinsicResult {
  /** 0–1. */
  intrinsic: number;
  reasons: Reason[];
  /** True when the malware override applied. */
  malware: boolean;
}

interface Candidate {
  factor: string;
  value: number;
  weight: number;
  detail: string;
  evidence: string[];
}

function ev(f: Fact, ...extra: (string | undefined)[]): string[] {
  return cleanEvidence([...(f.evidence ?? []), ...extra]);
}

/** Vulnerability factor value for one vuln: base (CVSS/10) × exploitability (EPSS), ×1.5 if KEV. */
export function vulnValue(v: { cvss?: number; severity: string; epss?: number; kev?: boolean }): number {
  const base =
    typeof v.cvss === 'number' && Number.isFinite(v.cvss) ? clamp01(v.cvss / 10) : (VULN.severityBase[v.severity] ?? VULN.severityBase.unknown!);
  let exploit = typeof v.epss === 'number' && Number.isFinite(v.epss) ? VULN.epssFloor + (1 - VULN.epssFloor) * clamp01(v.epss) : VULN.defaultExploitability;
  if (v.kev) exploit = 1;
  return clamp01(base * exploit * (v.kev ? VULN.kevMultiplier : 1));
}

/** Linear decay from 1 (today) to 0 at OWNERSHIP_DECAY_DAYS. */
export function ownershipDecay(days: number): number {
  return clamp01(1 - days / OWNERSHIP_DECAY_DAYS);
}

/** Dependents (deps.dev) above which a once-new dependency counts as established. */
const ESTABLISHED_DEPENDENTS = 500;

export function scoreIntrinsic(
  component: Component,
  facts: readonly Fact[],
  opts: { now: Date; incidents?: readonly Incident[]; weights?: Partial<FactorWeights> },
): IntrinsicResult {
  const w: FactorWeights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const now = opts.now;
  const mine = factsFor(facts, component.purl);
  const reasons: Reason[] = [];

  // --- Malware override -----------------------------------------------------
  const malwareReasons: Reason[] = [];
  for (const f of mine) {
    if (f.kind !== 'malware') continue;
    malwareReasons.push({
      factor: 'malware',
      value: 1,
      weight: w.malware,
      contribution: 0,
      detail: `Listed as malicious in ${short(f.value.id, 60)} (source: ${short(f.source, 30)})${f.value.summary ? `: ${short(f.value.summary)}` : ''}`,
      evidence: ev(f, f.value.url),
    });
  }
  // Only incidents that list this exact version/SHA: a "*" entry also matches post-fix releases
  // (those are scored as a decaying `incident_affected` reason in entity.ts instead).
  for (const inc of incidentsAffectingExactly(component, opts.incidents ?? [])) {
    if (inc.status !== 'confirmed' || !COMPROMISED_RELEASE_TYPES.includes(inc.type)) continue;
    if (malwareReasons.some((r) => r.detail.includes(inc.id))) continue;
    malwareReasons.push({
      // A compromised CI action is not "malware" in the package sense; name it for what it is.
      factor: inc.type === 'ci_compromise' ? 'compromised_release' : 'malware',
      value: 1,
      weight: w.malware,
      contribution: 0,
      detail: `Version ${short(component.version, 40)} is listed as affected by ${inc.id} (${inc.type}, confirmed): ${short(inc.title)}`,
      evidence: cleanEvidence(inc.evidence),
    });
  }

  // --- Weighted factors -----------------------------------------------------
  const cands: Candidate[] = [];

  const vulns = mine.filter((f): f is Extract<Fact, { kind: 'vuln' }> => f.kind === 'vuln');
  if (vulns.length > 0) {
    const scored = vulns
      .map((f) => ({ f, v: vulnValue(f.value) }))
      .sort((a, b) => b.v - a.v || cmpStr(a.f.value.id, b.f.value.id));
    const top = scored[0]!;
    const tv = top.f.value;
    const parts = [
      `${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y' : 'ies'}; most severe ${short(tv.id, 60)}`,
      tv.cvss !== undefined ? `CVSS ${tv.cvss}` : `severity ${tv.severity}`,
    ];
    if (tv.epss !== undefined) parts.push(`EPSS ${round(tv.epss, 4)}`);
    if (tv.kev) parts.push('listed in CISA KEV');
    if (tv.fixedVersions.length > 0) parts.push(`fixed in ${tv.fixedVersions.slice(0, 3).map((s) => short(s, 30)).join(', ')}`);
    cands.push({
      factor: 'vuln',
      value: top.v,
      weight: w.vuln,
      detail: parts.join(', '),
      evidence: cleanEvidence(scored.flatMap((s) => [s.f.value.url, ...(s.f.evidence ?? [])])),
    });
  }

  // Ownership changes: publisher_change, maintainer_change, repo_transfer — take the strongest.
  const own: Candidate[] = [];
  for (const f of mine) {
    if (f.kind === 'publisher_change') {
      const d = daysSince(f.value.changedAt, now);
      if (d === undefined) continue;
      const v = ownershipDecay(d) * (f.value.firstTimePublisher ? 1 : KNOWN_PUBLISHER_FACTOR);
      if (v <= 0) continue;
      own.push({
        factor: 'publisher_change',
        value: v,
        weight: w.ownership_change,
        detail: `Version ${short(f.value.version, 40)} was published by "${short(f.value.newPublisher, 60)}" (previous version ${short(f.value.previousVersion, 40)} by "${short(f.value.previousPublisher, 60)}")${f.value.firstTimePublisher ? ', first release by this account' : ''}, ${Math.round(d)} days ago`,
        evidence: ev(f),
      });
    } else if (f.kind === 'maintainer_change') {
      if (f.value.added.length === 0 && f.value.removed.length === 0) continue;
      const d = daysSince(f.value.changedAt, now);
      if (d === undefined) continue;
      const v = ownershipDecay(d);
      if (v <= 0) continue;
      const bits: string[] = [];
      if (f.value.added.length) bits.push(`added ${f.value.added.slice(0, 5).map((s) => short(s, 40)).join(', ')}`);
      if (f.value.removed.length) bits.push(`removed ${f.value.removed.slice(0, 5).map((s) => short(s, 40)).join(', ')}`);
      own.push({
        factor: 'maintainer_change',
        value: v,
        weight: w.ownership_change,
        detail: `Maintainer list changed ${Math.round(d)} days ago (${bits.join('; ')})`,
        evidence: ev(f),
      });
    } else if (f.kind === 'repo_transfer') {
      // Decay only from a known transfer date. `detectedAt` is when we looked, not when it moved.
      const moved = `Source repository ${short(f.value.repo, 80)} moved from "${short(f.value.fromOwner, 40)}" to "${short(f.value.toOwner, 40)}"`;
      const d = f.value.transferredAt ? daysSince(f.value.transferredAt, now) : undefined;
      if (d !== undefined) {
        const v = ownershipDecay(d);
        if (v <= 0) continue;
        own.push({ factor: 'repo_transfer', value: v, weight: w.ownership_change, detail: `${moved} ${Math.round(d)} days ago`, evidence: ev(f) });
      } else {
        own.push({
          factor: 'repo_transfer',
          value: REPO_TRANSFER_UNDATED_VALUE,
          weight: w.ownership_change,
          detail: `${moved} (declared URL redirects; date of the move unknown)`,
          evidence: ev(f),
        });
      }
    }
  }
  // Ties (e.g. a publisher change and the matching maintainer-list change at the same release)
  // go to the most specific signal: who actually published the release.
  const ownPriority: Record<string, number> = { publisher_change: 0, repo_transfer: 1, maintainer_change: 2 };
  own.sort(
    (a, b) =>
      b.value - a.value || (ownPriority[a.factor] ?? 9) - (ownPriority[b.factor] ?? 9) || cmpStr(a.detail, b.detail),
  );
  if (own[0]) cands.push(own[0]);

  // Install scripts.
  const scriptFact = mine.find((f): f is Extract<Fact, { kind: 'install_script' }> => f.kind === 'install_script');
  if (scriptFact ? scriptFact.value.hasInstallScript : component.hasInstallScript === true) {
    const flags = (scriptFact?.value.flags ?? []).map((s) => short(s, 30));
    const risky = flags.filter((fl) => INSTALL_SCRIPT.riskyFlags.includes(fl.toLowerCase()));
    const hooks = scriptFact?.value.hooks ?? [];
    const newHooks = scriptFact?.value.newHooks ?? [];
    const prevVersion = scriptFact?.value.previousVersion;
    cands.push({
      factor: 'install_script',
      value: risky.length > 0 ? INSTALL_SCRIPT.flagged : INSTALL_SCRIPT.base,
      weight: w.install_script,
      detail:
        `Runs install-time scripts${hooks.length ? ` (${hooks.join(', ')})` : ''}` +
        (newHooks.length && prevVersion
          ? `; ${newHooks.join(', ')} newly added in this version (previous release ${short(prevVersion, 40)} had none)`
          : '') +
        (risky.length ? `; static checks flagged: ${risky.join(', ')}` : ''),
      evidence: scriptFact ? ev(scriptFact) : [],
    });
  }

  // Weak posture (Scorecard).
  const sc = mine.find((f): f is Extract<Fact, { kind: 'scorecard' }> => f.kind === 'scorecard');
  if (sc && Number.isFinite(sc.value.score)) {
    const v = clamp01(1 - sc.value.score / 10);
    if (v > 0) {
      const weakest = [...sc.value.checks]
        .filter((c) => c.score >= 0)
        .sort((a, b) => a.score - b.score || cmpStr(a.name, b.name))
        .slice(0, 3)
        .map((c) => `${short(c.name, 40)} ${c.score}/10`);
      cands.push({
        factor: 'weak_posture',
        value: v,
        weight: w.weak_posture,
        detail: `OpenSSF Scorecard ${round(sc.value.score, 1)}/10 for ${short(sc.value.repo, 80)}${weakest.length ? `; lowest checks: ${weakest.join(', ')}` : ''}`,
        // The deps.dev enricher already cites the viewer page; only add one when it is missing.
        evidence: (sc.evidence ?? []).some((u) => u.startsWith('https://scorecard.dev/viewer/'))
          ? ev(sc)
          : ev(sc, `https://scorecard.dev/viewer/?uri=${encodeURIComponent(sc.value.repo)}`),
      });
    }
  }

  // No provenance (only when the registry was actually checked).
  const prov = mine.filter((f): f is Extract<Fact, { kind: 'provenance' }> => f.kind === 'provenance');
  const dropped = prov.find((f) => !f.value.hasProvenance && f.value.droppedSince);
  if (dropped) {
    // A signal, not upkeep: the usual signed pipeline was bypassed for this release.
    cands.push({
      factor: 'provenance_dropped',
      value: 1,
      weight: w.provenance_dropped,
      detail: `Published without the build provenance that the previous release (${short(dropped.value.droppedSince!, 40)}) had`,
      evidence: cleanEvidence(prov.flatMap((f) => f.evidence ?? [])),
    });
  } else if (prov.length > 0 && !prov.some((f) => f.value.hasProvenance)) {
    cands.push({
      factor: 'no_provenance',
      value: 1,
      weight: w.no_provenance,
      detail: 'No build provenance / attestation found for this version',
      evidence: cleanEvidence(prov.flatMap((f) => f.evidence ?? [])),
    });
  }

  // New dependency in a patch release, and that dependency is itself brand new on the registry
  // (event-stream 3.3.6 → flatmap-stream, node-ipc 9.2.2 → peacenotwar). Adding an established
  // package in a patch is routine and does not count.
  const dep = mine.find((f): f is Extract<Fact, { kind: 'dependency_added' }> => f.kind === 'dependency_added');
  // A brand-new dependency that has since become a common building block (has-tostringtag,
  // call-bind: thousands of dependents) is a maintainer splitting code, not an attack; without
  // dependents data (offline) the signal stays.
  const young = (dep?.value.young ?? []).filter((y) => {
    let count: number | undefined;
    try {
      count = factsFor(facts, npmPurl(y.name)).find((f): f is Extract<Fact, { kind: 'dependents' }> => f.kind === 'dependents')?.value.count;
    } catch {
      return true;
    }
    return !(typeof count === 'number' && count >= ESTABLISHED_DEPENDENTS);
  });
  if (dep && young.length > 0) {
    const names = young.slice(0, 5).map((y) => `${short(y.name, 60)} (${y.daysBeforeRelease > 0 ? `first released ${y.daysBeforeRelease} days earlier` : 'first released the same day or later'})`);
    cands.push({
      factor: 'dependency_added',
      value: 1,
      weight: w.dependency_added,
      detail: `Patch release ${short(dep.value.version, 40)} added ${young.length === 1 ? 'a brand-new dependency' : `${young.length} brand-new dependencies`} not in ${short(dep.value.previousVersion, 40)}: ${names.join(', ')}${young.length > names.length ? ', …' : ''}`,
      evidence: ev(dep),
    });
  }

  // Single maintainer.
  const maint = mine.find((f): f is Extract<Fact, { kind: 'maintainers' }> => f.kind === 'maintainers');
  if (maint && maint.value.count === 1) {
    cands.push({
      factor: 'single_maintainer',
      value: 1,
      weight: w.single_maintainer,
      detail: 'Package has a single registry maintainer account',
      evidence: ev(maint),
    });
  }

  // Abandoned.
  const age = mine.find((f): f is Extract<Fact, { kind: 'release_age' }> => f.kind === 'release_age');
  const arch = mine.find((f): f is Extract<Fact, { kind: 'archived' }> => f.kind === 'archived');
  const staleDays = age?.value.daysSinceLatestRelease;
  const stale = typeof staleDays === 'number' && staleDays >= ABANDONED_DAYS;
  const archived = arch?.value.archived === true;
  if (stale || archived) {
    const v = vulns.length > 0 ? ABANDONED_VALUES.withVulns : archived ? ABANDONED_VALUES.archivedOnly : ABANDONED_VALUES.staleOnly;
    const bits: string[] = [];
    if (archived) bits.push('source repository is archived');
    if (stale) bits.push(`no release in ${Math.round(staleDays)} days`);
    if (vulns.length > 0) bits.push(`${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y' : 'ies'}`);
    if (age?.value.deprecated) bits.push(`deprecated: ${short(age.value.deprecated, 80)}`);
    cands.push({
      factor: 'abandoned',
      value: v,
      weight: w.abandoned,
      detail: bits.join('; '),
      evidence: cleanEvidence([...(age?.evidence ?? []), ...(arch?.evidence ?? [])]),
    });
  }

  cands.sort((a, b) => b.weight * b.value - a.weight * a.value || cmpStr(a.factor, b.factor));
  const { total, contributions } = noisyOr(cands);
  const malware = malwareReasons.length > 0;

  if (malware) {
    malwareReasons.sort((a, b) => cmpStr(a.detail, b.detail));
    malwareReasons[0]!.contribution = 1;
    reasons.push(...malwareReasons);
  }
  cands.forEach((c, i) => {
    reasons.push({
      factor: c.factor,
      value: round(c.value),
      weight: c.weight,
      contribution: malware ? 0 : round(contributions[i] ?? 0),
      detail: c.detail,
      evidence: c.evidence,
    });
  });

  return { intrinsic: malware ? 1 : clamp01(total), reasons: sortReasons(reasons), malware };
}
