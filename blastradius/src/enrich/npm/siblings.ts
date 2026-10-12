/**
 * Maintainer additions that are a team event, not a new person (Tier 0, teardown problem 4).
 *
 * parse-server had 8 MEDIUM findings from one benign event: one npm account added to @npmcli/arborist,
 * @npmcli/config, libnpmdiff, npm and others, all from the npm/cli repository. An added account that
 * already maintains a sibling package in this scan (same npm scope, or the same source repository)
 * is marked `sibling` and is not scored (src/scoring/intrinsic.ts). Package names and npm handles are
 * public registry data.
 */
import { npmNameFromPurl, parsePurl, unversionedPurl, type Fact, type PurlString } from '../../core/types.js';

const scopeOf = (name: string) => (/^(@[^/]+)\//.exec(name)?.[1]);

export function markSiblingMaintainers(facts: Fact[]): number {
  const maint = new Map<PurlString, Set<string>>();
  const repo = new Map<PurlString, string>();
  const name = new Map<PurlString, string>();
  for (const f of facts) {
    const key = unversionedPurl(f.subject);
    if (f.kind === 'maintainers' && !maint.has(key)) maint.set(key, new Set(f.value.maintainers.map((m) => m.name)));
    if (f.kind === 'repo' && !repo.has(key)) repo.set(key, f.value.url.toLowerCase());
    if (!name.has(key)) {
      const p = parsePurl(key);
      if (p.type === 'npm') name.set(key, npmNameFromPurl(p));
    }
  }
  let marked = 0;
  for (const f of facts) {
    if (f.kind !== 'maintainer_change' || f.value.added.length === 0) continue;
    const self = unversionedPurl(f.subject);
    const n = name.get(self);
    const scope = n ? scopeOf(n) : undefined;
    const r = repo.get(self);
    const siblings = [...maint.keys()].filter((k) => k !== self && ((scope && name.get(k) && scopeOf(name.get(k)!) === scope) || (r && repo.get(k) === r)));
    const via = siblings.filter((k) => f.value.added.every((a) => maint.get(k)!.has(a)));
    if (via.length === 0) continue;
    f.value.sibling = { packages: via.length, by: scope && via.some((k) => scopeOf(name.get(k) ?? '') === scope) ? 'scope' : 'repository' };
    marked++;
  }
  return marked;
}
