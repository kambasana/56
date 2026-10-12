/**
 * Compact fixture form of a HistoryRecord (src/history/record.ts). Commit oids are shortened to
 * 12 hex characters (only used to join tags to commits); `lookup` keeps full oids for GraphQL.
 * Ids are salted hashes made with a random salt that was discarded after recording, or GitHub
 * no-reply logins. No names, emails, messages or per-person time zones are in these files (display
 * names only as salted hashes, Tier 0).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryRecord } from './record.js';

type CommitRow = [oid: string, parents: number, author: number, committer: number, day: number, signed: 0 | 1, version?: string];
type TagRow = [name: string, commit: string, by: number, day: number, signed: 0 | 1, annotated: 0 | 1];

export interface HistoryFixture {
  _note: string;
  recordedAt: string;
  repo: string;
  head: string;
  mailmap: boolean;
  bots: number;
  /** Id table; rows refer to ids by index. */
  ids: string[];
  /** Newest first; day = days since 1970-01-01 (UTC). */
  commits: CommitRow[];
  tags: TagRow[];
  tzMonths: HistoryRecord['tzMonths'];
  lookup: HistoryRecord['lookup'];
  /** npm account → id in this history (P3 recordings only, see HistoryRecord.npmPublishers). */
  npmPublishers?: Record<string, string>;
  /** npm account → every id its registry addresses hash to (Tier 0 recordings). */
  npmPublisherIds?: Record<string, string[]>;
  /** id → salted display-name key (Tier 0 recordings, see HistoryRecord.names). */
  names?: Record<string, string>;
}

export function encodeFixture(rec: HistoryRecord, note: string, recordedAt: Date): HistoryFixture {
  const ids: string[] = [];
  const index = new Map<string, number>();
  const ix = (id: string) => {
    let i = index.get(id);
    if (i === undefined) {
      i = ids.length;
      ids.push(id);
      index.set(id, i);
    }
    return i;
  };
  return {
    _note: note,
    recordedAt: recordedAt.toISOString(),
    repo: rec.repo,
    head: rec.head,
    mailmap: rec.mailmap,
    bots: rec.bots,
    ids,
    commits: rec.commits.map((c) => {
      const row: CommitRow = [c.oid.slice(0, 12), c.parents, ix(c.author), ix(c.committer), c.at / 86400, c.signed ? 1 : 0];
      if (c.version) row.push(c.version);
      return row;
    }),
    tags: rec.tags.map((t) => [t.name, t.commit.slice(0, 12), ix(t.by), t.at / 86400, t.signed ? 1 : 0, t.annotated ? 1 : 0]),
    tzMonths: rec.tzMonths,
    lookup: rec.lookup,
    ...(rec.npmPublishers ? { npmPublishers: rec.npmPublishers } : {}),
    ...(rec.npmPublisherIds ? { npmPublisherIds: rec.npmPublisherIds } : {}),
    ...(rec.names ? { names: rec.names } : {}),
  };
}

export function decodeFixture(f: HistoryFixture): HistoryRecord {
  return {
    repo: f.repo,
    head: f.head,
    mailmap: f.mailmap,
    bots: f.bots,
    commits: f.commits.map(([oid, parents, a, c, day, signed, version]) => ({ oid, parents, author: f.ids[a]!, committer: f.ids[c]!, at: day * 86400, signed: signed === 1, ...(version ? { version } : {}) })),
    tags: f.tags.map(([name, commit, by, day, signed, annotated]) => ({ name, commit, by: f.ids[by]!, at: day * 86400, signed: signed === 1, annotated: annotated === 1 })),
    tzMonths: f.tzMonths,
    lookup: f.lookup,
    ...(f.npmPublishers ? { npmPublishers: f.npmPublishers } : {}),
    ...(f.npmPublisherIds ? { npmPublisherIds: f.npmPublisherIds } : {}),
    ...(f.names ? { names: f.names } : {}),
  };
}

/**
 * Recorded histories in `dir` (`*.json` in this format), by repository key as the history enricher
 * forms it (GitHub URLs lower-cased). Used for offline fixture replays (--dev-seed) and tests.
 */
export function recordedHistories(dir: string): (repoUrl: string) => HistoryRecord | undefined {
  const byRepo = new Map<string, HistoryFixture>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    // no recorded histories
  }
  for (const f of files) {
    try {
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf8')) as HistoryFixture;
      if (typeof fx.repo === 'string' && Array.isArray(fx.commits)) byRepo.set(fx.repo.toLowerCase(), fx);
    } catch {
      // skipped
    }
  }
  const decoded = new Map<string, HistoryRecord>();
  return (url) => {
    const key = url.toLowerCase();
    const fx = byRepo.get(key);
    if (!fx) return undefined;
    let rec = decoded.get(key);
    if (!rec) decoded.set(key, (rec = decodeFixture(fx)));
    return rec;
  };
}
