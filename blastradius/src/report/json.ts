/**
 * JSON report: ScanResult (schemaVersion '1') plus derived, additive per-finding fields that a
 * web UI needs without recomputation (name/version, reach counts, flattened evidence, level counts).
 */
import { parsePurl, type Finding, type RiskLevel, type ScanResult } from '../core/types.js';

export interface FindingReach {
  /** Assets that reach the component. */
  assets: number;
  /** Assets that declare it directly (a path of length 2). */
  directAssets: number;
  /** Dependency paths shown (after per-pair caps). */
  paths: number;
  /** Shortest path length in edges, if any path is known. */
  shortestPath?: number;
}

export interface ReportFinding extends Finding {
  name: string;
  version: string;
  reach: FindingReach;
  /** Union of all reason evidence URLs, sorted. */
  evidence: string[];
}

export interface JsonReport extends Omit<ScanResult, 'findings'> {
  summary: { findings: number; byLevel: Record<RiskLevel, number>; maxScore: number; maxBlastRadius: number };
  findings: ReportFinding[];
}

export function findingReach(f: Finding): FindingReach {
  const all = f.blastRadius.assets.flatMap((a) => a.paths);
  const reach: FindingReach = {
    assets: f.blastRadius.assets.length,
    directAssets: f.blastRadius.assets.filter((a) => a.paths.some((p) => p.length === 2)).length,
    paths: all.length,
  };
  if (all.length > 0) reach.shortestPath = Math.min(...all.map((p) => p.length - 1));
  return reach;
}

export function nameAndVersion(purl: string): { name: string; version: string } {
  try {
    const p = parsePurl(purl);
    return { name: p.namespace ? `${p.namespace}/${p.name}` : p.name, version: p.version ?? '' };
  } catch {
    return { name: purl, version: '' };
  }
}

export function toJsonReport(result: ScanResult): JsonReport {
  const byLevel: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const findings: ReportFinding[] = result.findings.map((f) => {
    byLevel[f.level] += 1;
    return {
      ...f,
      ...nameAndVersion(f.purl),
      reach: findingReach(f),
      evidence: [...new Set(f.reasons.flatMap((r) => r.evidence))].sort(),
    };
  });
  const { findings: _omit, ...rest } = result;
  return {
    ...rest,
    summary: {
      findings: findings.length,
      byLevel,
      maxScore: findings.reduce((m, f) => Math.max(m, f.score), 0),
      maxBlastRadius: findings.reduce((m, f) => Math.max(m, f.blastRadius.score), 0),
    },
    findings,
  };
}

export function renderJson(result: ScanResult): string {
  return `${JSON.stringify(toJsonReport(result), null, 2)}\n`;
}
