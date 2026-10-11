/**
 * Which components are production dependencies: reached from an asset through dependency edges
 * that are all runtime, optional or peer (not dev or build). Plan §4: "S3 ended while a production
 * dependency" and the roll-up count production dependencies only by default.
 */
import type { DepScope, Inventory, PurlString } from '../core/types.js';

const PRODUCTION_SCOPES: ReadonlySet<DepScope> = new Set(['runtime', 'optional', 'peer']);

export function productionComponents(inv: Inventory): Set<PurlString> {
  const assets = new Set(inv.assets.map((a) => a.id));
  const out = new Map<string, string[]>();
  for (const e of inv.edges) {
    if (!PRODUCTION_SCOPES.has(e.scope)) continue;
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const e of inv.edges) if (assets.has(e.from) && PRODUCTION_SCOPES.has(e.scope) && !seen.has(e.to)) (seen.add(e.to), queue.push(e.to));
  while (queue.length > 0) {
    const n = queue.pop()!;
    for (const to of out.get(n) ?? []) if (!seen.has(to)) (seen.add(to), queue.push(to));
  }
  return seen as Set<PurlString>;
}
