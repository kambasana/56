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
import { HISTORY_RULES } from './aggregate.js';
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
  return first;
}

export function npmContinuity(rec: HistoryRecord, publishers: ReleasePublishersValue, asOf: Date): NpmContinuity {
  const links = rec.npmPublishers ?? {};
  const first = firstSeen(rec, asOf);
  const end = Math.floor(asOf.getTime() / 1000);
  const repoStart = Math.min(...rec.commits.filter((c) => c.at < end).map((c) => c.at));
  const people = publishers.accounts.filter((a) => !a.trusted);
  const changes: CommitHistoryChange[] = [];
  let matched = 0;
  for (const a of people) {
    const id = Object.hasOwn(links, a.name) ? links[a.name] : undefined;
    if (!id) continue;
    matched++;
    // The package's first release, and releases while the repository itself is young, say nothing.
    if (a.index === 0) continue;
    const at = Math.floor(Date.parse(a.firstAt) / 1000);
    if (!Number.isFinite(at) || at >= end || (at - repoStart) / DAY < HISTORY_RULES.newReleaserDays) continue;
    const seen = first.get(id);
    if (seen !== undefined && seen <= at) {
      const days = Math.floor((at - seen) / DAY);
      if (days >= HISTORY_RULES.newReleaserDays) continue;
      changes.push({
        kind: 'npm_release_by_new_account',
        date: iso(at),
        release: a.firstVersion,
        daysSinceFirstSeen: days,
        before: a.index,
        text: `Release ${a.firstVersion} was published on npm by an account first seen in this repository ${days} days earlier (release ${a.index + 1} of the package; account matched by its registry e-mail address).`,
      });
    } else {
      changes.push({
        kind: 'npm_release_by_new_account',
        date: iso(at),
        release: a.firstVersion,
        before: a.index,
        text: `Release ${a.firstVersion} was published on npm by an account with no earlier commit in this repository (release ${a.index + 1} of the package; account matched by its registry e-mail address).`,
      });
    }
  }
  return { changes, accounts: people.length, matched };
}
