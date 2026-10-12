/**
 * One dependency scope per (project, package), computed once from the lockfile graph
 * (docs/WHO-BEHIND-PLAN.md, Tier 0). Every view reads it: findings, SARIF, the SBOM, exposure
 * search, package reach and the stability labels' production flag.
 *
 * The scope of one dependency path is its weakest link: the asset's own environment (a repo in
 * `test/` or `examples/` is dev, a workflow is CI) and every edge on the way (a runtime dependency
 * of a dev dependency is dev). The scope of a package is the strongest scope over all its paths,
 * so a package that is both a runtime and a dev dependency is runtime.
 *
 * Strength, strongest first: runtime > peer > optional > ci > dev > unreachable.
 *
 * - runtime: shipped and loaded in production (the only scope that counts as "production").
 * - peer: only reached as a peer dependency (the consumer provides it).
 * - optional: only reached through optional dependencies (e.g. fsevents on macOS).
 * - ci: the build environment: GitHub Actions, Docker build stages.
 * - dev: tests, linters, bundlers: only reached through dev dependencies or dev/test projects.
 * - unreachable: in a lockfile, but no path from any asset reaches it.
 *
 * Pure and deterministic. Nothing here reads the network or the file system.
 */
import type { Asset, DepEdge, DepScope, Inventory, PurlString } from './types.js';

export const COMPONENT_SCOPES = ['runtime', 'peer', 'optional', 'ci', 'dev', 'unreachable'] as const;
export type ComponentScope = (typeof COMPONENT_SCOPES)[number];

/** Strength: higher is closer to production. */
const STRENGTH: Readonly<Record<ComponentScope, number>> = Object.freeze({ runtime: 5, peer: 4, optional: 3, ci: 2, dev: 1, unreachable: 0 });

/** Sort tier for production-first views: 0 = runtime first, 5 = unreachable last. */
export function scopeTier(scope: ComponentScope | undefined): number {
  // Results stored before scopes existed have none: keep them where they were (first tier).
  return scope === undefined ? 0 : 5 - STRENGTH[scope];
}

export function scopeStrength(scope: ComponentScope): number {
  return STRENGTH[scope];
}

/** The stronger of two scopes. */
export function strongerScope(a: ComponentScope, b: ComponentScope): ComponentScope {
  return STRENGTH[a] >= STRENGTH[b] ? a : b;
}

/** The weaker of two scopes (a path is as weak as its weakest link). */
export function weakerScope(a: ComponentScope, b: ComponentScope): ComponentScope {
  return STRENGTH[a] <= STRENGTH[b] ? a : b;
}

/** Only runtime is production. Optional and peer dependencies are reported as such, never as production. */
export function isProductionScope(scope: ComponentScope | undefined): boolean {
  return scope === 'runtime';
}

export function isComponentScope(v: unknown): v is ComponentScope {
  return typeof v === 'string' && (COMPONENT_SCOPES as readonly string[]).includes(v);
}

/** Display labels (CLI, HTML, web). */
export const SCOPE_LABEL: Readonly<Record<ComponentScope, string>> = Object.freeze({
  runtime: 'runtime',
  peer: 'peer',
  optional: 'optional',
  ci: 'CI / build',
  dev: 'dev / test',
  unreachable: 'not reached',
});

/** Scope of one edge. Workflow actions and Docker build stages are `build` edges: the CI scope. */
export function edgeScope(scope: DepScope): ComponentScope {
  switch (scope) {
    case 'runtime':
      return 'runtime';
    case 'peer':
      return 'peer';
    case 'optional':
      return 'optional';
    case 'build':
      return 'ci';
    case 'dev':
      return 'dev';
    default:
      return 'runtime';
  }
}

/** The strongest scope any path starting at this asset can have. */
export function assetScopeCap(asset: Pick<Asset, 'kind' | 'environment'> | undefined): ComponentScope {
  if (!asset) return 'runtime';
  if (asset.kind === 'workflow' || asset.environment === 'ci') return 'ci';
  if (asset.environment === 'dev') return 'dev';
  return 'runtime';
}

/** Scope of a path [assetId, purl, ..., purl] given its edge scopes. */
export function pathScope(asset: Pick<Asset, 'kind' | 'environment'> | undefined, edgeScopes: readonly DepScope[]): ComponentScope {
  let s = assetScopeCap(asset);
  for (const e of edgeScopes) s = weakerScope(s, edgeScope(e));
  return s;
}

type ScopeInventory = Pick<Inventory, 'assets' | 'edges'> & { components?: Inventory['components'] };

/**
 * Strongest scope per (asset, component): for every asset, the scope of its best path to each
 * component it reaches. Computed with one breadth-first pass per strength level, so the cost is
 * O(levels × edges) per asset.
 */
export function assetComponentScopes(inv: ScopeInventory): Map<string, Map<PurlString, ComponentScope>> {
  const out = new Map<string, DepEdgeLite[]>();
  for (const e of inv.edges) {
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || e.from === e.to) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push({ to: e.to, scope: edgeScope(e.scope) });
  }
  const levels = [...COMPONENT_SCOPES].filter((s) => s !== 'unreachable');
  const result = new Map<string, Map<PurlString, ComponentScope>>();
  for (const asset of inv.assets) {
    const cap = assetScopeCap(asset);
    const scopes = new Map<PurlString, ComponentScope>();
    for (const level of levels) {
      if (STRENGTH[level] > STRENGTH[cap]) continue;
      // Every node reachable from the asset through edges at least as strong as `level`.
      const seen = new Set<string>([asset.id]);
      const queue = [asset.id];
      while (queue.length > 0) {
        const n = queue.pop()!;
        for (const e of out.get(n) ?? []) {
          if (STRENGTH[e.scope] < STRENGTH[level] || seen.has(e.to)) continue;
          seen.add(e.to);
          queue.push(e.to);
          if (!scopes.has(e.to)) scopes.set(e.to, level);
        }
      }
    }
    result.set(asset.id, scopes);
  }
  return result;
}

interface DepEdgeLite {
  to: string;
  scope: ComponentScope;
}

/**
 * The one scope per component of this project: the strongest over every asset. Components no
 * asset reaches are `unreachable`.
 */
export function componentScopes(inv: ScopeInventory): Map<PurlString, ComponentScope> {
  const scopes = new Map<PurlString, ComponentScope>();
  for (const perAsset of assetComponentScopes(inv).values()) {
    for (const [purl, s] of perAsset) {
      const prev = scopes.get(purl);
      scopes.set(purl, prev ? strongerScope(prev, s) : s);
    }
  }
  const assetIds = new Set(inv.assets.map((a) => a.id));
  for (const c of inv.components ?? []) if (!scopes.has(c.purl)) scopes.set(c.purl, 'unreachable');
  // Edge endpoints that are components but missing from `components` (partial inventories).
  for (const e of inv.edges as readonly DepEdge[]) if (!assetIds.has(e.to) && !scopes.has(e.to)) scopes.set(e.to, 'unreachable');
  return scopes;
}

/** Components whose scope is runtime: the production set (stability labels, roll-ups). */
export function productionSet(inv: ScopeInventory): Set<PurlString> {
  const out = new Set<PurlString>();
  for (const [purl, s] of componentScopes(inv)) if (isProductionScope(s)) out.add(purl);
  return out;
}

/** Count components per scope. */
export function countScopes(scopes: ReadonlyMap<PurlString, ComponentScope>): Partial<Record<ComponentScope, number>> {
  const out: Partial<Record<ComponentScope, number>> = {};
  for (const s of scopes.values()) out[s] = (out[s] ?? 0) + 1;
  return out;
}
