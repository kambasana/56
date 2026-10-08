/**
 * Dependency paths to one package in a stored inventory, with the scope of every edge, for the
 * package reach page (path tree, Sankey) and the incident "brought in by" column. Pure.
 */
import { parsePurl, type DepScope, type Inventory } from '../core/types.js';
import { buildDependencyGraph, inboundExposure, scopeExposure, type DependencyGraph } from '../scoring/blast.js';

/** Below this a path only comes through dev or optional dependencies (as in report/reach.ts). */
const DEV_EXPOSURE = 0.5;

export interface InventoryPath {
  assetId: string;
  assetName: string;
  environment: 'prod' | 'staging' | 'dev' | 'ci';
  production: boolean;
  /** [assetId, purl, ..., target purl] */
  nodes: string[];
  scopes: DepScope[];
}

/** "pkg:npm/%40a/b@1.0.0" → "@a/b@1.0.0" (anything unparsable is returned as is). */
export function purlLabel(purl: string): string {
  try {
    const p = parsePurl(purl);
    const name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
    return p.version ? `${name}@${p.version}` : name;
  } catch {
    return purl;
  }
}

/** "pkg:npm/x@1" → { name, version } for npm purls, else null. */
export function npmNameVersion(purl: string): { name: string; version: string } | null {
  try {
    const p = parsePurl(purl);
    if (p.type !== 'npm') return null;
    return { name: p.namespace ? `${p.namespace}/${p.name}` : p.name, version: p.version ?? '' };
  } catch {
    return null;
  }
}

function edgeScope(g: DependencyGraph, from: string, to: string): DepScope {
  return g.out.get(from)?.find((e) => e.other === to)?.scope ?? 'runtime';
}

/** Every displayed path (engine caps apply) from the inventory's assets to `purl`. */
export function pathsTo(inv: Inventory, purl: string, graph: DependencyGraph = buildDependencyGraph(inv)): InventoryPath[] {
  const out: InventoryPath[] = [];
  for (const a of inboundExposure(graph, purl).assets) {
    const asset = graph.assets.get(a.assetId);
    for (const nodes of a.paths) {
      const scopes = nodes.slice(1).map((to, i) => edgeScope(graph, nodes[i]!, to));
      const width = Math.min(...scopes.map(scopeExposure));
      out.push({
        assetId: a.assetId,
        assetName: asset?.name ?? a.assetId,
        environment: asset?.environment ?? 'dev',
        production: asset?.environment === 'prod' && width >= DEV_EXPOSURE,
        nodes,
        scopes,
      });
    }
  }
  return out.sort((x, y) => Number(y.production) - Number(x.production) || x.nodes.length - y.nodes.length || x.assetName.localeCompare(y.assetName));
}

/** The direct dependency each path starts with, or "(direct)" when the package itself is direct. */
export function viaOf(p: Pick<InventoryPath, 'nodes'>): string {
  return p.nodes.length > 2 ? purlLabel(p.nodes[1]!) : '(direct)';
}
