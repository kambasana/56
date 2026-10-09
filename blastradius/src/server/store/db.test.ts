import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { all, closeStore, decodeCursor, encodeCursor, get, likeEscape, newId, openStore, pageWindow, run, StoreError, tx } from './db.js';
import { ALL_PERMISSIONS, ROLE_TEMPLATES } from '../permissions.js';
import { currentVersion, migrate, MIGRATIONS, SCHEMA_VERSION } from './migrations.js';

describe('migrations', () => {
  it('applies every migration once and records the version', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
    expect(migrate(db)).toEqual([]);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    for (const t of ['org', 'project', 'scan', 'finding', 'finding_state', 'app_user', 'session', 'role', 'role_binding', 'audit_log', 'incident_state', 'incident_event', 'alert_check', 'alert_rule']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('numbers migrations 1..N with no gaps or repeats, the account index last', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(MIGRATIONS.slice(5).map((m) => [m.version, m.name])).toEqual([
      [6, 'finding triage: fixing, resolved, owner, risk expiry'],
      [7, 'incidents'],
      [8, 'alert rules'],
      [9, 'account index and compromised accounts'],
      [10, 'upgrade untouched built-in role defaults in every org'],
    ]);
    expect(SCHEMA_VERSION).toBe(10);
  });

  it('upgrades untouched built-in AppSec and Auditor roles in every existing org (v10), never customised ones', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.filter((m) => m.version < 10));
    const legacyAppsec = ['home', 'projects', 'reports', 'integrations', 'changes', 'findings', 'exposure', 'investigate', 'scans'];
    const role = db.prepare(`INSERT INTO role (org_id, id, name, description, builtin, template, permissions, updated_at) VALUES (?, ?, ?, 'old', 1, ?, ?, 't0')`);
    for (const org of ['org_a', 'org_b']) {
      db.prepare(`INSERT INTO org (id, name, slug, created_at) VALUES (?, ?, ?, 't0')`).run(org, org, org);
      role.run(org, 'org_admin', 'Org admin', 'org_admin', JSON.stringify(ALL_PERMISSIONS));
      role.run(org, 'developer', 'Developer', 'developer', JSON.stringify(ROLE_TEMPLATES.developer.permissions));
    }
    // org_a: both on the old defaults (appsec stored in another order, with a duplicate).
    role.run('org_a', 'appsec', 'AppSec', 'appsec', JSON.stringify([...legacyAppsec].reverse().concat('home')));
    role.run('org_a', 'auditor', 'Auditor', 'auditor', JSON.stringify(['reports']));
    // org_b: both customised.
    role.run('org_b', 'appsec', 'AppSec', 'appsec', JSON.stringify([...legacyAppsec, 'review']));
    role.run('org_b', 'auditor', 'Auditor', 'auditor', JSON.stringify(['reports', 'findings']));
    expect(migrate(db)).toEqual([10]);
    const perms = (org: string, id: string) =>
      JSON.parse((db.prepare('SELECT permissions FROM role WHERE org_id = ? AND id = ?').get(org, id) as { permissions: string }).permissions) as string[];
    expect(perms('org_a', 'appsec')).toEqual([...ROLE_TEMPLATES.appsec.permissions]);
    expect(perms('org_a', 'auditor')).toEqual([...ROLE_TEMPLATES.auditor.permissions]);
    expect((db.prepare(`SELECT description FROM role WHERE org_id = 'org_a' AND id = 'appsec'`).get() as { description: string }).description).toBe(
      ROLE_TEMPLATES.appsec.description,
    );
    expect(perms('org_b', 'appsec')).toEqual([...legacyAppsec, 'review']);
    expect(perms('org_b', 'auditor')).toEqual(['reports', 'findings']);
    expect(perms('org_a', 'developer')).toEqual([...ROLE_TEMPLATES.developer.permissions]);
    // Idempotent: nothing left to apply, rows unchanged.
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  it('keeps incident timeline events when incident_event is rebuilt (v9), and allows account events', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.filter((m) => m.version < 9));
    db.exec("INSERT INTO org (id, name, slug, created_at) VALUES ('org_1', 'Acme', 'acme', '2026-01-01T00:00:00Z')");
    db.exec("INSERT INTO incident_event (org_id, advisory_id, at, actor, kind, title) VALUES ('org_1', 'GHSA-1', '2026-01-01T00:00:00Z', 'u', 'status', 'moved')");
    expect(migrate(db)).toEqual(MIGRATIONS.filter((m) => m.version >= 9).map((m) => m.version));
    expect(db.prepare('SELECT advisory_id AS a, kind FROM incident_event').all()).toEqual([{ a: 'GHSA-1', kind: 'status' }]);
    db.exec("INSERT INTO incident_event (org_id, advisory_id, at, actor, kind, title) VALUES ('org_1', 'ACCOUNT-npm-qix', '2026-01-01T00:00:01Z', 'u', 'account', 'marked')");
    expect(() => db.exec("INSERT INTO incident_event (org_id, advisory_id, at, actor, kind, title) VALUES ('org_1', 'x', 'y', 'u', 'nope', 't')")).toThrow(/CHECK/);
  });

  it('keeps review statuses when the finding_state table is rebuilt (v6), and allows the new ones', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.filter((m) => m.version < 6));
    db.exec(`INSERT INTO org (id, name, slug, created_at) VALUES ('o', 'O', 'o', 't');
      INSERT INTO project (id, org_id, name, target, target_kind, tier, created_at, updated_at) VALUES ('p', 'o', 'p', '/x', 'local', 'Small', 't', 't');
      INSERT INTO finding_state (project_id, purl, status, updated_at, updated_by) VALUES ('p', 'pkg:npm/a@1', 'reviewed', 't', 'u');`);
    expect(migrate(db)).toEqual([6, ...MIGRATIONS.filter((m) => m.version > 6).map((m) => m.version)]);
    expect(db.prepare('SELECT status, owner_id, risk_expires_at FROM finding_state').all()).toEqual([{ status: 'reviewed', owner_id: null, risk_expires_at: null }]);
    db.exec(`UPDATE finding_state SET status = 'fixing'`);
    expect(() => db.exec(`UPDATE finding_state SET status = 'bogus'`)).toThrow(/CHECK/);
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

  it('rethrows the original error when the rollback itself fails', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    // The migration ends the transaction itself, so the runner's ROLLBACK fails too.
    const bad = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: 'bad', sql: 'ROLLBACK; SELECT * FROM no_such_table;' }];
    expect(() => migrate(db, bad)).toThrow(/no_such_table/);
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
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

  it('tx rethrows the original error when ROLLBACK TO fails', () => {
    const s = openStore();
    s.db.exec('CREATE TABLE t (x INTEGER)');
    expect(() =>
      tx(s, () => {
        run(s, 'INSERT INTO t VALUES (?)', 1);
        // Ends the transaction (and the savepoint), so the helper's ROLLBACK TO / RELEASE fail.
        s.db.exec('ROLLBACK');
        throw new Error('original failure');
      }),
    ).toThrow('original failure');
    expect(get<{ n: number }>(s, 'SELECT count(*) AS n FROM t')?.n).toBe(0);
    // The connection is usable afterwards.
    tx(s, () => run(s, 'INSERT INTO t VALUES (?)', 2));
    expect(get<{ n: number }>(s, 'SELECT count(*) AS n FROM t')?.n).toBe(1);
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
