/**
 * Which packages to read first when a per-scan cap applies (Tier 0, teardown problem 5).
 *
 * The git-history and GitHub enrichers read at most N repositories per scan. They used to take the
 * first N repository URLs in alphabetical order, so parse-server read 3rd-eden/enabled through
 * isaacs/rimraf and left mongodb, ws, lodash, redis and semver unread. The order is now:
 *   1. direct runtime dependencies (declared by an asset with scope runtime),
 *   2. other production dependencies, by production fan-in (how many production dependents reach them),
 *   3. everything else (dev, build), by fan-in;
 * ties by name, so the selection is deterministic.
 */
import { unversionedPurl, type Inventory, type PurlString } from '../core/types.js';
import { productionComponents } from './production.js';

export interface PackagePriority {
  /** 0 direct runtime, 1 other production, 2 the rest. */
  tier: 0 | 1 | 2;
  /** Production dependents (components and assets) of any version of the package. */
  fanIn: number;
  direct: boolean;
  production: boolean;
}

/** Priority of every package in the inventory, keyed by unversioned purl. */
export function packagePriorities(inv: Inventory): Map<PurlString, PackagePriority> {
  const prod = productionComponents(inv);
  const assets = new Set(inv.assets.map((a) => a.id));
  const fan = new Map<PurlString, Set<string>>();
  const direct = new Set<PurlString>();
  for (const e of inv.edges) {
    const to = unversionedPurl(e.to);
    if (assets.has(e.from) && e.scope === 'runtime') direct.add(to);
    // Production fan-in: edges into a production component from a production component or an asset.
    if (!prod.has(e.to) || e.scope === 'dev' || e.scope === 'build') continue;
    if (!assets.has(e.from) && !prod.has(e.from as PurlString)) continue;
    let s = fan.get(to);
    if (!s) fan.set(to, (s = new Set()));
    s.add(assets.has(e.from) ? e.from : unversionedPurl(e.from as PurlString));
  }
  const out = new Map<PurlString, PackagePriority>();
  for (const c of inv.components) {
    const key = unversionedPurl(c.purl);
    const isProd = prod.has(c.purl) || (out.get(key)?.production ?? false);
    const d = direct.has(key);
    out.set(key, { tier: d ? 0 : isProd ? 1 : 2, fanIn: fan.get(key)?.size ?? 0, direct: d, production: isProd });
  }
  return out;
}

const LOWEST: PackagePriority = { tier: 2, fanIn: 0, direct: false, production: false };

export function comparePriority(a: PackagePriority, b: PackagePriority): number {
  return a.tier - b.tier || b.fanIn - a.fanIn;
}

/** The best priority among `subjects` (a repository serving several packages takes its best one). */
export function bestPriority(prio: ReadonlyMap<PurlString, PackagePriority>, subjects: Iterable<PurlString>): PackagePriority {
  let best = LOWEST;
  for (const s of subjects) {
    const p = prio.get(unversionedPurl(s));
    if (p && comparePriority(p, best) < 0) best = p;
  }
  return best;
}

/** Repository keys in priority order (then by key). */
export function orderRepos(byRepo: ReadonlyMap<string, Iterable<PurlString>>, inv: Inventory): string[] {
  const prio = packagePriorities(inv);
  const best = new Map([...byRepo].map(([k, subjects]) => [k, bestPriority(prio, subjects)]));
  return [...byRepo.keys()].sort((a, b) => comparePriority(best.get(a)!, best.get(b)!) || (a < b ? -1 : a > b ? 1 : 0));
}
