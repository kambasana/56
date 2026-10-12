/**
 * Identity merge before any history aggregate (Tier 0, teardown problem 4), in this order:
 *   1. .mailmap: applied by git itself while the history is read (git.ts), so declared aliases
 *      already arrive as one id;
 *   2. display name plus overlapping activity: ids that committed under the same display name
 *      (compared as salted hashes, identity.ts nameKey; spacing and case ignored, so "Romuald
 *      Percereau" = "RomualdPercereau") whose active periods overlap or follow each other within
 *      NAME_GAP_DAYS are one person changing address (nanoid's author moving from one domain to
 *      another, react's maintainer from a personal to an employer address). A short one-word name
 *      ("KaKa") is too common on its own: it merges an address into a GitHub login only when that
 *      login is also an npm account that published this repository's packages (Tier 0.5: KaKa's
 *      commit address and the no-reply login climba03003, who publishes process-warning on npm);
 *   3. the npm publisher: every id that the registry addresses of one npm account hash to is that
 *      account (npm handles are public; the addresses are never kept).
 * The merged history keeps one id per person: a GitHub login when one of the ids is a login, else the
 * id seen first. Without display names (histories read before Tier 0) and without GitHub login
 * mapping, identities are not resolved and the labels treat git-only continuity signals as context.
 */
import { isWeakNameKey } from './identity.js';
import { renameIds, type HistoryRecord } from './record.js';

/** Two addresses under one name count as one person when their activity is at most this far apart. */
export const NAME_GAP_DAYS = 365;
const DAY = 86400;

export interface MergeResult {
  rec: HistoryRecord;
  merged: { displayName: number; npmPublisher: number };
  /** Display names were available, so step 2 could run. */
  namesAvailable: boolean;
}

function spans(rec: HistoryRecord): Map<string, { first: number; last: number }> {
  const out = new Map<string, { first: number; last: number }>();
  const see = (id: string, at: number) => {
    const s = out.get(id);
    if (!s) out.set(id, { first: at, last: at });
    else {
      if (at < s.first) s.first = at;
      if (at > s.last) s.last = at;
    }
  };
  for (const c of rec.commits) {
    see(c.author, c.at);
    see(c.committer, c.at);
  }
  for (const t of rec.tags) see(t.by, t.at);
  return out;
}

export interface MergeOptions {
  /** npm accounts (public handles) that published packages of this repository. */
  npmAccounts?: readonly string[];
}

export function mergeIdentities(rec: HistoryRecord, opts: MergeOptions = {}): MergeResult {
  const span = spans(rec);
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let r = id;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  const better = (a: string, b: string) => {
    // A GitHub login beats a hash; otherwise the id seen first.
    const la = !a.startsWith('hash:');
    const lb = !b.startsWith('hash:');
    if (la !== lb) return la ? a : b;
    return (span.get(a)?.first ?? Infinity) <= (span.get(b)?.first ?? Infinity) ? a : b;
  };
  const union = (a: string, b: string): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    const keep = better(ra, rb);
    parent.set(keep === ra ? rb : ra, keep);
    const s = span.get(keep);
    const o = span.get(keep === ra ? rb : ra);
    if (s && o) span.set(keep, { first: Math.min(s.first, o.first), last: Math.max(s.last, o.last) });
    return true;
  };
  let displayName = 0;
  let npmPublisher = 0;
  if (rec.names) {
    const byName = new Map<string, string[]>();
    for (const [id, key] of Object.entries(rec.names)) {
      if (!span.has(id)) continue;
      const l = byName.get(key) ?? [];
      l.push(id);
      byName.set(key, l);
    }
    const accounts = new Set((opts.npmAccounts ?? []).map((a) => a.toLowerCase()));
    // A display name that is exactly a GitHub login of this history ("fnwk" committing from a
    // personal address, the no-reply login fnwk) ties that address to the login (Tier 0.5).
    const loginByKey = new Map<string, string[]>();
    for (const [login, key] of Object.entries(rec.loginNames ?? {})) if (span.has(login)) loginByKey.set(key, [...(loginByKey.get(key) ?? []), login]);
    for (const [key, logins] of loginByKey) {
      const ids = byName.get(key);
      if (!ids || isWeakNameKey(key)) continue;
      for (const l of logins) if (!ids.includes(l)) ids.push(l);
    }
    for (const [key, ids] of byName) {
      if (isWeakNameKey(key)) {
        // Weak (short one-word) name: only hashed addresses join a GitHub login that is the name
        // itself or an npm account of this repository, and only with overlapping or adjacent activity.
        const logins = [...new Set([...ids.filter((id) => !id.startsWith('hash:') && accounts.has(id.toLowerCase())), ...(loginByKey.get(key) ?? [])])];
        if (logins.length !== 1) continue;
        const login = logins[0]!;
        for (const id of ids) {
          if (id === login || !id.startsWith('hash:')) continue;
          const a = span.get(find(login))!;
          const b = span.get(find(id))!;
          const apart = Math.max(0, Math.max(a.first, b.first) - Math.min(a.last, b.last));
          if (apart <= NAME_GAP_DAYS * DAY && union(login, id)) displayName++;
        }
        continue;
      }
      if (ids.length < 2) continue;
      ids.sort((a, b) => span.get(a)!.first - span.get(b)!.first || a.localeCompare(b));
      for (let i = 1; i < ids.length; i++) {
        const prev = span.get(find(ids[i - 1]!))!;
        const cur = span.get(find(ids[i]!))!;
        // Overlapping or adjacent activity: the later address starts before, or within the gap after, the earlier one stops.
        if (cur.first <= prev.last + NAME_GAP_DAYS * DAY && union(ids[i - 1]!, ids[i]!)) displayName++;
      }
    }
  }
  for (const ids of Object.values(rec.npmPublisherIds ?? {})) {
    const present = ids.filter((id) => span.has(id));
    for (let i = 1; i < present.length; i++) if (union(present[0]!, present[i]!)) npmPublisher++;
  }
  const map = new Map<string, string>();
  for (const id of span.keys()) {
    const r = find(id);
    if (r !== id) map.set(id, r);
  }
  return { rec: map.size ? renameIds(rec, map) : rec, merged: { displayName, npmPublisher }, namesAvailable: rec.names !== undefined };
}
