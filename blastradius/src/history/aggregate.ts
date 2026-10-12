/**
 * Repo-level aggregates of git history (docs/WHO-BEHIND-PLAN.md S2, C1, C2, C3).
 *
 * Methods (rules and thresholds all in HISTORY_RULES):
 *   - Contributor Absence Factor (CHAOSS, https://chaoss.community/?p=3944): the smallest number
 *     of contributors whose commits together make at least 50 % of all commits, counted per author
 *     over default-branch commits, bots excluded, merge commits counted once like any commit.
 *   - Occasional contributors (CHAOSS, https://chaoss.community/?p=3466, filter "minimum number of
 *     contributions" = 3): 1–2 commits in the window; everyone else is "regular".
 *   - Continuity (plan C1): share of a window's commits by people first seen ≥ 24 months before
 *     the window end ("long-standing") and by people first seen inside the window ("new"); the
 *     same for releases. A change of more than 30 points between consecutive windows is reported.
 *   - Signed share (plan C2): commits with a gpgsig/gpgsig-sha256 header (present, not verified).
 *   - Time zones (plan C3): per window, commit counts per recorded UTC offset and per UTC hour of
 *     week; withheld below 5 contributors or 100 commits; change = total variation distance
 *     between offset distributions ≥ 0.3. Never per person, never a country, never in a score.
 * Wording is fixed and factual ("first seen in this repository …"); no statement about intent.
 */
import type { CommitHistoryChange, CommitHistoryValue, CommitHistoryWindow, ContributorsValue, HistoryPerson, RepoTimeZones } from '../core/types.js';
import { isHashedId } from './identity.js';
import type { HistoryCommit, HistoryRecord, HistoryTag } from './record.js';

export const HISTORY_RULES = {
  /** CHAOSS CAF threshold. */
  cafShare: 0.5,
  /** Window for the headline CAF (plan S2). */
  cafMonths: 24,
  windowMonths: 12,
  maxWindows: 12,
  /** CHAOSS Occasional Contributors: fewer than this many commits in the window. */
  occasionalBelow: 3,
  /** C1: first seen at least this long before the window end = long-standing. */
  longStandingMonths: 24,
  /** C1: change in long-standing share between windows reported above this. */
  continuityChange: 0.3,
  /** C1: windows with fewer commits are not compared. */
  minCommitsToCompare: 5,
  /** Top committer first seen within this many months of the window end = recent. */
  recentTopMonths: 36,
  /** S5a (git part): release made by someone first seen fewer than this many days earlier. */
  newReleaserDays: 180,
  /** Release handover: a first release by someone after at least this many earlier releases. */
  handoverAfterReleases: 3,
  /** C2: change in signed share reported at or above this, both windows ≥ minSignedCommits. */
  signedChange: 0.5,
  minSignedCommits: 10,
  /** C3 k-anonymity floor. */
  tzMinContributors: 5,
  tzMinCommits: 100,
  /** C3: total variation distance reported at or above this. */
  tzChange: 0.3,
  /** People listed: everyone in a CAF set or with a release, plus this many top contributors. */
  topPeople: 20,
} as const;

const DAY = 86400;

export function addMonths(d: Date, months: number): Date {
  const x = new Date(d.getTime());
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + months);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x;
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** CHAOSS Contributor Absence Factor of a list of contribution counts (0 for none). */
export function absenceFactor(counts: readonly number[], share: number = HISTORY_RULES.cafShare): number {
  const sorted = counts.filter((n) => n > 0).sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i]!;
    if (sum >= total * share) return i + 1;
  }
  return sorted.length;
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

/** The ids whose commits make the CAF (largest first, ties by id for determinism). */
export function cafSet(byId: ReadonlyMap<string, number>): string[] {
  const sorted = [...byId].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const k = absenceFactor(sorted.map(([, n]) => n));
  return sorted.slice(0, k).map(([id]) => id);
}

/** Total variation distance between two count distributions (0 = same shape, 1 = disjoint). */
export function totalVariation(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): number {
  const ta = Object.values(a).reduce((x, y) => x + y, 0);
  const tb = Object.values(b).reduce((x, y) => x + y, 0);
  if (ta === 0 || tb === 0) return 0;
  let d = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) d += Math.abs((a[k] ?? 0) / ta - (b[k] ?? 0) / tb);
  return d / 2;
}

