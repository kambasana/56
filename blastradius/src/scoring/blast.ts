/**
 * Inbound blast radius (PLAN §3.6 step 4):
 *
 *   blast_in(p) = risk(p) · Σ over assets a reaching p of
 *                 exposure(scope of best path) · reach_multiplier · criticality(a)/5 · environment(a)
 *
 * - The scope exposure of a path is the minimum over its edges (a runtime dep of a dev dep is dev);
 *   an asset's exposure uses the best (widest) path, computed exactly, independent of path caps.
 * - A component with an install script gets at least INSTALL_SCRIPT_EXPOSURE (it runs on install).
 * - Displayed paths are enumerated shortest-first, cycle-safe, capped per (asset, component) pair.
 */
import type { Asset, AssetExposure, Component, DepScope, Inventory } from '../core/types.js';
import { assetComponentScopes, assetScopeCap, edgeScope, scopeStrength, strongerScope, weakerScope, type ComponentScope } from '../core/scope.js';
import { ENVIRONMENT_WEIGHT, INSTALL_SCRIPT_EXPOSURE, PATH_LIMITS, REACH_MULTIPLIER, SCOPE_EXPOSURE } from './weights.js';
import { cmpStr, round } from './util.js';

export interface PathLimits {
  maxPathsPerPair: number;
  maxDepth: number;
  maxStepsPerPair: number;
}

interface Edge {
  other: string;
  exposure: number;
  scope: DepScope;
  /** Strongest project scope among the edges of this pair (src/core/scope.ts). */
  cscope: ComponentScope;
}

export interface DependencyGraph {
  assets: Map<string, Asset>;
  components: Map<string, Component>;
  /** from → edges (deduplicated per pair, keeping the highest-exposure scope), sorted by target. */
  out: Map<string, Edge[]>;
  /** to → reverse edges. */
  in: Map<string, Edge[]>;
  /** Scope of each asset's best path to each component it reaches (src/core/scope.ts). */
  scopes: Map<string, Map<string, ComponentScope>>;
}

export function scopeExposure(scope: DepScope): number {
  return SCOPE_EXPOSURE[scope] ?? SCOPE_EXPOSURE.runtime;
}

export function buildDependencyGraph(inv: Inventory): DependencyGraph {
  const best = new Map<string, { from: string; to: string; scope: DepScope; exposure: number; cscope: ComponentScope }>();
  for (const e of inv.edges) {
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || e.from === e.to) continue;
    const exposure = scopeExposure(e.scope);
    const key = `${e.from}\u0000${e.to}`;
    const prev = best.get(key);
    const cscope = prev ? strongerScope(prev.cscope, edgeScope(e.scope)) : edgeScope(e.scope);
    if (!prev || exposure > prev.exposure) best.set(key, { from: e.from, to: e.to, scope: e.scope, exposure, cscope });
    else prev.cscope = cscope;
  }
  const out = new Map<string, Edge[]>();
  const inn = new Map<string, Edge[]>();
  for (const e of best.values()) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push({ other: e.to, exposure: e.exposure, scope: e.scope, cscope: e.cscope });
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push({ other: e.from, exposure: e.exposure, scope: e.scope, cscope: e.cscope });
  }
  for (const list of [...out.values(), ...inn.values()]) list.sort((a, b) => cmpStr(a.other, b.other));
  return {
    assets: new Map(inv.assets.map((a) => [a.id, a])),
    components: new Map(inv.components.map((c) => [c.purl, c])),
    out,
    in: inn,
    scopes: assetComponentScopes(inv),
  };
}

/** Shortest distance (edges) from every node that reaches `target`, optionally through edges at least as strong as `minScope`. */
function distancesTo(g: DependencyGraph, target: string, minScope?: ComponentScope): Map<string, number> {
  const dist = new Map<string, number>([[target, 0]]);
  const min = minScope ? scopeStrength(minScope) : -1;
  let frontier = [target];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const n of frontier) {
      const d = dist.get(n)!;
      for (const e of g.in.get(n) ?? []) {
        if (dist.has(e.other) || scopeStrength(e.cscope) < min) continue;
        dist.set(e.other, d + 1);
        next.push(e.other);
      }
    }
    frontier = next;
  }
  return dist;
}

/** Widest path (max over paths of min edge exposure) from every node to `target`. */
function widestTo(g: DependencyGraph, target: string): Map<string, number> {
  const levels = [...new Set(Object.values(SCOPE_EXPOSURE))].sort((a, b) => b - a);
  const width = new Map<string, number>();
  for (const level of levels) {
    const seen = new Set([target]);
    let frontier = [target];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const n of frontier)
        for (const e of g.in.get(n) ?? []) {
          if (e.exposure < level || seen.has(e.other)) continue;
          seen.add(e.other);
          next.push(e.other);
          if (!width.has(e.other)) width.set(e.other, level);
        }
      frontier = next;
    }
  }
  return width;
}

