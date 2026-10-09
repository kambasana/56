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
  {
    version: 2,
    name: 'member invites',
    sql: `
-- Pending member invites (POST /api/members outside dev mode). Only the token's SHA-256 is
-- stored. Nothing is granted until the invitee accepts: the bindings wait here as JSON.
CREATE TABLE invite (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  name         TEXT NOT NULL,
  bindings     TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  accepted_by  TEXT,
  revoked_at   TEXT
);
CREATE INDEX invite_org_email ON invite(org_id, email);
`,
  },
  {
    version: 3,
    name: 'report json sha256',
    sql: `
-- SHA-256 of the exact bytes of GET /api/reports/:scanId.json (the rendered JSON report), so
-- the Reports page shows a hash anyone can check against the download. result_sha256 stays the
-- hash of the stored (compact) ScanResult. Rows stored before this migration are filled in on
-- first listing.
ALTER TABLE scan ADD COLUMN report_sha256 TEXT;
`,
  },
  {
    version: 4,
    name: 'finding reach text',
    sql: `
-- Reach in plain words ("Brought in by event-stream · used by api (production)"), built from the
-- finding's dependency paths at insert time. NULL for rows stored before this migration; the API
-- then falls back to a sentence from the counts.
ALTER TABLE finding ADD COLUMN reach_text TEXT;
`,
  },
  {
    version: 5,
    name: 'alerts',
    sql: `
-- Org-wide incident mode: one row per (project, component, advisory) found by checking new
-- advisories or the knowledge pack against stored inventories. Never re-created once seen.
CREATE TABLE alert (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scan_id TEXT,
  purl TEXT NOT NULL,
  advisory_id TEXT NOT NULL,
  advisory_published TEXT,
  production INTEGER NOT NULL DEFAULT 0,
  reach_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, project_id, purl, advisory_id)
);
CREATE INDEX alert_org_created ON alert (org_id, created_at DESC);
`,
  },
  {
    version: 6,
    name: 'finding triage: fixing, resolved, owner, risk expiry',
    sql: `
-- Finding life cycle (docs/UX.md §5): adds fixing and resolved, the owner a finding is assigned
-- to, and when an accepted risk runs out. SQLite cannot change a CHECK, so the table is rebuilt.
CREATE TABLE finding_state_v6 (
  project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  purl             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('new', 'reviewed', 'fixing', 'resolved', 'accepted_risk')),
  owner_id         TEXT REFERENCES app_user(id) ON DELETE SET NULL,
  risk_expires_at  TEXT,
  updated_at       TEXT NOT NULL,
  updated_by       TEXT NOT NULL,
  PRIMARY KEY (project_id, purl)
);
INSERT INTO finding_state_v6 (project_id, purl, status, updated_at, updated_by)
  SELECT project_id, purl, status, updated_at, updated_by FROM finding_state;
DROP TABLE finding_state;
ALTER TABLE finding_state_v6 RENAME TO finding_state;
CREATE INDEX finding_state_owner ON finding_state(owner_id);
`,
  },
  {
    version: 7,
    name: 'incidents',
    sql: `
-- An incident is one advisory that hit at least one project (its alerts). The advisory's own
-- severity, summary and first fixed version are kept on each alert when the advisory names them.
ALTER TABLE alert ADD COLUMN level TEXT CHECK (level IS NULL OR level IN ('critical', 'high', 'medium', 'low'));
ALTER TABLE alert ADD COLUMN summary TEXT;
ALTER TABLE alert ADD COLUMN fixed_in TEXT;
CREATE INDEX alert_org_advisory ON alert (org_id, advisory_id);

-- Where the team is with an incident (Investigating > Fixing > Monitoring > Closed). No row means
-- Investigating.
CREATE TABLE incident_state (
  org_id      TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  advisory_id TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('investigating', 'fixing', 'monitoring', 'closed')),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (org_id, advisory_id)
);

-- The incident's timeline beyond its alerts: status changes and notifications sent.
CREATE TABLE incident_event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  advisory_id TEXT NOT NULL,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('status', 'notified')),
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  from_value  TEXT,
  to_value    TEXT
);
CREATE INDEX incident_event_advisory ON incident_event (org_id, advisory_id, seq);

-- Every org-wide check of stored inventories (the pack sweep, or advisories posted to the API).
CREATE TABLE alert_check (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  at               TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('pack', 'advisories')),
  projects_checked INTEGER NOT NULL,
  created          INTEGER NOT NULL
);
CREATE INDEX alert_check_org ON alert_check (org_id, seq);
`,
  },
  {
    version: 8,
    name: 'alert rules',
    sql: `
-- Team alert rules (WHEN severity >= min_level [and it reaches production] THEN post to the Slack
-- webhook, naming the channel). With no rows, every new alert is posted (the default rule).
CREATE TABLE alert_rule (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  min_level       TEXT NOT NULL CHECK (min_level IN ('critical', 'high', 'medium', 'low')),
  production_only INTEGER NOT NULL DEFAULT 0,
  channel         TEXT NOT NULL,
  email_owners    INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  UNIQUE (org_id, name)
);
`,
  },
  {
    version: 9,
    name: 'account index and compromised accounts',
    sql: `
-- Account index (docs/ACCOUNT-PROOF.md): public registry data, shared by every org. One row per
-- package whose packument was fetched: current maintainers, the repository owner, and every
-- version's publish time, publisher (_npmUser) and maintainers, so "who could publish it at T" is
-- answerable for any T. versions_json: { sets: string[][], v: [version, time, publisher, setIndex, gone][] }.
CREATE TABLE registry_package (
  registry         TEXT NOT NULL CHECK (registry IN ('npm')),
  name             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('ok', 'missing', 'unavailable')),
  detail           TEXT,
  fetched_at       TEXT NOT NULL,
  maintainers_json TEXT NOT NULL DEFAULT '[]',
  repo_host        TEXT,
  repo_owner       TEXT,
  repo_url         TEXT,
  versions_json    TEXT NOT NULL DEFAULT '{"sets":[],"v":[]}',
  PRIMARY KEY (registry, name)
);

-- Packages an account can publish according to the registry's own listing (npm: /-/user/<u>/package).
CREATE TABLE registry_account (
  registry      TEXT NOT NULL CHECK (registry IN ('npm')),
  name          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'unavailable')),
  detail        TEXT,
  fetched_at    TEXT NOT NULL,
  packages_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (registry, name)
);

-- Who can publish what (package level, public data), derived from registry_package and
-- registry_account: maintainer (packument maintainers), repo_owner (owner of the declared
-- repository), listed (the account's own package listing). Who published a locked version
-- (_npmUser) is read per org from registry_package.versions_json, never stored per org here.
CREATE TABLE account_link (
  account_registry TEXT NOT NULL CHECK (account_registry IN ('npm', 'github', 'gitlab')),
  account          TEXT NOT NULL,
  package          TEXT NOT NULL,
  relation         TEXT NOT NULL CHECK (relation IN ('maintainer', 'repo_owner', 'listed')),
  source           TEXT NOT NULL,
  confidence       TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  evidence         TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (account_registry, account, package, relation)
);
CREATE INDEX account_link_package ON account_link (package);

-- "Account X is compromised" in one org: the incident it opened (alerts use incident_id as their
-- advisory id) and the window it covers.
CREATE TABLE account_incident (
  org_id           TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  incident_id      TEXT NOT NULL,
  account_registry TEXT NOT NULL,
  account          TEXT NOT NULL,
  since            TEXT,
  marked_at        TEXT NOT NULL,
  marked_by        TEXT NOT NULL,
  PRIMARY KEY (org_id, incident_id)
);

-- Incident timelines gain 'account' events (an account marked compromised, its exposure updated).
CREATE TABLE incident_event_v9 (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  advisory_id TEXT NOT NULL,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('status', 'notified', 'account')),
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  from_value  TEXT,
  to_value    TEXT
);
INSERT INTO incident_event_v9 (seq, org_id, advisory_id, at, actor, kind, title, detail, from_value, to_value)
  SELECT seq, org_id, advisory_id, at, actor, kind, title, detail, from_value, to_value FROM incident_event;
DROP TABLE incident_event;
ALTER TABLE incident_event_v9 RENAME TO incident_event;
CREATE INDEX incident_event_advisory ON incident_event (org_id, advisory_id, seq);
`,
  },
  {
    version: 10,
    name: 'repo connectors',
    sql: `
-- Connected code hosts (docs/CONNECTORS.md). GitHub stores no token: installation tokens are
-- minted per use from the App key in the environment. A pending row holds the SHA-256 of the
-- single-use install state until GitHub sends the browser back.
CREATE TABLE source (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  host                  TEXT NOT NULL CHECK (host IN ('github')),
  installation_id       TEXT,
  account               TEXT,
  account_type          TEXT,
  repository_selection  TEXT CHECK (repository_selection IN ('all', 'selected')),
  auto_watch            INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'access_lost', 'disconnected')),
  health                TEXT,
  health_checked_at     TEXT,
  state_hash            TEXT,
  state_expires_at      TEXT,
  created_at            TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX source_org ON source(org_id, created_at);
-- One org per installation.
CREATE UNIQUE INDEX source_installation ON source(host, installation_id) WHERE installation_id IS NOT NULL;

-- Repositories a source can read. Each scannable, watched repo is linked to a project, so
-- findings, alerts and blast radius work unchanged. Removing a repo keeps its project and history.
CREATE TABLE source_repo (
  id                     TEXT PRIMARY KEY,
  source_id              TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  org_id                 TEXT NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  repo_id                TEXT NOT NULL,
  full_name              TEXT NOT NULL,
  default_branch         TEXT,
  private                INTEGER NOT NULL DEFAULT 1,
  html_url               TEXT,
  lockfiles              TEXT NOT NULL DEFAULT '[]',
  files_read             TEXT NOT NULL DEFAULT '[]',
  watching               INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL CHECK (status IN ('discovering', 'watching', 'scanning', 'no_lockfile', 'unsupported', 'access_lost', 'removed', 'not_watched')),
  status_detail          TEXT,
  project_id             TEXT REFERENCES project(id) ON DELETE SET NULL,
  last_commit            TEXT,
  last_delivery_at       TEXT,
  last_delivery_outcome  TEXT,
  last_scan_at           TEXT,
  last_scan_id           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (source_id, repo_id)
);
CREATE UNIQUE INDEX source_repo_project ON source_repo(project_id) WHERE project_id IS NOT NULL;

-- Signed webhook deliveries, deduplicated by the host's delivery id. Unsigned or badly signed
-- deliveries are never stored (only counted), so they cannot fill this table.
CREATE TABLE webhook_delivery (
  host         TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  event        TEXT NOT NULL,
  action       TEXT,
  source_id    TEXT REFERENCES source(id) ON DELETE SET NULL,
  repo_id      TEXT,
  received_at  TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  PRIMARY KEY (host, delivery_id)
);
CREATE INDEX webhook_delivery_source ON webhook_delivery(source_id, received_at);
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
      // A failing rollback must never mask the original error.
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignored: rethrow the original below
      }
      throw e;
    }
    applied.push(m.version);
  }
  return applied;
}