interface Release {
  name: string;
  at: number;
  by: string;
  signed: boolean;
}

/** Release points: release tags, plus version-bump commits (`npm version`) that have no tag. */
export function releasesOf(commits: readonly HistoryCommit[], tags: readonly HistoryTag[]): Release[] {
  const out: Release[] = tags.map((t) => ({ name: t.name, at: t.at, by: t.by, signed: t.signed }));
  const tagged = new Set(tags.map((t) => t.commit));
  const tagNames = new Set(tags.map((t) => t.name.replace(/^v/, '')));
  for (const c of commits) {
    if (!c.version || tagged.has(c.oid) || tagNames.has(c.version)) continue;
    out.push({ name: c.version, at: c.at, by: c.committer, signed: c.signed });
  }
  return out.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/** Shallow histories: first-seen dates within this many months of the earliest commit read are censored. */
export const SHALLOW_CENSOR_MONTHS = 24;

/** Epoch seconds before which a first-seen date in a shallow history means "on or before"; undefined for a full history. */
export function shallowCensorUntil(rec: Pick<HistoryRecord, 'shallowSince'>): number | undefined {
  if (rec.shallowSince === undefined) return undefined;
  return secs(addMonths(new Date(rec.shallowSince * 1000), SHALLOW_CENSOR_MONTHS));
}

/**
 * Tier 0.5: the maker of a lightweight release tag on a commit that GitHub's web flow committed (a
 * pull request merged in the browser) is not known: git only records the pull request's author, who
 * did not make the release (sqlglot v30.20.0, a contributor's merged pull request).
 */
export const UNKNOWN_TAGGER = 'unknown:tagger';

export interface AggregateResult {
  contributors: ContributorsValue;
  history: CommitHistoryValue;
}

/** Aggregate a pseudonymised history as of `asOf` (later commits and tags are ignored). */
export function aggregateHistory(
  rec: HistoryRecord,
  asOf: Date,
  opts: { verified?: { checked: number; verified: number }; identityVia?: string[]; identityResolved?: boolean; merged?: { displayName: number; npmPublisher: number } } = {},
): AggregateResult | undefined {
  const R = HISTORY_RULES;
  const end = secs(asOf);
  const commits = rec.commits.filter((c) => c.at < end);
  if (commits.length === 0) return undefined;
  const tags = rec.tags.filter((t) => t.at < end);
  const releases = releasesOf(commits, tags);

  // First/last seen: authored or committed commits and releases.
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const seen = (id: string, at: number) => {
    if (!first.has(id) || at < first.get(id)!) first.set(id, at);
    if (!last.has(id) || at > last.get(id)!) last.set(id, at);
  };
  for (const c of commits) {
    seen(c.author, c.at);
    seen(c.committer, c.at);
  }
  for (const r of releases) if (r.by !== UNKNOWN_TAGGER) seen(r.by, r.at);
  // Tier 0.5: in a shallow clone, someone first seen in the first SHALLOW_CENSOR_MONTHS of the history
  // read may have been active long before it: their first-seen date is "on or before", read as
  // before the history (never new, never a takeover).
  const censorUntil = shallowCensorUntil(rec);
  if (censorUntil !== undefined) for (const [id, at] of first) if (at < censorUntil) first.set(id, Math.min(at, rec.shallowSince! - DAY));

  const inRange = (from: number, to: number) => commits.filter((c) => c.at >= from && c.at < to);

  // Headline CAF, last 24 months, and over all history.
  const cafFrom = secs(addMonths(asOf, -R.cafMonths));
  const recent = inRange(cafFrom, end);
  const recentBy = countBy(recent, (c) => c.author);
  const sortedRecent = [...recentBy].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const allBy = countBy(commits, (c) => c.author);
  const firstAt = Math.min(...commits.map((c) => c.at));
  const lastAt = Math.max(...commits.map((c) => c.at));
  const contributors: ContributorsValue = {
    from: iso(cafFrom),
    to: iso(end),
    commits: recent.length,
    absenceFactor: absenceFactor([...recentBy.values()]),
    top: sortedRecent.slice(0, 10).map(([id, n]) => ({ id, share: round3(n / recent.length) })),
    unmapped: recent.filter((c) => isHashedId(c.author)).length,
    contributors: recentBy.size,
    allHistory: { from: iso(firstAt), commits: commits.length, absenceFactor: absenceFactor([...allBy.values()]), contributors: allBy.size },
  };

  // 12-month windows, newest first.
  const windows: CommitHistoryWindow[] = [];
  for (let i = 0; i < R.maxWindows; i++) {
    const wEndD = addMonths(asOf, -R.windowMonths * i);
    const wFromD = addMonths(asOf, -R.windowMonths * (i + 1));
    const wEnd = secs(wEndD);
    const wFrom = secs(wFromD);
    if (wEnd <= firstAt) break;
    const wc = inRange(wFrom, wEnd);
    const by = countBy(wc, (c) => c.author);
    const longCut = secs(addMonths(wEndD, -R.longStandingMonths));
    const recentCut = secs(addMonths(wEndD, -R.recentTopMonths));
    const isLong = (id: string) => (first.get(id) ?? Infinity) <= longCut;
    const wr = releases.filter((r) => r.at >= wFrom && r.at < wEnd);
    const top = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const share = (n: number, d: number) => (d === 0 ? 0 : round3(n / d));
    const w: CommitHistoryWindow = {
      from: iso(wFrom),
      to: iso(wEnd),
      commits: wc.length,
      contributors: by.size,
      absenceFactor: absenceFactor([...by.values()]),
      occasional: [...by.values()].filter((n) => n < R.occasionalBelow).length,
      regular: [...by.values()].filter((n) => n >= R.occasionalBelow).length,
      longStandingShare: share(wc.filter((c) => isLong(c.author)).length, wc.length),
      newShare: share(wc.filter((c) => (first.get(c.author) ?? 0) >= wFrom).length, wc.length),
      signedShare: share(wc.filter((c) => c.signed).length, wc.length),
      releases: wr.length,
      releasesByLongStandingShare: wr.length ? share(wr.filter((r) => r.by !== UNKNOWN_TAGGER && isLong(r.by)).length, wr.length) : null,
      signedReleaseShare: wr.length ? share(wr.filter((r) => r.signed).length, wr.length) : null,
      topCommitterFirstSeenRecently: top ? (first.get(top[0]) ?? 0) > recentCut : false,
    };
    const tz = windowTimeZones(rec, wFromD, wEndD);
    if (by.size >= R.tzMinContributors && wc.length >= R.tzMinCommits && tz) w.timeZones = tz;
    else w.timeZonesWithheld = 'below_floor';
    windows.push(w);
  }

  const changes: CommitHistoryChange[] = [];
  const pct = (n: number) => `${Math.round(n * 100)} %`;
  for (let i = 0; i + 1 < windows.length; i++) {
    const cur = windows[i]!;
    const prev = windows[i + 1]!;
    if (cur.commits >= R.minCommitsToCompare && prev.commits >= R.minCommitsToCompare && Math.abs(cur.longStandingShare - prev.longStandingShare) > R.continuityChange) {
      changes.push({
        kind: 'contributor_base_changed',
        date: cur.to,
        text: `Contributor base changed: commits by long-standing contributors went from ${pct(prev.longStandingShare)} to ${pct(cur.longStandingShare)} (12 months to ${cur.to}).`,
        before: prev.longStandingShare,
        after: cur.longStandingShare,
      });
    }
    if (cur.topCommitterFirstSeenRecently && cur.commits >= R.minCommitsToCompare) {
      const curTop = topOf(commits, cur);
      const prevTop = topOf(commits, prev);
      // Tier 0: someone first seen on the repository's first day is its creator, never a takeover (picocolors).
      if (curTop && curTop !== prevTop && first.get(curTop) !== firstAt) {
        const wFrom = secs(new Date(`${cur.from}T00:00:00Z`));
        const wTo = secs(new Date(`${cur.to}T00:00:00Z`));
        const own = releases.filter((r) => r.by === curTop && r.at >= wFrom && r.at < wTo).length;
        const ownBefore = releases.filter((r) => r.by === curTop && r.at < wFrom).length;
        // Tier 0: a takeover is dated to the first release it made in the window (the causing
        // release), not to the window end (which moved to "today" every week).
        const firstOwn = releases.find((r) => r.by === curTop && r.at >= wFrom && r.at < wTo);
        const takeover = own > 0 && own * 2 > cur.releases;
        changes.push({
          kind: takeover ? 'release_takeover' : 'top_committer_new',
          date: takeover && firstOwn ? iso(firstOwn.at) : cur.to,
          ...(takeover && firstOwn ? { release: firstOwn.name } : {}),
          text:
            `The top committer in the 12 months to ${cur.to} was first seen in this repository on ${iso(first.get(curTop)!)}` +
            (own > 0 ? ` and made ${own} of the ${cur.releases} releases in that period (${ownBefore} before it).` : '.'),
          // Days from first seen to the date the observation carries (Tier 0.5: a takeover dated
          // to its release said "first seen 2025-05-06" with 524 days, counted to the window end).
          daysSinceFirstSeen: Math.round(((takeover && firstOwn ? firstOwn.at : wTo) - first.get(curTop)!) / DAY),
          before: ownBefore,
          after: own,
        });
      }
    }
    if (cur.commits >= R.minSignedCommits && prev.commits >= R.minSignedCommits && Math.abs(cur.signedShare - prev.signedShare) >= R.signedChange) {
      changes.push({
        kind: 'signed_share_changed',
        date: cur.to,
        text: `Signed share ${cur.signedShare < prev.signedShare ? 'fell' : 'rose'} from ${pct(prev.signedShare)} to ${pct(cur.signedShare)} (12 months to ${cur.to}).`,
        before: prev.signedShare,
        after: cur.signedShare,
      });
    }
    if (cur.timeZones && prev.timeZones) {
      const tvd = round3(totalVariation(prev.timeZones.offsets, cur.timeZones.offsets));
      if (tvd >= R.tzChange) {
        changes.push({ kind: 'time_zone_pattern_changed', date: cur.to, text: `Repository commit time-zone pattern changed (distance ${tvd.toFixed(2)}, 12 months to ${cur.to}).`, after: tvd });
      }
    }
  }

  // Release continuity (S5a git part) and handovers: each account's first release only.
  const releasers = new Set<string>();
  releases.forEach((r, idx) => {
    // Tier 0.5: a lightweight tag on a commit GitHub's web flow committed says nothing about who released.
    if (r.by === UNKNOWN_TAGGER || releasers.has(r.by)) return;
    releasers.add(r.by);
    const days = Math.round((r.at - (first.get(r.by) ?? r.at)) / DAY);
    // Only meaningful once the repository itself is older than the threshold.
    if (days < R.newReleaserDays && idx > 0 && (r.at - firstAt) / DAY >= R.newReleaserDays) {
      changes.push({ kind: 'release_by_new_person', date: iso(r.at), release: r.name, daysSinceFirstSeen: days, text: `Release ${r.name} was made by an account first seen in this repository ${days} days earlier.` });
    }
    if (idx >= R.handoverAfterReleases) {
      changes.push({ kind: 'release_handover', date: iso(r.at), release: r.name, daysSinceFirstSeen: days, before: idx, text: `Release ${r.name} (release ${idx + 1} in this repository) is the first made by this account; it was first seen in this repository ${days} days earlier.` });
    }
  });
  changes.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));

  // People: CAF sets, releasers, top contributors. Counts and dates only.
  const ids = new Set<string>([...cafSet(recentBy), ...cafSet(allBy), ...releases.map((r) => r.by).filter((b) => b !== UNKNOWN_TAGGER)]);
  for (const [id] of [...allBy].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, R.topPeople)) ids.add(id);
  const relBy = countBy(releases.filter((r) => r.by !== UNKNOWN_TAGGER), (r) => r.by);
  const people: HistoryPerson[] = [...ids]
    .map((id) => ({ id, firstSeen: iso(first.get(id)!), lastSeen: iso(last.get(id)!), commits: allBy.get(id) ?? 0, commits24m: recentBy.get(id) ?? 0, releases: relBy.get(id) ?? 0 }))
    .sort((a, b) => b.commits - a.commits || a.id.localeCompare(b.id));

  // Longest gap between consecutive commit days in the last 24 months.
  const days = [...new Set(recent.map((c) => c.at))].sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < days.length; i++) gap = Math.max(gap, (days[i]! - days[i - 1]!) / DAY);

  // CAF of the last active period: the 24 months up to the last commit (P3 uses it for inactive repos).
  const lastEnd = lastAt + DAY;
  const lastFrom = secs(addMonths(new Date(lastEnd * 1000), -R.cafMonths));
  const lastPeriod = commits.filter((c) => c.at >= lastFrom && c.at < lastEnd);
  const cafAtLastCommit = { from: iso(lastFrom), to: iso(lastAt), commits: lastPeriod.length, absenceFactor: absenceFactor([...countBy(lastPeriod, (c) => c.author).values()]) };

  const allIds = new Set([...allBy.keys()]);
  const history: CommitHistoryValue = {
    repo: rec.repo,
    head: rec.head,
    asOf: asOf.toISOString(),
    firstCommit: iso(firstAt),
    lastCommit: iso(lastAt),
    commits: commits.length,
    windows,
    changes,
    people,
    daysSinceLastCommit: Math.max(0, Math.floor((end - lastAt) / DAY)),
    longestGapDays24m: Math.round(gap),
    ...(rec.shallowSince !== undefined ? { readFrom: iso(rec.shallowSince) } : {}),
    identity: {
      mapped: [...allIds].filter((id) => !isHashedId(id)).length,
      hashed: [...allIds].filter(isHashedId).length,
      via: opts.identityVia ?? ['mailmap', 'github-noreply', 'salted-hash'],
      ...(opts.identityResolved !== undefined ? { resolved: opts.identityResolved } : {}),
      ...(opts.merged ? { merged: opts.merged } : {}),
    },
    cafAtLastCommit,
  };
  if (opts.verified) history.verified = opts.verified;
  return { contributors, history };
}

