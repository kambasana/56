/**
 * Raw record store for the known-bad feeds (docs/FEEDS-AND-DETECTORS.md §2.2), node:sqlite.
 *
 * One row per (source, id): modified, SHA-256 of the record bytes, firstSeenAt, lastSeenAt,
 * withdrawnAt and the record itself (deflated JSON). Upserts only write when `modified` is newer
 * or the hash differs, so a sync is idempotent and safe to re-run. Withdrawn records become
 * tombstones; nothing is ever deleted, so "what did we know at time T" stays answerable.
 * Per-source high-water marks live in `mark`.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface FeedRecordRow {
  source: string;
  id: string;
  modified: string;
  sha256: string;
  firstSeenAt: string;
  lastSeenAt: string;
  withdrawnAt: string | null;
  /** 1 when the record belongs in the known-bad index (decided at upsert by the source). */
  relevant: boolean;
}

export interface UpsertInput {
  source: string;
  id: string;
  /** Normalised timestamp (see normTs) of the record's own `modified`. */
  modified: string;
  /** Record bytes as published (hashed and stored deflated). */
  json: string;
  withdrawnAt?: string | null;
  relevant: boolean;
}

export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  modified TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  withdrawn_at TEXT,
  relevant INTEGER NOT NULL DEFAULT 0,
  json BLOB NOT NULL,
  UNIQUE (source, id)
);
CREATE INDEX IF NOT EXISTS record_relevant ON record (source, relevant, id);
CREATE TABLE IF NOT EXISTS mark (
  source TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * Timestamps from feeds differ in precision ("2020-02-21T20:20:53Z" vs nanoseconds). Normalise to
 * a fixed 9-digit fraction so plain string comparison orders them.
 */
export function normTs(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts.trim());
  if (!m) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) throw new Error(`bad timestamp "${ts}"`);
    return normTs(d.toISOString());
  }
  if (m[3] !== 'Z') return normTs(new Date(ts).toISOString());
  return `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}Z`;
}

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export class FeedStore {
  readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, opts: { now?: () => Date } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.now = opts.now ?? (() => new Date());
  }

  close(): void {
    this.db.close();
  }

  /** Rows changed since the connection opened (idempotence checks). */
  totalChanges(): number {
    return Number((this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get(source: string, id: string): (FeedRecordRow & { json: string }) | null {
    const r = this.db.prepare('SELECT * FROM record WHERE source = ? AND id = ?').get(source, id) as Record<string, unknown> | undefined;
    return r ? { ...rowOf(r), json: inflateRawSync(r.json as Uint8Array).toString('utf8') } : null;
  }

  /** Stored `modified` for an id (cheap check before fetching a record). */
  modifiedOf(source: string, id: string): string | null {
    const r = this.db.prepare('SELECT modified FROM record WHERE source = ? AND id = ?').get(source, id) as { modified: string } | undefined;
    return r?.modified ?? null;
  }

  upsert(rec: UpsertInput): UpsertResult {
    const hash = sha256(rec.json);
    const now = this.now().toISOString();
    const withdrawn = rec.withdrawnAt ?? null;
    const cur = this.db.prepare('SELECT modified, sha256, withdrawn_at FROM record WHERE source = ? AND id = ?').get(rec.source, rec.id) as
      | { modified: string; sha256: string; withdrawn_at: string | null }
      | undefined;
    if (!cur) {
      this.db
        .prepare('INSERT INTO record (source, id, modified, sha256, first_seen_at, last_seen_at, withdrawn_at, relevant, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(rec.source, rec.id, rec.modified, hash, now, now, withdrawn, rec.relevant ? 1 : 0, deflateRawSync(rec.json));
      return 'inserted';
    }
    // Older or identical content never overwrites (out-of-order or repeated fetches).
    if (rec.modified < cur.modified || (cur.sha256 === hash && cur.withdrawn_at === withdrawn)) return 'unchanged';
    this.db
      .prepare('UPDATE record SET modified = ?, sha256 = ?, last_seen_at = ?, withdrawn_at = ?, relevant = ?, json = ? WHERE source = ? AND id = ?')
      .run(rec.modified, hash, now, withdrawn, rec.relevant ? 1 : 0, deflateRawSync(rec.json), rec.source, rec.id);
    return 'updated';
  }

  /** Tombstone ids of a snapshot source that are no longer listed. Returns how many. */
  tombstoneMissing(source: string, present: ReadonlySet<string>, at: string): number {
    let n = 0;
    for (const { id } of this.db.prepare('SELECT id FROM record WHERE source = ? AND withdrawn_at IS NULL').all(source) as { id: string }[]) {
      if (present.has(id)) continue;
      this.db.prepare('UPDATE record SET withdrawn_at = ?, last_seen_at = ? WHERE source = ? AND id = ?').run(at, this.now().toISOString(), source, id);
      n++;
    }
    return n;
  }

  /** Mark rows of a snapshot source as seen now (only when the snapshot changed). */
  touch(source: string, ids: Iterable<string>): void {
    const st = this.db.prepare('UPDATE record SET last_seen_at = ? WHERE source = ? AND id = ? AND withdrawn_at IS NULL');
    const now = this.now().toISOString();
    for (const id of ids) st.run(now, source, id);
  }

  /** Live (not withdrawn) relevant records of a source, ordered by id. */
  *relevant(source: string): Generator<{ id: string; modified: string; json: string }> {
    const it = this.db.prepare('SELECT id, modified, json FROM record WHERE source = ? AND relevant = 1 AND withdrawn_at IS NULL ORDER BY id').iterate(source) as Iterable<{ id: string; modified: string; json: Uint8Array }>;
    for (const r of it) yield { id: r.id, modified: r.modified, json: inflateRawSync(r.json).toString('utf8') };
  }

  count(source: string): { total: number; live: number; relevant: number; withdrawn: number; newestModified: string | null } {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS total, SUM(withdrawn_at IS NULL) AS live, SUM(relevant = 1 AND withdrawn_at IS NULL) AS relevant, SUM(withdrawn_at IS NOT NULL) AS withdrawn, MAX(modified) AS newest FROM record WHERE source = ?',
      )
      .get(source) as { total: number; live: number | null; relevant: number | null; withdrawn: number | null; newest: string | null };
    return { total: Number(r.total), live: Number(r.live ?? 0), relevant: Number(r.relevant ?? 0), withdrawn: Number(r.withdrawn ?? 0), newestModified: r.newest };
  }

  getMark(source: string): string | null {
    const r = this.db.prepare('SELECT value FROM mark WHERE source = ?').get(source) as { value: string } | undefined;
    return r?.value ?? null;
  }

  /** Writes only when the value changes. */
  setMark(source: string, value: string): void {
    if (this.getMark(source) === value) return;
    this.db.prepare('INSERT INTO mark (source, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(source, value, this.now().toISOString());
  }

  marks(): Record<string, string> {
    return Object.fromEntries((this.db.prepare('SELECT source, value FROM mark ORDER BY source').all() as { source: string; value: string }[]).map((r) => [r.source, r.value]));
  }
}

function rowOf(r: Record<string, unknown>): FeedRecordRow {
  return {
    source: r.source as string,
    id: r.id as string,
    modified: r.modified as string,
    sha256: r.sha256 as string,
    firstSeenAt: r.first_seen_at as string,
    lastSeenAt: r.last_seen_at as string,
    withdrawnAt: (r.withdrawn_at as string | null) ?? null,
    relevant: r.relevant === 1,
  };
}
