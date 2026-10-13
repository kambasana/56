/**
 * S5a release continuity, npm side (docs/WHO-BEHIND-PLAN.md S5a; P2 deferred it to P3): a release
 * published on npm (`_npmUser`) by an account whose first commit in the repository is fewer than
 * 180 days before the release, or that had no commit in it before the release.
 *
 * The npm account is matched to the history only through its registry e-mail address, hashed with
 * the same salt as commit e-mails (HistoryRecord.npmPublishers). An account that cannot be matched
 * gives no observation: a different commit address is not evidence of anything. Releases made
 * through npm trusted publishing (an OIDC CI identity) are skipped, as in derivePublisherChange.
 *
 * Output: repo-level observations with fixed wording and no account name, like the P2 changes.
 */
import type { CommitHistoryChange, ReleasePublishersValue } from '../core/types.js';
import { HISTORY_RULES, shallowCensorUntil } from './aggregate.js';
import { isReleaseBot } from './bots.js';
import type { HistoryRecord } from './record.js';

const DAY = 86400;
const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

export interface NpmContinuity {
  changes: CommitHistoryChange[];
  accounts: number;
  matched: number;
}

/** First activity (commit authored or committed, or tag) of every id, up to `asOf`. */
function firstSeen(rec: HistoryRecord, asOf: Date): Map<string, number> {
  const end = Math.floor(asOf.getTime() / 1000);
  const first = new Map<string, number>();
  const see = (id: string, at: number) => {
    if (at >= end) return;
    if (!first.has(id) || at < first.get(id)!) first.set(id, at);
  };
  for (const c of rec.commits) {
    see(c.author, c.at);
    see(c.committer, c.at);
  }
  for (const t of rec.tags) see(t.by, t.at);
  // Shallow clone (Tier 0.5): early first-seen dates mean "on or before" (aggregate.ts).
  const censor = shallowCensorUntil(rec);
  if (censor !== undefined) for (const [id, at] of first) if (at < censor) first.set(id, Math.min(at, rec.shallowSince! - DAY));
  return first;
}

export interface NpmContinuityOptions {
  /** An account that already published a sibling package (same owner or npm scope) at that time. */
  establishedElsewhere?: (account: string, atMs: number) => boolean;
  /**
   * Tier 0.5: the versions in use are all stable, so an account's pre-release-only publishing says
   * nothing about them; its first stable release is the observation (none: no observation).
   */
  stableOnly?: boolean;
}

export function npmContinuity(rec: HistoryRecord, publishers: ReleasePublishersValue, asOf: Date, opts: NpmContinuityOptions | ((account: string, atMs: number) => boolean) = {}): NpmContinuity {
  const o: NpmContinuityOptions = typeof opts === 'function' ? { establishedElsewhere: opts } : opts;
  const establishedElsewhere = o.establishedElsewhere;
  const links = rec.npmPublishers ?? {};
  const first = firstSeen(rec, asOf);
  const end = Math.floor(asOf.getTime() / 1000);
  const repoStart = Math.min(...rec.commits.filter((c) => c.at < end).map((c) => c.at));
  // Trusted publishing (an OIDC CI identity) and organisation release bots are not a person.
  const people = publishers.accounts.filter((a) => !a.trusted && !isReleaseBot(a.name));
  const changes: CommitHistoryChange[] = [];
  let matched = 0;
  for (const a of people) {
    const id = Object.hasOwn(links, a.name) ? links[a.name] : undefined;
    if (!id) continue;
    matched++;
    const rel = o.stableOnly ? (a.firstStableVersion !== undefined ? { version: a.firstStableVersion, at: a.firstStableAt!, index: a.firstStableIndex! } : undefined) : { version: a.firstVersion, at: a.firstAt, index: a.index };
    if (!rel) continue;
    // The package's first release, and releases while the repository itself is young, say nothing.
    if (rel.index === 0) continue;
    const at = Math.floor(Date.parse(rel.at) / 1000);
    if (!Number.isFinite(at) || at >= end || (at - repoStart) / DAY < HISTORY_RULES.newReleaserDays) continue;
    // An account that had been publishing pre-releases of the package long before its first stable
    // release is no newcomer (stack-trace: 1.0.0-pre1 in 2021, 1.0.0 in 2026 by the same account).
    if (o.stableOnly && (at - Math.floor(Date.parse(a.firstAt) / 1000)) / DAY >= HISTORY_RULES.newReleaserDays) continue;
    // Tier 0: an account that already published a sibling package (same owner or npm scope) is a team member.
    if (establishedElsewhere?.(a.name, at * 1000)) continue;
    const seen = first.get(id);
    if (seen !== undefined && seen <= at) {
      const days = Math.floor((at - seen) / DAY);
      if (days >= HISTORY_RULES.newReleaserDays) continue;
      changes.push({
        kind: 'npm_release_by_new_account',
        date: iso(at),
        release: rel.version,
        daysSinceFirstSeen: days,
        before: rel.index,
        text: `Release ${rel.version} was published on npm by an account first seen in this repository ${days} days earlier (release ${rel.index + 1} of the package; account matched by its registry e-mail address).`,
      });
    } else {
      changes.push({
        kind: 'npm_release_by_new_account',
        date: iso(at),
        release: rel.version,
        before: rel.index,
        text: `Release ${rel.version} was published on npm by an account with no earlier commit in this repository (release ${rel.index + 1} of the package; account matched by its registry e-mail address).`,
      });
    }
  }
  return { changes, accounts: people.length, matched };
}

/**
 * A pre-release version: semver with a pre-release part ("7.0.0-beta.9"), or PEP 440 alpha / beta /
 * release candidate / development releases ("2.0rc1", "1.0a2", "3.1.dev0"). Tags are read through
 * releaseVersion first ("v7.0.0-beta.9" → "7.0.0-beta.9").
 */
export function isPrereleaseVersion(v: string): boolean {
  const s = v.trim().replace(/^v(?=\d)/i, '');
  if (/^\d+(\.\d+)*-/.test(s)) return true;
  return /^\d+(\.\d+)*(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?\d*)(?:\.post\d+)?(?:\.dev\d*)?$/i.test(s) || /^\d+(\.\d+)*.*\.dev\d*$/i.test(s);
}
