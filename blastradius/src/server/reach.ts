/**
 * Dependency paths to one package in a stored inventory, with the scope of every edge, for the
 * package reach page (path tree, Sankey) and the incident "brought in by" column. Pure.
 */
import { parsePurl, type DepScope, type Inventory } from '../core/types.js';
import { buildDependencyGraph, inboundExposure, type DependencyGraph } from '../scoring/blast.js';
import { isProductionScope, pathScope, scopeStrength, type ComponentScope } from '../core/scope.js';

export interface InventoryPath {
  assetId: string;
  assetName: string;
  environment: 'prod' | 'staging' | 'dev' | 'ci';
  production: boolean;
  /** Scope of this path (src/core/scope.ts). */
  scope: ComponentScope;
  /** [assetId, purl, ..., target purl] */
  nodes: string[];
  scopes: DepScope[];
}

/** "pkg:npm/%40a/b@1.0.0" → { name: "@a/b", version: "1.0.0" } for any purl type, else null. */
export function purlNameVersion(purl: string): { type: string; name: string; version: string } | null {
  try {
    const p = parsePurl(purl);
    return { type: p.type, name: p.namespace ? `${p.namespace}/${p.name}` : p.name, version: p.version ?? '' };
  } catch {
    return null;
  }
}

/** Package name of a purl ("@a/b"), or null when it does not parse. */
export function purlName(purl: string): string | null {
  return purlNameVersion(purl)?.name ?? null;
}

/** "pkg:npm/%40a/b@1.0.0" → "@a/b@1.0.0" (anything unparsable is returned as is). */
export function purlLabel(purl: string): string {
  const nv = purlNameVersion(purl);
  if (!nv) return purl;
  return nv.version ? `${nv.name}@${nv.version}` : nv.name;
}

/** "pkg:npm/x@1" → { name, version } for npm purls, else null. */
export function npmNameVersion(purl: string): { name: string; version: string } | null {
  const nv = purlNameVersion(purl);
  return nv && nv.type === 'npm' ? { name: nv.name, version: nv.version } : null;
}

function edgeScope(g: DependencyGraph, from: string, to: string): DepScope {
  const e = g.out.get(from)?.find((x) => x.other === to);
  if (!e) return 'runtime';
  // The strongest scope of the pair (a package both optional and dev here counts as optional).
  return SCOPE_TO_DEP[e.cscope] ?? e.scope;
}

const SCOPE_TO_DEP: Partial<Record<ComponentScope, DepScope>> = { runtime: 'runtime', peer: 'peer', optional: 'optional', ci: 'build', dev: 'dev' };

/** Every displayed path (engine caps apply) from the inventory's assets to `purl`. */
export function pathsTo(inv: Inventory, purl: string, graph: DependencyGraph = buildDependencyGraph(inv)): InventoryPath[] {
  const out: InventoryPath[] = [];
  for (const a of inboundExposure(graph, purl).assets) {
    const asset = graph.assets.get(a.assetId);
    for (const nodes of a.paths) {
      const scopes = nodes.slice(1).map((to, i) => edgeScope(graph, nodes[i]!, to));
      // One scope rule for every view (src/core/scope.ts): production = a runtime path from a production asset.
      const scope = pathScope(asset, scopes);
      out.push({
        assetId: a.assetId,
        assetName: asset?.name ?? a.assetId,
        environment: asset?.environment ?? 'dev',
        production: asset?.environment === 'prod' && isProductionScope(scope),
        scope,
        nodes,
        scopes,
      });
    }
  }
  return out.sort((x, y) => Number(y.production) - Number(x.production) || scopeStrength(y.scope) - scopeStrength(x.scope) || x.nodes.length - y.nodes.length || x.assetName.localeCompare(y.assetName));
}

/** The direct dependency each path starts with, or "(direct)" when the package itself is direct. */
export function viaOf(p: Pick<InventoryPath, 'nodes'>): string {
  return p.nodes.length > 2 ? purlLabel(p.nodes[1]!) : '(direct)';
}