function topOf(commits: readonly HistoryCommit[], w: CommitHistoryWindow): string | undefined {
  const from = secs(new Date(`${w.from}T00:00:00Z`));
  const to = secs(new Date(`${w.to}T00:00:00Z`));
  const by = countBy(
    commits.filter((c) => c.at >= from && c.at < to),
    (c) => c.author,
  );
  return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/** Sum of the calendar months that start inside [from, to). Undefined when there are none. */
export function windowTimeZones(rec: HistoryRecord, from: Date, to: Date): RepoTimeZones | undefined {
  const fromKey = from.toISOString().slice(0, 7);
  const toKey = to.toISOString().slice(0, 7);
  const startsInside = (key: string) => {
    const start = `${key}-01`;
    return start >= from.toISOString().slice(0, 10) && start < to.toISOString().slice(0, 10);
  };
  const offsets: Record<string, number> = {};
  const how = new Array<number>(168).fill(0);
  let any = false;
  for (const [key, m] of Object.entries(rec.tzMonths)) {
    if (key < fromKey || key > toKey || !startsInside(key)) continue;
    any = true;
    for (const [o, n] of Object.entries(m.offsets)) offsets[o] = (offsets[o] ?? 0) + n;
    m.how.forEach((n, i) => (how[i]! += n));
  }
  return any ? { offsets: Object.fromEntries(Object.entries(offsets).sort()), hourOfWeekUtc: how } : undefined;
}

/**
 * Hashed ids worth a GitHub login lookup: people with commits in the CAF window, everyone who made
 * a release, and the top contributors over all history (the ids the aggregates show), at most
 * `max`, most commits first.
 */
export function mappingLookups(rec: HistoryRecord, asOf: Date, max = 200): HistoryRecord['lookup'] {
  const end = secs(asOf);
  const from = secs(addMonths(asOf, -HISTORY_RULES.cafMonths));
  const commits = rec.commits.filter((c) => c.at < end);
  const all = countBy(commits, (c) => c.author);
  const want = new Set<string>([
    ...commits.filter((c) => c.at >= from).map((c) => c.author),
    ...releasesOf(commits, rec.tags.filter((t) => t.at < end)).map((r) => r.by),
    ...[...all].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, HISTORY_RULES.topPeople).map(([id]) => id),
  ]);
  return rec.lookup.filter((l) => want.has(l.id)).sort((a, b) => (all.get(b.id) ?? 0) - (all.get(a.id) ?? 0) || a.id.localeCompare(b.id)).slice(0, max);
}
