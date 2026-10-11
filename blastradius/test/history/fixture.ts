/**
 * Compact fixture form of a HistoryRecord (src/history/record.ts). Commit oids are shortened to
 * 12 hex characters (only used to join tags to commits); `lookup` keeps full oids for GraphQL.
 * Ids are salted hashes made with a random salt that was discarded after recording, or GitHub
 * no-reply logins. No names, emails, messages or per-person time zones are in these files.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HistoryRecord } from '../../src/history/record.js';

export const RECORDED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'history', 'recorded');

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
  };
}

export function loadFixture(slug: string): { fixture: HistoryFixture; record: HistoryRecord } {
  const fixture = JSON.parse(readFileSync(join(RECORDED_DIR, `${slug}.json`), 'utf8')) as HistoryFixture;
  return { fixture, record: decodeFixture(fixture) };
}
