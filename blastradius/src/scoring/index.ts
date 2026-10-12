/**
 * Scoring engine (PLAN §3.6): intrinsic + entity risk → combined risk → inbound blast radius,
 * plus outbound blast radius for workflows. Output ordering is deterministic.
 */
import {
  factsFor,
  LEVEL_THRESHOLDS,
  levelForScore,
  summarizeInventory,
  type AssetExposure,
  type EntityLink,
  type Fact,
  type Finding,
  type FindingGate,
  type HealthEntry,
  type Incident,
  type Inventory,
  type OutboundFinding,
  type Reason,
  type ScanResult,
} from '../core/types.js';
import { scoreIntrinsic } from './intrinsic.js';
import { createLinkPathProvider, scoreEntityRisk, type EntityPathProvider } from './entity.js';
import { buildDependencyGraph, inboundExposure, type PathLimits } from './blast.js';
import { scoreOutbound, type WorkflowRiskInput } from './outbound.js';
import { PATH_LIMITS, REPO_TRANSFER_UNDATED_VALUE, type FactorWeights } from './weights.js';
import { clamp01, cmpStr, noisyOr, round, sortReasons } from './util.js';
import { npmNameFromPurl, parsePurl } from '../core/types.js';
import { scopeTier, SCOPE_LABEL, strongerScope, type ComponentScope } from '../core/scope.js';

export interface ScoreOptions {
  /** Reference time for all decay calculations (fixed per scan). */
  now: Date;
  /** Incident KB entries (src/incidents). */
  incidents?: readonly Incident[];
  /** Entity path source, e.g. `buildEntityGraph(data, incidents)` from src/entities. */
  entityPaths?: EntityPathProvider;
  /** Used to build a path provider when `entityPaths` is not given. */
  links?: readonly EntityLink[];
  weights?: Partial<FactorWeights>;
  /** Workflow info from ingest (`ingestDetailed().workflows`) for the outbound score. */
  workflows?: readonly WorkflowRiskInput[];
  /** Downstream dependents per asset id, for the outbound score. */
  outboundDependents?: Record<string, number>;
  /** Only report findings with score > minScore (0–100). Default 0. */
  minScore?: number;
  pathLimits?: Partial<PathLimits>;
  /**
   * Noise rule (default true): a component whose only reasons are posture signals goes to
   * `health`, not `findings`. false keeps the old behaviour (every scored component is a finding).
   */
  noiseRule?: boolean;
}

/** Weak signals that describe a package's upkeep, not something that happened to it. */
export const POSTURE_FACTORS: ReadonlySet<string> = new Set(['weak_posture', 'no_provenance', 'single_maintainer', 'abandoned']);

/** True when a reason is a posture signal (an undated repo move counts: renames years ago look the same). */
export function isPostureReason(r: Reason): boolean {
  if (POSTURE_FACTORS.has(r.factor)) return true;
  return r.factor === 'repo_transfer' && r.value <= REPO_TRANSFER_UNDATED_VALUE;
}

export interface ScoreOutput {
  findings: Finding[];
  /** Posture-only components (noise rule). */
  health: HealthEntry[];
  outbound: OutboundFinding[];
  warnings: string[];
}

/**
 * Production first (Tier 0 exposure gate): runtime findings, then peer, optional, CI, dev and
 * unreachable ones; by score within a scope. Malicious or compromised releases run at install
 * time, so they rank with runtime findings whatever their scope.
 */
export function compareFindings(a: Finding, b: Finding): number {
  return rankTier(a) - rankTier(b) || b.score - a.score || b.blastRadius.score - a.blastRadius.score || cmpStr(a.purl, b.purl);
}

function rankTier(f: Finding): number {
  return f.gate?.rule === 'install_time' ? 0 : scopeTier(f.scope);
}

/** Exposure gate (Tier 0). A runtime advisory at or above this CVSS with a fix is critical. */
export const RUNTIME_CRITICAL_CVSS = 9;
/** Highest score a finding outside runtime can reach: dev / CI / unreachable stay below high. */
export const NON_RUNTIME_MAX_SCORE = LEVEL_THRESHOLDS.high - 0.1;
/** Peer and optional dependencies stay below critical. */
export const OPTIONAL_MAX_SCORE = LEVEL_THRESHOLDS.critical - 0.1;
/** Posture and provenance factors add at most this many points, and never change the level. */
export const POSTURE_TIEBREAK_POINTS = 0.9;

