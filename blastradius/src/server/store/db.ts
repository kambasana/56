/**
 * SQLite store core (node:sqlite, synchronous). One `Store` per process; every repository
 * function takes it as its first argument.
 *
 * - Foreign keys are on. File databases use WAL.
 * - Schema changes are forward-only migrations (migrations.ts), applied on open.
 * - `tx()` nests through savepoints, so repository functions can be composed.
 * - `now()` is injectable so tests control timestamps.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { migrate } from './migrations.js';

export interface Store {
  db: DatabaseSync;
  now(): Date;
}

export interface OpenStoreOptions {
  /** File path, or ':memory:' (default). */
  path?: string;
  /** Clock override (tests). */
  now?: () => Date;
}

export function openStore(opts: OpenStoreOptions = {}): Store {
  const path = opts.path ?? ':memory:';
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return { db, now: opts.now ?? (() => new Date()) };
}

export function closeStore(s: Store): void {
  stmtCache.delete(s.db);
  s.db.close();
}

/** Error codes match ApiErrorCode so the server can map them 1:1. */
export type StoreErrorCode = 'bad_request' | 'not_found' | 'conflict';

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    readonly fields?: string[],
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export function isStoreError(e: unknown): e is StoreError {
  return e instanceof StoreError;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export type Param = SQLInputValue | boolean | undefined;

const stmtCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepare(s: Store, sql: string): StatementSync {
  let m = stmtCache.get(s.db);
  if (!m) {
    m = new Map();
    stmtCache.set(s.db, m);
  }
  let st = m.get(sql);
  if (!st) {
    st = s.db.prepare(sql);
    m.set(sql, st);
  }
  return st;
}

function norm(params: readonly Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function all<T>(s: Store, sql: string, ...params: Param[]): T[] {
  return prepare(s, sql).all(...norm(params)) as T[];
}

export function get<T>(s: Store, sql: string, ...params: Param[]): T | undefined {
  return prepare(s, sql).get(...norm(params)) as T | undefined;
}

export function run(s: Store, sql: string, ...params: Param[]): { changes: number } {
  const r = prepare(s, sql).run(...norm(params));
  return { changes: Number(r.changes) };
}

let spCounter = 0;

/** Run `fn` atomically. Nested calls use savepoints; any throw rolls back to the start. */
export function tx<T>(s: Store, fn: () => T): T {
  const name = `sp_${++spCounter}`;
  s.db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    s.db.exec(`RELEASE ${name}`);
    return out;
  } catch (e) {
    s.db.exec(`ROLLBACK TO ${name}`);
    s.db.exec(`RELEASE ${name}`);
    throw e;
  }
}

/** SQLite constraint violation (UNIQUE etc.) from node:sqlite. */
export function isConstraintError(e: unknown, kind?: 'UNIQUE' | 'FOREIGN KEY' | 'CHECK'): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  if (!/constraint failed/i.test(msg)) return false;
  return kind === undefined || msg.includes(kind);
}

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

/** Opaque id, URL- and filename-safe: `${prefix}_` + 12 base64url chars. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function nowIso(s: Store): string {
  return s.now().toISOString();
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export function clampLimit(limit: number | undefined, def = DEFAULT_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return def;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Offset cursors: opaque to clients (base64url of "o:<n>"). */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  const text = /^[A-Za-z0-9_-]{1,40}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  const m = /^o:(\d{1,9})$/.exec(text);
  if (!m) throw new StoreError('bad_request', 'Invalid cursor', ['cursor']);
  return Number(m[1]);
}

/** Resolve paging from either an explicit offset or a cursor. */
export function pageWindow(q: { limit?: number; offset?: number; cursor?: string }): { limit: number; offset: number } {
  const limit = clampLimit(q.limit);
  const offset = q.offset !== undefined ? Math.max(0, Math.floor(q.offset)) : decodeCursor(q.cursor);
  return { limit, offset };
}

export function nextCursorFor(offset: number, count: number, total: number): string | null {
  return offset + count < total ? encodeCursor(offset + count) : null;
}

/** Escape a LIKE pattern for use with `ESCAPE '\'`. */
export function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `?, ?, ?` for an IN list. Callers must not pass an empty list. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
