/**
 * Forward-only schema migrations. Never edit a shipped migration: append a new one.
 * `migrate()` applies every migration newer than the database's recorded version, each in
 * its own transaction, and refuses to open a database written by a newer build.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE org (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE app_user (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT,
  dev            INTEGER NOT NULL DEFAULT 0,
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE session (
  id_hash       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  org_id        TEXT REFERENCES org(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX session_user ON session(user_id);

CREATE TABLE project (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  target          TEXT NOT NULL,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('local', 'git')),
  tier            TEXT NOT NULL CHECK (tier IN ('Small', 'Standard', 'Large', 'Ecosystem')),
  tier_overrides  TEXT NOT NULL DEFAULT '{}',
  owner           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE scan (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  target          TEXT NOT NULL,
  commit_sha      TEXT,
  offline         INTEGER NOT NULL DEFAULT 0,
  requested_by    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  error           TEXT,
  schema_version  TEXT,
  result_json     TEXT,
  result_sha256   TEXT,
  summary_json    TEXT,
  assets_json     TEXT,
  inventory_json  TEXT
);
CREATE INDEX scan_project ON scan(project_id, created_at);
-- At most one queued or running scan per project (the API returns 409 otherwise).
CREATE UNIQUE INDEX scan_one_active ON scan(project_id) WHERE status IN ('queued', 'running');

CREATE TABLE finding (
  id            TEXT PRIMARY KEY,
  scan_id       TEXT NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  ord           INTEGER NOT NULL,
  purl          TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  ecosystem     TEXT NOT NULL,
  score         REAL NOT NULL,
  level         TEXT NOT NULL CHECK (level IN ('critical', 'high', 'medium', 'low')),
  level_rank    INTEGER NOT NULL,
  blast_score   REAL NOT NULL,
  assets        INTEGER NOT NULL,
  prod_assets   INTEGER NOT NULL,
  paths         INTEGER NOT NULL,
  top_factor    TEXT,
  top_detail    TEXT,
  factors       TEXT NOT NULL,
  behind        TEXT,
  search        TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  finding_json  TEXT NOT NULL,
  UNIQUE (scan_id, purl)
);
CREATE INDEX finding_scan_score ON finding(scan_id, score DESC);
CREATE INDEX finding_project_purl ON finding(project_id, purl);

-- Review status is per (project, versioned purl), so it carries across scans.
CREATE TABLE finding_state (
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  purl        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('new', 'reviewed', 'accepted_risk')),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (project_id, purl)
);

CREATE TABLE finding_status_history (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  purl         TEXT NOT NULL,
  at           TEXT NOT NULL,
  by_user      TEXT NOT NULL,
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  note         TEXT
);
CREATE INDEX finding_status_history_purl ON finding_status_history(project_id, purl, seq);

CREATE TABLE role (
  org_id       TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  builtin      INTEGER NOT NULL DEFAULT 0,
  template     TEXT,
  permissions  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (org_id, id),
  UNIQUE (org_id, name)
);

CREATE TABLE role_binding (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  role_id       TEXT NOT NULL,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('user', 'group')),
  subject_ref   TEXT NOT NULL,
  scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('org', 'project')),
  project_id    TEXT REFERENCES project(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  FOREIGN KEY (org_id, role_id) REFERENCES role(org_id, id) ON DELETE CASCADE,
  CHECK ((scope_kind = 'org' AND project_id IS NULL) OR (scope_kind = 'project' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX role_binding_unique
  ON role_binding(org_id, role_id, subject_kind, subject_ref, scope_kind, ifnull(project_id, ''));
CREATE INDEX role_binding_subject ON role_binding(subject_kind, subject_ref);

CREATE TABLE audit_log (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  org_id  TEXT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT NOT NULL,
  detail  TEXT NOT NULL
);
CREATE INDEX audit_org ON audit_log(org_id, seq);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function currentVersion(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/** Apply pending migrations. Returns the versions applied. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const have = currentVersion(db);
  const latest = migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;
  if (have > latest) {
    throw new Error(`Database schema version ${have} is newer than this build supports (${latest}). Upgrade blastradius.`);
  }
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= have) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    applied.push(m.version);
  }
  return applied;
}
