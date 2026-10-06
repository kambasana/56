/**
 * Scoring engine (PLAN §3.6): intrinsic + entity risk → combined risk → inbound blast radius,
 * plus outbound blast radius for workflows. Output ordering is deterministic.
 */
import {
  levelForScore,
  summarizeInventory,
  type EntityLink,
  type Fact,
  type Finding,
  type Incident,
  type Inventory,
  type OutboundFinding,
  type ScanResult,
} from '../core/types.js';
import { scoreIntrinsic } from './intrinsic.js';
import { createLinkPathProvider, scoreEntityRisk, type EntityPathProvider } from './entity.js';
import { buildDependencyGraph, inboundExposure, type PathLimits } from './blast.js';
import { scoreOutbound, type WorkflowRiskInput } from './outbound.js';
import { PATH_LIMITS, type FactorWeights } from './weights.js';
import { clamp01, cmpStr, round, sortReasons } from './util.js';

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
}

export interface ScoreOutput {
  findings: Finding[];
  outbound: OutboundFinding[];
  warnings: string[];
}

export function compareFindings(a: Finding, b: Finding): number {
  return b.score - a.score || b.blastRadius.score - a.blastRadius.score || cmpStr(a.purl, b.purl);
}

export function scoreInventory(inv: Inventory, facts: readonly Fact[], opts: ScoreOptions): ScoreOutput {
  const incidents = opts.incidents ?? [];
  const paths = opts.entityPaths ?? (opts.links ? createLinkPathProvider(opts.links, incidents) : undefined);
  const graph = buildDependencyGraph(inv);
  const minScore = opts.minScore ?? 0;
  const findings: Finding[] = [];
  const truncated: string[] = [];

  const components = [...inv.components].sort((a, b) => cmpStr(a.purl, b.purl));
  const seen = new Set<string>();
  for (const c of components) {
    if (seen.has(c.purl)) continue;
    seen.add(c.purl);
    const intr = scoreIntrinsic(c, facts, { now: opts.now, incidents, ...(opts.weights ? { weights: opts.weights } : {}) });
    const ent = scoreEntityRisk(c, { now: opts.now, incidents, ...(paths ? { paths } : {}) });
    const risk = clamp01(1 - (1 - intr.intrinsic) * (1 - ent.risk));
    const score = round(risk * 100, 1);
    if (!(score > minScore)) continue;

    const entityReasons = ent.reasons.map((r, i) => ({ ...r, contribution: i === 0 ? round((1 - intr.intrinsic) * ent.risk) : 0 }));
    const hasInstallScript = intr.reasons.some((r) => r.factor === 'install_script');
    const inbound = inboundExposure(graph, c.purl, { hasInstallScript, ...(opts.pathLimits ? { limits: opts.pathLimits } : {}) });
    for (const t of inbound.truncated) truncated.push(`${t.assetId} → ${t.purl}`);

    findings.push({
      purl: c.purl,
      score,
      level: levelForScore(score),
      reasons: sortReasons([...intr.reasons, ...entityReasons]),
      blastRadius: { assets: inbound.assets, score: round(risk * inbound.weightedExposure, 3) },
      entityChain: ent.chain,
    });
  }
  findings.sort(compareFindings);

  const warnings: string[] = [];
  if (truncated.length > 0) {
    const shown = truncated.slice(0, 10).join('; ');
    warnings.push(
      `dependency paths truncated for ${truncated.length} asset/component pair(s) (cap ${opts.pathLimits?.maxPathsPerPair ?? PATH_LIMITS.maxPathsPerPair} per pair): ${shown}${truncated.length > 10 ? '; …' : ''}`,
    );
  }
  const outbound = opts.workflows ? scoreOutbound(opts.workflows, opts.outboundDependents ? { dependents: opts.outboundDependents } : {}) : [];
  return { findings, outbound, warnings };
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