/** Highest score at the same level as `score` (posture tie-breaks never cross a level). */
function levelCeiling(score: number): number {
  if (score >= LEVEL_THRESHOLDS.critical) return 100;
  if (score >= LEVEL_THRESHOLDS.high) return LEVEL_THRESHOLDS.critical - 0.1;
  if (score >= LEVEL_THRESHOLDS.medium) return LEVEL_THRESHOLDS.high - 0.1;
  return LEVEL_THRESHOLDS.medium - 0.1;
}

function displayName(purl: string): string {
  try {
    const p = parsePurl(purl);
    return p.type === 'npm' ? npmNameFromPurl(p) : p.namespace ? `${p.namespace}/${p.name}` : p.name;
  } catch {
    return purl;
  }
}

/** Who brings the component in on its strongest path ("express", or "direct"). */
function introducer(assets: readonly AssetExposure[], scope: ComponentScope): string | undefined {
  for (const a of assets) {
    if (a.scope !== scope) continue;
    const p = a.paths[0];
    if (!p) continue;
    return p.length > 2 ? displayName(p[1]!) : 'direct';
  }
  return undefined;
}

/** The strongest runtime-critical advisory with a fix, if any. */
function criticalFixable(purl: string, facts: readonly Fact[]): { id: string; cvss?: number; fixed: string[] } | undefined {
  let best: { id: string; cvss?: number; fixed: string[] } | undefined;
  for (const f of factsFor(facts, purl, 'vuln')) {
    if (f.kind !== 'vuln') continue;
    const v = f.value;
    const critical = typeof v.cvss === 'number' && Number.isFinite(v.cvss) ? v.cvss >= RUNTIME_CRITICAL_CVSS : v.severity === 'critical';
    if (!critical || v.fixedVersions.length === 0) continue;
    if (!best || (v.cvss ?? 0) > (best.cvss ?? 0) || ((v.cvss ?? 0) === (best.cvss ?? 0) && v.id < best.id)) best = { id: v.id, ...(v.cvss !== undefined ? { cvss: v.cvss } : {}), fixed: v.fixedVersions };
  }
  return best;
}

/**
 * Apply the exposure gate to a signal score: floor for runtime critical advisories with a fix,
 * caps outside runtime, and a posture tie-break that never changes the level.
 */
export function gateScore(args: {
  signalScore: number;
  postureRisk: number;
  scope: ComponentScope;
  installTime: boolean;
  criticalFix?: { id: string; cvss?: number; fixed: string[] };
  via?: string;
}): { score: number; gate: FindingGate } {
  const { signalScore, scope } = args;
  const via = args.via && args.via !== 'direct' ? ` (brought in by ${args.via})` : args.via === 'direct' ? ' (direct dependency)' : '';
  let score = signalScore;
  let rule: string;
  let detail: string;
  if (args.installTime) {
    rule = 'install_time';
    detail = `Known malicious or compromised release: it runs at install time, so it ranks with production findings in any scope (here ${SCOPE_LABEL[scope]}${via}).`;
  } else if (scope === 'runtime') {
    if (args.criticalFix) {
      rule = 'runtime_critical_fix';
      score = Math.max(score, LEVEL_THRESHOLDS.critical);
      const c = args.criticalFix;
      detail = `Runtime dependency${via} with ${c.id}${c.cvss !== undefined ? ` (CVSS ${c.cvss})` : ' (critical)'} and a fix available (${c.fixed.slice(0, 3).join(', ')}): raised to critical and ranked above every non-runtime finding.`;
    } else {
      rule = 'runtime';
      detail = `Runtime dependency${via}: ranked with production findings.`;
    }
  } else if (scope === 'peer' || scope === 'optional') {
    rule = 'optional_cap';
    score = Math.min(score, OPTIONAL_MAX_SCORE);
    detail = `${scope === 'peer' ? 'Peer' : 'Optional'} dependency only${via}: kept below critical and ranked after runtime findings.`;
  } else {
    rule = 'non_runtime_cap';
    score = Math.min(score, NON_RUNTIME_MAX_SCORE);
    detail = `${scope === 'ci' ? 'CI / build environment only' : scope === 'dev' ? 'Dev / test dependency only' : 'Not reached from any project file'}${via}: kept below high and ranked after runtime findings.`;
  }
  // Posture and provenance only break ties: a fraction of a point, never across a level.
  const tie = round(clamp01(args.postureRisk) * POSTURE_TIEBREAK_POINTS, 1);
  const withTie = Math.min(score + tie, levelCeiling(score));
  return { score: round(Math.max(score, withTie), 1), gate: { rule, detail, signalScore: round(signalScore, 1) } };
}

