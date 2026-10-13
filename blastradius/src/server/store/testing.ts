/**
 * Builders for synthetic engine results, for store and server tests. No I/O.
 */
import type { Asset, Finding, Inventory, Reason, RiskLevel, ScanResult } from '../../core/types.js';
import { levelForScore, npmPurl } from '../../core/types.js';

export interface FindingSpec {
  name: string;
  version?: string;
  score: number;
  level?: RiskLevel;
  factors?: string[];
  /** assetId -> exposure (one path each). */
  assets?: Record<string, number>;
  incident?: string;
}

export function makeFinding(spec: FindingSpec): Finding {
  const purl = npmPurl(spec.name, spec.version ?? '1.0.0');
  const reasons: Reason[] = (spec.factors ?? ['vuln']).map((factor, i) => ({
    factor,
    value: 1,
    weight: 1,
    contribution: 0.5 / (i + 1),
    detail: `${factor} detail for ${spec.name}`,
    evidence: [`https://example.test/${factor}`],
  }));
  const assets = Object.entries(spec.assets ?? { 'repo:app': 1 }).map(([assetId, exposure]) => ({
    assetId,
    exposure,
    paths: [[assetId, purl]],
  }));
  return {
    purl,
    score: spec.score,
    level: spec.level ?? levelForScore(spec.score),
    reasons,
    blastRadius: { assets, score: assets.reduce((n, a) => n + a.exposure, 0) * spec.score },
    entityChain: spec.incident
      ? [{ from: npmPurl(spec.name), entityId: spec.incident, relation: 'incident', confidence: 1, evidence: ['https://example.test/inc'], method: 'deterministic', reviewed: true }]
      : [],
  };
}

export function makeResult(findings: FindingSpec[], target = '/tmp/app'): ScanResult {
  const fs = findings.map(makeFinding).sort((a, b) => b.score - a.score);
  return {
    schemaVersion: '1',
    target,
    generatedAt: '2026-01-01T00:00:00.000Z',
    inventory: { assets: 2, components: fs.length, edges: fs.length, directComponents: fs.length, byEcosystem: { npm: fs.length }, byScope: { runtime: fs.length }, withInstallScripts: 0 },
    findings: fs,
    outbound: [],
    warnings: [],
  };
}

export const TEST_ASSETS: Asset[] = [
  { id: 'repo:app', kind: 'repo', name: 'app', environment: 'prod', criticality: 5, sourceFile: 'package.json' },
  { id: 'workflow:.github/workflows/ci.yml', kind: 'workflow', name: 'ci', environment: 'ci', criticality: 3, sourceFile: '.github/workflows/ci.yml' },
];

export function makeInventory(assets: Asset[] = TEST_ASSETS): Inventory {
  return { assets, components: [], edges: [] };
}

/** Deterministic clock: each call advances one second from `start`. */
export function steppingClock(start = '2026-01-01T00:00:00.000Z'): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}