/** Enumerate up to `maxPathsPerPair` simple paths asset → target, shortest first. */
function enumeratePaths(
  g: DependencyGraph,
  assetId: string,
  target: string,
  dist: Map<string, number>,
  limits: PathLimits,
  minScope?: ComponentScope,
): { paths: string[][]; truncated: boolean } {
  const min = minScope ? scopeStrength(minScope) : -1;
  const paths: string[][] = [];
  let steps = 0;
  let truncated = false;
  const path = [assetId];
  const onPath = new Set(path);
  const visit = (node: string): void => {
    if (truncated) return;
    if (node === target) {
      if (paths.length >= limits.maxPathsPerPair) truncated = true;
      else paths.push([...path]);
      return;
    }
    if (++steps > limits.maxStepsPerPair) {
      truncated = true;
      return;
    }
    const nexts = (g.out.get(node) ?? [])
      .filter((e) => scopeStrength(e.cscope) >= min && dist.has(e.other) && !onPath.has(e.other) && path.length + dist.get(e.other)! <= limits.maxDepth)
      .sort((a, b) => dist.get(a.other)! - dist.get(b.other)! || cmpStr(a.other, b.other));
    for (const e of nexts) {
      onPath.add(e.other);
      path.push(e.other);
      visit(e.other);
      path.pop();
      onPath.delete(e.other);
      if (truncated) return;
    }
  };
  visit(assetId);
  // Shortest first, then lexicographic, for deterministic output.
  paths.sort((a, b) => a.length - b.length || cmpStr(a.join('\u0000'), b.join('\u0000')));
  return { paths, truncated };
}

export function assetWeight(asset: Asset): number {
  const crit = Math.min(5, Math.max(1, Number(asset.criticality) || 3));
  return (crit / 5) * (ENVIRONMENT_WEIGHT[asset.environment] ?? 1);
}

export function reachMultiplier(asset: Asset, component: Component | undefined): number {
  let m = 1;
  if (asset.kind === 'workflow' && asset.ci && (asset.ci.hasWriteTokens || asset.ci.hasOidc || asset.ci.publishes))
    m *= REACH_MULTIPLIER.privilegedCi;
  if (component?.pinning === 'sha' || component?.pinning === 'digest') m *= REACH_MULTIPLIER.pinnedByHash;
  return m;
}

export interface InboundResult {
  assets: AssetExposure[];
  /** Σ exposure · criticality/5 · environment (multiply by risk for the blast score). */
  weightedExposure: number;
  /** Pairs whose displayed paths were capped. */
  truncated: { assetId: string; purl: string }[];
}

export function inboundExposure(
  g: DependencyGraph,
  purl: string,
  opts: { hasInstallScript?: boolean; limits?: Partial<PathLimits> } = {},
): InboundResult {
  const limits: PathLimits = { ...PATH_LIMITS, ...(opts.limits ?? {}) };
  const component = g.components.get(purl);
  const dist = distancesTo(g, purl);
  const width = widestTo(g, purl);
  const assets: AssetExposure[] = [];
  const truncated: InboundResult['truncated'] = [];
  let weighted = 0;
  const assetIds = [...dist.keys()].filter((id) => g.assets.has(id)).sort(cmpStr);
  for (const assetId of assetIds) {
    const asset = g.assets.get(assetId)!;
    let scope = width.get(assetId) ?? 0;
    if (opts.hasInstallScript) scope = Math.max(scope, INSTALL_SCRIPT_EXPOSURE);
    const exposure = scope * reachMultiplier(asset, component);
    const best = g.scopes.get(assetId)?.get(purl) ?? 'unreachable';
    // The strongest paths first (a runtime path is never hidden behind shorter dev paths by the
    // per-pair cap), then fill the remaining slots with the shortest paths of any scope.
    const strong = best === 'unreachable' ? { paths: [], truncated: false } : enumeratePaths(g, assetId, purl, distancesTo(g, purl, best), limits, best);
    const rest = enumeratePaths(g, assetId, purl, dist, limits);
    const seen = new Set<string>();
    const merged: { nodes: string[]; scope: ComponentScope }[] = [];
    for (const nodes of [...strong.paths, ...rest.paths]) {
      const key = nodes.join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ nodes, scope: scopeOfPath(g, asset, nodes) });
    }
    merged.sort((a, b) => scopeStrength(b.scope) - scopeStrength(a.scope) || a.nodes.length - b.nodes.length || cmpStr(a.nodes.join('\u0000'), b.nodes.join('\u0000')));
    const kept = merged.slice(0, limits.maxPathsPerPair);
    if (strong.truncated || rest.truncated || merged.length > kept.length) truncated.push({ assetId, purl });
    assets.push({ assetId, exposure: round(exposure), paths: kept.map((p) => p.nodes), scope: best, pathScopes: kept.map((p) => p.scope) });
    weighted += exposure * assetWeight(asset);
  }
  return { assets, weightedExposure: weighted, truncated };
}

/** Scope of one displayed path: the asset's cap and every edge on the way. */
export function scopeOfPath(g: DependencyGraph, asset: Asset | undefined, nodes: readonly string[]): ComponentScope {
  let s = assetScopeCap(asset);
  for (let i = 1; i < nodes.length; i++) {
    const e = g.out.get(nodes[i - 1]!)?.find((x) => x.other === nodes[i]);
    s = weakerScope(s, e ? e.cscope : 'runtime');
  }
  return s;
}