export function scoreInventory(inv: Inventory, facts: readonly Fact[], opts: ScoreOptions): ScoreOutput {
  const incidents = opts.incidents ?? [];
  const paths = opts.entityPaths ?? (opts.links ? createLinkPathProvider(opts.links, incidents) : undefined);
  const graph = buildDependencyGraph(inv);
  const minScore = opts.minScore ?? 0;
  const findings: Finding[] = [];
  const health: HealthEntry[] = [];
  const noiseRule = opts.noiseRule ?? true;
  const truncated: string[] = [];

  // One scope per component of this project (src/core/scope.ts), strongest over every asset.
  const scopeOf = new Map<string, ComponentScope>();
  for (const perAsset of graph.scopes.values()) for (const [purl, s] of perAsset) scopeOf.set(purl, scopeOf.has(purl) ? strongerScope(scopeOf.get(purl)!, s) : s);

  const components = [...inv.components].sort((a, b) => cmpStr(a.purl, b.purl));
  const seen = new Set<string>();
  for (const c of components) {
    if (seen.has(c.purl)) continue;
    seen.add(c.purl);
    const scope = scopeOf.get(c.purl) ?? 'unreachable';
    const intr = scoreIntrinsic(c, facts, { now: opts.now, incidents, ...(opts.weights ? { weights: opts.weights } : {}) });
    const ent = scoreEntityRisk(c, { now: opts.now, incidents, ...(paths ? { paths } : {}) });
    const risk = clamp01(1 - (1 - intr.intrinsic) * (1 - ent.risk));
    const behind = paths?.ownershipOf?.(c.purl) ?? [];
    const allReasons = [...intr.reasons, ...ent.reasons];
    if (noiseRule && allReasons.every((r) => isPostureReason(r) || !(r.value > 0))) {
      const score = round(risk * 100, 1);
      if (!(score > minScore)) continue;
      const entityReasons = ent.reasons.map((r, i) => ({ ...r, contribution: i === 0 ? round((1 - intr.intrinsic) * ent.risk) : 0 }));
      health.push({ purl: c.purl, score, scope, reasons: sortReasons([...intr.reasons, ...entityReasons]), ...(behind.length ? { behind } : {}) });
      continue;
    }

    // Signals decide the level; posture and provenance (Scorecard, no provenance, single
    // maintainer, abandoned) are tie-breakers only (Tier 0).
    const signalReasons = intr.reasons.filter((r) => !isPostureReason(r));
    const postureReasons = intr.reasons.filter((r) => isPostureReason(r));
    const signal = noisyOr(signalReasons.map((r) => ({ weight: r.weight, value: r.value })));
    const signalIntr = intr.malware ? 1 : signal.total;
    const signalRisk = clamp01(1 - (1 - signalIntr) * (1 - ent.risk));
    const postureRisk = noisyOr(postureReasons.map((r) => ({ weight: r.weight, value: r.value }))).total;
    if (!intr.malware) signalReasons.forEach((r, i) => (r.contribution = round(signal.contributions[i] ?? 0)));
    const postureWeight = postureReasons.reduce((n, r) => n + r.weight * r.value, 0);

    const hasInstallScript = intr.reasons.some((r) => r.factor === 'install_script');
    const inbound = inboundExposure(graph, c.purl, { hasInstallScript, ...(opts.pathLimits ? { limits: opts.pathLimits } : {}) });
    for (const t of inbound.truncated) truncated.push(`${t.assetId} → ${t.purl}`);

    const crit = scope === 'runtime' ? criticalFixable(c.purl, facts) : undefined;
    const { score, gate } = gateScore({
      signalScore: signalRisk * 100,
      postureRisk,
      scope,
      installTime: intr.malware,
      ...(crit ? { criticalFix: crit } : {}),
      ...(introducer(inbound.assets, scope) ? { via: introducer(inbound.assets, scope)! } : {}),
    });
    if (!(score > minScore)) continue;
    const tiePoints = Math.max(0, score - Math.max(gate.signalScore, gate.rule === 'runtime_critical_fix' ? LEVEL_THRESHOLDS.critical : 0));
    for (const r of postureReasons) r.contribution = postureWeight > 0 && !intr.malware ? round(((tiePoints / 100) * (r.weight * r.value)) / postureWeight) : 0;
    const entityReasons = ent.reasons.map((r, i) => ({ ...r, contribution: i === 0 ? round((1 - signalIntr) * ent.risk) : 0 }));
    const reasons = sortReasons([...intr.reasons.filter((r) => !isPostureReason(r)), ...postureReasons, ...entityReasons]);

    findings.push({
      purl: c.purl,
      score,
      level: levelForScore(score),
      scope,
      gate,
      reasons,
      blastRadius: { assets: inbound.assets, score: round((score / 100) * inbound.weightedExposure, 3) },
      entityChain: ent.chain,
      ...(behind.length ? { behind } : {}),
    });
  }
  findings.sort(compareFindings);
  health.sort((a, b) => scopeTier(a.scope) - scopeTier(b.scope) || b.score - a.score || cmpStr(a.purl, b.purl));

  const warnings: string[] = [];
  if (truncated.length > 0) {
    const shown = truncated.slice(0, 10).join('; ');
    warnings.push(
      `dependency paths truncated for ${truncated.length} asset/component pair(s) (cap ${opts.pathLimits?.maxPathsPerPair ?? PATH_LIMITS.maxPathsPerPair} per pair): ${shown}${truncated.length > 10 ? '; …' : ''}`,
    );
  }
  const outbound = opts.workflows ? scoreOutbound(opts.workflows, opts.outboundDependents ? { dependents: opts.outboundDependents } : {}) : [];
  return { findings, health, outbound, warnings };
}

