/**
 * Maintainer and publisher changes that are a team event, not a new person (Tier 0, teardown
 * problem 4; Tier 0.5 adds the repository owner and the publish record).
 *
 * parse-server had 8 MEDIUM findings from one benign event: one npm account added to @npmcli/arborist,
 * @npmcli/config, libnpmdiff, npm and others, all from the npm/cli repository. superset's #1 was
 * proxy-addr "added ulisesgascon": he maintains forwarded, negotiator and the other jshttp / expressjs
 * packages. An added account (or a new publisher) that already maintains or published a sibling
 * package in this scan (same npm scope, the same source repository, or the same repository owner)
 * is marked `sibling` and is context only (src/scoring/intrinsic.ts). The stability stream applies
 * the same rule to release publishers (src/enrich/history). Package names and npm handles are
 * public registry data.
 */
import { npmNameFromPurl, parsePurl, unversionedPurl, type Fact, type PurlString } from '../../core/types.js';

const scopeOf = (name: string) => /^(@[^/]+)\//.exec(name)?.[1];
/** "github.com/owner" of a repository URL, lower case. */
const ownerKey = (url: string) => /^https?:\/\/([^/]+\/[^/]+)\//.exec(`${url.toLowerCase().replace(/\/+$/, '')}/`)?.[1];
const repoKey = (url: string) => url.toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');

type By = 'scope' | 'repository' | 'owner';

export function markSiblingMaintainers(facts: Fact[]): number {
  const maint = new Map<PurlString, Set<string>>();
  const published = new Map<PurlString, Map<string, number>>();
  const repo = new Map<PurlString, string>();
  const latestRepo = new Map<PurlString, string>();
  const name = new Map<PurlString, string>();
  for (const f of facts) {
    const key = unversionedPurl(f.subject);
    if (f.kind === 'maintainers' && !maint.has(key)) maint.set(key, new Set(f.value.maintainers.map((m) => m.name)));
    if (f.kind === 'repo' && !repo.has(key)) repo.set(key, repoKey(f.value.url));
    if (f.kind === 'release_age' && f.value.latestRepository && !latestRepo.has(key)) latestRepo.set(key, repoKey(f.value.latestRepository.url));
    if (f.kind === 'release_publishers' && !published.has(key)) {
      const m = new Map<string, number>();
      for (const a of f.value.accounts) {
        const t = Date.parse(a.firstAt);
        if (Number.isFinite(t) && !a.trusted) m.set(a.name, t);
      }
      published.set(key, m);
    }
    if (!name.has(key)) {
      const p = parsePurl(key);
      if (p.type === 'npm') name.set(key, npmNameFromPurl(p));
    }
  }
  // The repository the latest release declares (a moved package belongs to its new home).
  const repoOf = (k: PurlString) => latestRepo.get(k) ?? repo.get(k);
  const packages = new Set<PurlString>([...maint.keys(), ...published.keys()]);

  /** Sibling packages where `account` maintains (now) or had published (before `beforeMs`). */
  const siblingsOf = (self: PurlString, accounts: readonly string[], beforeMs: number): { packages: number; by: By } | undefined => {
    const n = name.get(self);
    const scope = n ? scopeOf(n) : undefined;
    const r = repoOf(self);
    const owner = r ? ownerKey(r) : undefined;
    const relation = (k: PurlString): By | undefined => {
      if (k === self) return undefined;
      const kn = name.get(k);
      if (scope && kn && scopeOf(kn) === scope) return 'scope';
      const kr = repoOf(k);
      if (r && kr === r) return 'repository';
      if (owner && kr && ownerKey(kr) === owner) return 'owner';
      return undefined;
    };
    const hits: By[] = [];
    for (const k of packages) {
      const by = relation(k);
      if (!by) continue;
      const known = (a: string) => maint.get(k)?.has(a) === true || (published.get(k)?.get(a) ?? Infinity) < beforeMs;
      if (accounts.every(known)) hits.push(by);
    }
    if (hits.length === 0) return undefined;
    const by: By = hits.includes('scope') ? 'scope' : hits.includes('repository') ? 'repository' : 'owner';
    return { packages: hits.length, by };
  };

  let marked = 0;
  for (const f of facts) {
    if (f.kind === 'maintainer_change') {
      if (f.value.added.length === 0) continue;
      const at = Date.parse(f.value.changedAt);
      const s = siblingsOf(unversionedPurl(f.subject), f.value.added, Number.isFinite(at) ? at : Infinity);
      if (!s) continue;
      f.value.sibling = s;
      marked++;
    } else if (f.kind === 'publisher_change') {
      const at = Date.parse(f.value.changedAt);
      const s = siblingsOf(unversionedPurl(f.subject), [f.value.newPublisher], Number.isFinite(at) ? at : Infinity);
      if (!s) continue;
      f.value.sibling = s;
      marked++;
    }
  }
  return marked;
}
