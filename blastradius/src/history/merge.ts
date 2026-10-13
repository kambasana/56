/**
 * Identity merge before any history aggregate (Tier 0, teardown problem 4; redesigned in Tier 0.6
 * after an independent re-check showed that a display name an attacker picks could erase the xz
 * takeover signal).
 *
 * Evidence is split by whether the person being described can choose it:
 *
 * STRONG (an attacker cannot pick it to look like someone else), merged into `rec`:
 *   - the same e-mail address: one salted hash, so one id from the start (identity.ts);
 *   - the repository's committed .mailmap: applied by git itself while the history is read (git.ts),
 *     so declared aliases already arrive as one id;
 *   - the same GitHub no-reply login: the id is the login (identity.ts noreplyLogin);
 *   - the same npm publisher account: every id the registry addresses of one npm account hash to
 *     (`_npmUser.email` is tied to the account by the registry; handles are public, addresses never kept);
 *   - GitHub's own mapping of a commit to an account (GraphQL author login, or the signer of a
 *     signature GitHub verified): applied by the history enricher after this merge (`githubLogin`,
 *     `signingKey` counts), with a token only.
 *
 * WEAK (anyone can commit under any display name), merged only into `weakRec`:
 *   - display-name matches, including spacing, case and single-word variants ("Romuald Percereau" =
 *     "RomualdPercereau"), with overlapping or adjacent activity;
 *   - a display name that equals a GitHub login of this history, or a short / single-word name tied to
 *     a login that is also an npm account publishing this repository's packages.
 *
 * Weak merges may lower NOISE (the CAF and contributor counts, which they can only make more
 * cautious), but never suppress or downgrade a takeover, handover, release_takeover, S5a or
 * contributor-base signal: those are computed on `rec` alone. When such a signal exists on `rec` but
 * would disappear on `weakRec`, it is kept and annotated "possibly the same person as X (name match
 * only, unverified)" (annotateWeak below).
 *
 * The merged history keeps one id per person: a GitHub login when one of the ids is a login, else the
 * id seen first. Without display names (histories read before Tier 0) and without GitHub login
 * mapping, identities are not resolved and the labels treat git-only continuity signals as context.
 */
import type { CommitHistoryChange, CommitHistoryValue } from '../core/types.js';
import { aggregateHistory, type AggregateResult } from './aggregate.js';
import { isWeakNameKey, nameDigest } from './identity.js';
import { renameIds, type HistoryRecord } from './record.js';

/** Two addresses under one name count as one person when their activity is at most this far apart. */
export const NAME_GAP_DAYS = 365;
const DAY = 86400;

/** Merges per evidence type (Tier 0.6): measurable over-merging. */
export interface MergeCounts {
  /** Strong: ids joined because one npm account's registry addresses hash to them. */
  npmPublisher: number;
  /** Strong: hashed ids GitHub mapped to a login (GraphQL commit author), set by the enricher. */
  githubLogin: number;
  /** Strong: hashed ids tied to a login through a signature GitHub verified, set by the enricher. */
  signingKey: number;
  /** Whether the repository's .mailmap was applied by git (its aliases arrive as one id; not countable). */
  mailmap: boolean;
  /** Weak (name only): ids joined in the noise view by display name plus overlapping activity. */
  displayName: number;
  /** Weak (name only): addresses joined to a GitHub login because the display name is that login, or a short name tied to an npm account. */
  loginName: number;
  /** Signals kept on strong evidence that a name-only merge would have hidden (annotated). */
  keptDespiteNameMatch: number;
}

export interface MergeResult {
  /** Strong evidence only: the input of every continuity / takeover / contributor-base signal. */
  rec: HistoryRecord;
  /** Strong plus weak (name) evidence: CAF and contributor counts only. */
  weakRec: HistoryRecord;
  /** id in `rec` → the ids in `rec` a name-only merge would join it with. */
  nameMatches: Map<string, string[]>;
  merged: MergeCounts;
  /** Display names were available, so the weak step could run. */
  namesAvailable: boolean;
}