/** Assemble a ScanResult (schemaVersion '1') from an inventory and scoring output. */
export function buildScanResult(args: {
  target: string;
  inventory: Inventory;
  score: ScoreOutput;
  generatedAt?: string | Date;
  warnings?: readonly string[];
}): ScanResult {
  const g = args.generatedAt ?? new Date();
  const warnings = [...(args.warnings ?? []), ...args.score.warnings];
  const result: ScanResult = {
    schemaVersion: '1',
    target: args.target,
    generatedAt: typeof g === 'string' ? g : g.toISOString(),
    inventory: summarizeInventory(args.inventory),
    findings: [...args.score.findings].sort(compareFindings),
  };
  if (args.score.outbound.length > 0) result.outbound = args.score.outbound;
  if (args.score.health && args.score.health.length > 0) result.health = args.score.health;
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

export { scoreIntrinsic, vulnValue, ownershipDecay, type IntrinsicResult } from './intrinsic.js';
export {
  scoreEntityRisk,
  createLinkPathProvider,
  isLinkUsableForScoring,
  ageDecay,
  hopDecay,
  type EntityPathProvider,
  type EntityPathLike,
  type EntityRiskResult,
  type EntityChainEntry,
} from './entity.js';
export {
  buildDependencyGraph,
  inboundExposure,
  assetWeight,
  reachMultiplier,
  scopeExposure,
  type DependencyGraph,
  type InboundResult,
  type PathLimits,
} from './blast.js';
export { scoreOutbound, scoreWorkflowOutbound, type WorkflowRiskInput, type OutboundOptions } from './outbound.js';
export { incidentsAffecting } from './incidents.js';
export * from './weights.js';
