/**
 * The history of one repository after reading and pseudonymisation: the input of the aggregates
 * (aggregate.ts) and the shape of the recorded test fixtures (test/history/record.ts).
 *
 * What it holds, by design:
 *   - commits: oid, parent count, author/committer ids (login or salted hash), day (UTC), whether
 *     a signature header is present, and the version when the subject is exactly a version
 *     (`npm version` writes the version as the commit message by default:
 *     https://docs.npmjs.com/cli/v10/using-npm/config#message, default "%s"). No names, emails, messages or time zones.
 *   - tags that look like releases: name, target commit, who made them, day, signed or not.
 *   - tzMonths: per calendar month, commit counts per UTC offset and per UTC hour of week. Read in
 *     a pass with no person fields, so a time zone is never linked to a person.
 * It is never stored in the database; only the aggregates (CommitHistoryValue) are.
 */
export interface HistoryCommit {
  oid: string;
  parents: number;
  author: string;
  committer: string;
  /** Committer date, midnight UTC, epoch seconds. */
  at: number;
  signed: boolean;
  version?: string;
}

export interface HistoryTag {
  name: string;
  /** Commit the tag points at. */
  commit: string;
  /** Tagger (annotated tag) or the commit's committer (lightweight tag). */
  by: string;
  at: number;
  signed: boolean;
  annotated: boolean;
}

export interface TzMonth {
  /** "+0300" → commits. */
  offsets: Record<string, number>;
  /** 168 counts, Monday 00:00 UTC first. */
  how: number[];
}

export interface HistoryRecord {
  /** https URL of the repository. */
  repo: string;
  head: string;
  /** Whether the repository has a .mailmap that git applied. */
  mailmap: boolean;
  /** Bot commits left out. */
  bots: number;
  /** Newest first (git log order). */
  commits: HistoryCommit[];
  /** Oldest first. */
  tags: HistoryTag[];
  tzMonths: Record<string, TzMonth>;
  /** Hashed ids and the latest commit of each, for the GitHub login lookup. */
  lookup: { id: string; oid: string }[];
  /**
   * npm accounts that published the package(s) of this repository, mapped to their id in this
   * history (P3, S5a): the registry e-mail address of the account (`_npmUser.email`) hashed with the
   * same salt as commit e-mails, kept only when that id occurs in the history. The address itself
   * is never kept. Absent when the link was not computed.
   */
  npmPublishers?: Record<string, string>;
}

/** Replace ids (e.g. hashed ids GitHub mapped to a login). Ids mapping to the same login merge. */
export function renameIds(rec: HistoryRecord, map: ReadonlyMap<string, string>): HistoryRecord {
  if (map.size === 0) return rec;
  const r = (id: string) => map.get(id) ?? id;
  return {
    ...rec,
    commits: rec.commits.map((c) => ({ ...c, author: r(c.author), committer: r(c.committer) })),
    tags: rec.tags.map((t) => ({ ...t, by: r(t.by) })),
    lookup: rec.lookup.filter((l) => !map.has(l.id)),
  };
}