type Span = { first: number; last: number };

function spans(rec: HistoryRecord): Map<string, Span> {
  const out = new Map<string, Span>();
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

/** Union-find over ids, keeping a GitHub login over a hash, else the id seen first. */
class Ids {
  private parent = new Map<string, string>();
  constructor(private span: Map<string, Span>) {}
  find(id: string): string {
    let r = id;
    while (this.parent.has(r)) r = this.parent.get(r)!;
    return r;
  }
  private better(a: string, b: string): string {
    const la = !a.startsWith('hash:');
    const lb = !b.startsWith('hash:');
    if (la !== lb) return la ? a : b;
    return (this.span.get(a)?.first ?? Infinity) <= (this.span.get(b)?.first ?? Infinity) ? a : b;
  }
  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    const keep = this.better(ra, rb);
    const drop = keep === ra ? rb : ra;
    this.parent.set(drop, keep);
    const s = this.span.get(keep);
    const o = this.span.get(drop);
    if (s && o) this.span.set(keep, { first: Math.min(s.first, o.first), last: Math.max(s.last, o.last) });
    return true;
  }
  /** Activity span of the person `id` belongs to so far. */
  spanOf(id: string): Span {
    return this.span.get(this.find(id))!;
  }
  rename(ids: Iterable<string>): Map<string, string> {
    const map = new Map<string, string>();
    for (const id of ids) {
      const r = this.find(id);
      if (r !== id) map.set(id, r);
    }
    return map;
  }
}

