import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { all, closeStore, decodeCursor, encodeCursor, get, likeEscape, newId, openStore, pageWindow, run, StoreError, tx } from './db.js';
import { currentVersion, migrate, MIGRATIONS, SCHEMA_VERSION } from './migrations.js';

describe('migrations', () => {
  it('applies every migration once and records the version', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
    expect(migrate(db)).toEqual([]);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    for (const t of ['org', 'project', 'scan', 'finding', 'finding_state', 'app_user', 'session', 'role', 'role_binding', 'audit_log']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('is forward-only: applies only newer migrations', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const next = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: 'extra', sql: 'CREATE TABLE extra (x INTEGER);' }];
    expect(migrate(db, next)).toEqual([SCHEMA_VERSION + 1]);
    expect(currentVersion(db)).toBe(SCHEMA_VERSION + 1);
    // An older build refuses a newer database.
    expect(() => migrate(db)).toThrow(/newer than this build/);
    db.close();
  });

  it('rolls back a failing migration', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const bad = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: 'bad', sql: 'CREATE TABLE ok1 (x); CREATE TABLE ok1 (x);' }];
    expect(() => migrate(db, bad)).toThrow();
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'ok1'`).get()).toBeUndefined();
    db.close();
  });
});

describe('store helpers', () => {
  it('nested tx rolls back only the inner savepoint when caught', () => {
    const s = openStore();
    s.db.exec('CREATE TABLE t (x INTEGER)');
    tx(s, () => {
      run(s, 'INSERT INTO t VALUES (?)', 1);
      try {
        tx(s, () => {
          run(s, 'INSERT INTO t VALUES (?)', 2);
          throw new Error('boom');
        });
      } catch {
        // ignored
      }
      run(s, 'INSERT INTO t VALUES (?)', 3);
    });
    expect(all<{ x: number }>(s, 'SELECT x FROM t ORDER BY x').map((r) => r.x)).toEqual([1, 3]);
    expect(() => tx(s, () => {
      run(s, 'INSERT INTO t VALUES (?)', 4);
      throw new Error('outer');
    })).toThrow('outer');
    expect(get<{ n: number }>(s, 'SELECT count(*) AS n FROM t')?.n).toBe(2);
    closeStore(s);
  });

  it('converts booleans and undefined parameters', () => {
    const s = openStore();
    s.db.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    run(s, 'INSERT INTO t VALUES (?, ?)', true, undefined);
    expect(get(s, 'SELECT a, b FROM t')).toMatchObject({ a: 1, b: null });
    closeStore(s);
  });

  it('cursors round-trip and reject garbage', () => {
    expect(decodeCursor(encodeCursor(150))).toBe(150);
    expect(decodeCursor(undefined)).toBe(0);
    expect(() => decodeCursor('not a cursor!')).toThrow(StoreError);
    expect(() => decodeCursor(Buffer.from('o:-1').toString('base64url'))).toThrow(StoreError);
    expect(pageWindow({ limit: 10_000 })).toEqual({ limit: 500, offset: 0 });
    expect(pageWindow({ limit: 0, offset: 7 })).toEqual({ limit: 1, offset: 7 });
  });

  it('ids are url-safe and escapes LIKE wildcards', () => {
    expect(newId('scan')).toMatch(/^scan_[A-Za-z0-9_-]{12}$/);
    expect(likeEscape('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('enforces foreign keys', () => {
    const s = openStore();
    expect(() => run(s, `INSERT INTO project (id, org_id, name, target, target_kind, tier, created_at, updated_at) VALUES ('p', 'nope', 'n', 't', 'local', 'Small', 'x', 'x')`)).toThrow(
      /FOREIGN KEY/,
    );
    closeStore(s);
  });
});

describe('file database', () => {
  it('persists across reopen and uses WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'br-store-'));
    try {
      const path = join(dir, 'br.db');
      const a = openStore({ path });
      expect(get<{ journal_mode: string }>(a, 'PRAGMA journal_mode')?.journal_mode).toBe('wal');
      run(a, `INSERT INTO org (id, name, slug, created_at) VALUES ('o1', 'A', 'a1', 'x')`);
      closeStore(a);
      const b = openStore({ path });
      expect(get<{ n: number }>(b, 'SELECT count(*) AS n FROM org')?.n).toBe(1);
      expect(get<{ n: number }>(b, 'SELECT count(*) AS n FROM schema_migrations')?.n).toBe(MIGRATIONS.length);
      closeStore(b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