export function mergeIdentities(rec: HistoryRecord, opts: MergeOptions = {}): MergeResult {
  // 1. Strong: the npm publisher account.
  const strongSpan = spans(rec);
  const strong = new Ids(strongSpan);
  let npmPublisher = 0;
  for (const ids of Object.values(rec.npmPublisherIds ?? {})) {
    const present = ids.filter((id) => strongSpan.has(id));
    for (let i = 1; i < present.length; i++) if (strong.union(present[0]!, present[i]!)) npmPublisher++;
  }
  const strongMap = strong.rename(strongSpan.keys());
  const strongRec = strongMap.size ? renameIds(rec, strongMap) : rec;

  // 2. Weak: display names, on top of the strong merge.
  const span = spans(strongRec);
  const weak = new Ids(new Map([...span].map(([k, v]) => [k, { ...v }])));
  let displayName = 0;
  let loginName = 0;
  const nameMatches = new Map<string, string[]>();
  const note = (a: string, b: string) => {
    nameMatches.set(a, [...new Set([...(nameMatches.get(a) ?? []), b])]);
    nameMatches.set(b, [...new Set([...(nameMatches.get(b) ?? []), a])]);
  };
  const names = strongRec.names;
  if (names) {
    // Keys are grouped by their digest, so one name's spacing / case / single-word variants are one
    // group ("Li Wei" and "LiWei"); a group is weak when any of its keys is (Tier 0.6: the strength of
    // a name no longer depends on how it was spaced).
    const byName = new Map<string, string[]>();
    const weakGroup = new Set<string>();
    for (const [id, key] of Object.entries(names)) {
      if (!span.has(id)) continue;
      const d = nameDigest(key);
      byName.set(d, [...(byName.get(d) ?? []), id]);
      if (isWeakNameKey(key)) weakGroup.add(d);
    }
    const accounts = new Set((opts.npmAccounts ?? []).map((a) => a.toLowerCase()));
    // A display name that is exactly a GitHub login of this history ("fnwk" committing from a
    // personal address, the no-reply login fnwk) points that address at the login (Tier 0.5; weak).
    const loginByKey = new Map<string, string[]>();
    for (const [login, key] of Object.entries(strongRec.loginNames ?? {})) {
      if (!span.has(login)) continue;
      const d = nameDigest(key);
      loginByKey.set(d, [...(loginByKey.get(d) ?? []), login]);
    }
    const near = (a: string, b: string) => {
      const sa = weak.spanOf(a);
      const sb = weak.spanOf(b);
      return Math.max(0, Math.max(sa.first, sb.first) - Math.min(sa.last, sb.last)) <= NAME_GAP_DAYS * DAY;
    };
    for (const [d, ids0] of byName) {
      const logins = loginByKey.get(d) ?? [];
      if (weakGroup.has(d)) {
        // Weak key (a single word or a short name): only hashed addresses join a GitHub login that
        // is the name itself or an npm account of this repository, and only with nearby activity.
        const tied = [...new Set([...ids0.filter((id) => !id.startsWith('hash:') && accounts.has(id.toLowerCase())), ...logins])];
        if (tied.length !== 1) continue;
        const login = tied[0]!;
        for (const id of ids0) {
          if (id === login || !id.startsWith('hash:') || !near(login, id)) continue;
          note(login, id);
          if (weak.union(login, id)) loginName++;
        }
        continue;
      }
      const ids = [...ids0];
      for (const l of logins) if (!ids.includes(l)) ids.push(l);
      if (ids.length < 2) continue;
      ids.sort((a, b) => span.get(a)!.first - span.get(b)!.first || a.localeCompare(b));
      for (let i = 1; i < ids.length; i++) {
        // Overlapping or adjacent activity: the later address starts before, or within the gap after, the earlier one stops.
        if (weak.spanOf(ids[i]!).first > weak.spanOf(ids[i - 1]!).last + NAME_GAP_DAYS * DAY) continue;
        note(ids[i - 1]!, ids[i]!);
        if (weak.union(ids[i - 1]!, ids[i]!)) {
          if (logins.includes(ids[i]!) || logins.includes(ids[i - 1]!)) loginName++;
          else displayName++;
        }
      }
    }
  }
  const weakMap = weak.rename(span.keys());
  return {
    rec: strongRec,
    weakRec: weakMap.size ? renameIds(strongRec, weakMap) : strongRec,
    nameMatches,
    merged: { npmPublisher, githubLogin: 0, signingKey: 0, mailmap: rec.mailmap, displayName, loginName, keptDespiteNameMatch: 0 },
    namesAvailable: rec.names !== undefined,
  };
}

/** Apply the same strong renames (GitHub login mapping) to both views of a merge. */
export function renameMerge(m: MergeResult, map: ReadonlyMap<string, string>): MergeResult {
  if (map.size === 0) return m;
  const r = (id: string) => map.get(id) ?? id;
  const nameMatches = new Map<string, string[]>();
  for (const [k, v] of m.nameMatches) {
    const others = [...new Set([...(nameMatches.get(r(k)) ?? []), ...v.map(r)])].filter((x) => x !== r(k));
    if (others.length) nameMatches.set(r(k), others);
  }
  return { ...m, rec: renameIds(m.rec, map), weakRec: renameIds(m.weakRec, map), nameMatches };
}

/** Ids `id` would be joined with by a name-only merge (directly or through other name matches). */
export function nameMatchesOf(m: Pick<MergeResult, 'nameMatches'>, id: string): string[] {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const o of m.nameMatches.get(queue.shift()!) ?? []) {
      if (seen.has(o)) continue;
      seen.add(o);
      queue.push(o);
    }
  }
  seen.delete(id);
  return [...seen];
}

/**
 * Signals a name-only merge may never hide (Tier 0.6): computed on the strong merge, compared with
 * the weak one, and kept with an annotation when only the weak merge would remove them.
 */
export const PROTECTED_KINDS: ReadonlySet<CommitHistoryChange['kind']> = new Set<CommitHistoryChange['kind']>([
  'release_takeover',
  'release_by_new_person',
  'release_handover',
  'top_committer_new',
  'contributor_base_changed',
  'npm_release_by_new_account',
]);

const changeKey = (c: CommitHistoryChange) => `${c.kind}|${c.release ?? ''}|${c.date}`;
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/** Who a name match points at, in words: a GitHub login (public), else an address by its first-seen date. */
export function describeIds(rec: HistoryRecord, ids: readonly string[]): string {
  const first = spans(rec);
  const parts = [...ids]
    .sort((a, b) => (first.get(a)?.first ?? 0) - (first.get(b)?.first ?? 0) || a.localeCompare(b))
    .map((id) => (id.startsWith('hash:') ? (first.has(id) ? `an address first seen in this repository on ${isoDay(first.get(id)!.first)}` : 'another address in this repository') : `the GitHub login ${id}`));
  return parts.length <= 2 ? parts.join(' or ') : `${parts.slice(0, 2).join(', ')} or ${parts.length - 2} more`;
}

/** The change with the name-match annotation. */
export function annotateNameMatch(c: CommitHistoryChange, who: string): CommitHistoryChange {
  return { ...c, possiblySameAs: who, text: `${c.text} Possibly the same person as ${who} (name match only, unverified).` };
}

/**
 * Keep every protected change of the strong view; annotate the ones the weak view does not have.
 * `actorOf` names the id a change is about (undefined for repository-level window kinds).
 */
export function keepDespiteNameMatch(m: MergeResult, strong: readonly CommitHistoryChange[], weak: readonly CommitHistoryChange[], actorOf: (c: CommitHistoryChange) => string | undefined): { changes: CommitHistoryChange[]; kept: number } {
  const inWeak = new Set(weak.map(changeKey));
  let kept = 0;
  const changes = strong.map((c) => {
    if (!PROTECTED_KINDS.has(c.kind) || inWeak.has(changeKey(c))) return c;
    const actor = actorOf(c);
    const others = actor ? nameMatchesOf(m, actor) : [];
    kept++;
    if (others.length) return annotateNameMatch(c, describeIds(m.rec, others));
    // A window comparison (contributor base): which ids matched by name is not one person.
    return { ...c, possiblySameAs: 'earlier contributors', text: `${c.text} Some of the newly seen contributors possibly are earlier contributors under another address (name match only, unverified).` };
  });
  return { changes, kept };
}

/**
 * Aggregate a merged history (Tier 0.6): continuity, takeover, handover and contributor-base signals
 * from the strong view only, kept and annotated where a name-only merge would hide them; the CAF and
 * contributor counts (noise) from the weak view, where merging one person's addresses can only make
 * them more cautious.
 */
export function aggregateMerged(m: MergeResult, asOf: Date, opts: Omit<NonNullable<Parameters<typeof aggregateHistory>[2]>, 'actors'> = {}): AggregateResult | undefined {
  const actors = new Map<CommitHistoryChange, string>();
  const strong = aggregateHistory(m.rec, asOf, { ...opts, actors });
  if (!strong) return undefined;
  if (m.weakRec === m.rec) return withCounts(strong, m, 0, opts);
  const weak = aggregateHistory(m.weakRec, asOf, opts)!;
  const { changes, kept } = keepDespiteNameMatch(m, strong.history.changes, weak.history.changes, (c) => actors.get(c));
  const out: AggregateResult = {
    contributors: weak.contributors,
    history: { ...strong.history, changes, ...(weak.history.cafAtLastCommit ? { cafAtLastCommit: weak.history.cafAtLastCommit } : {}) },
  };
  return withCounts(out, m, kept, opts);
}

function withCounts(a: AggregateResult, m: MergeResult, kept: number, opts: { merged?: CommitHistoryValue['identity']['merged'] }): AggregateResult {
  const merged = { ...m.merged, ...(opts.merged ?? {}), keptDespiteNameMatch: kept };
  return { ...a, history: { ...a.history, identity: { ...a.history.identity, merged } } };
}
