/**
 * Sources (connected code hosts), their repositories and webhook deliveries.
 *
 * Every connect, disconnect, access change and repo change writes an audit entry. Nothing here is
 * ever deleted because access was lost: rows are marked and their projects and history stay.
 * Reads of org-owned rows take an orgId and return null for other orgs (the API answers 404).
 */
import { createHash } from 'node:crypto';
import type { Source, SourceHostName, SourceRepo, SourceRepoStatus, SourceStatus } from '../api-types.js';
import { writeAudit } from './audit.js';
import { all, get, isConstraintError, newId, nowIso, parseJson, run, StoreError, tx, type Store } from './db.js';

interface SourceRowSql {
  id: string;
  org_id: string;
  host: SourceHostName;
  installation_id: string | null;
  account: string | null;
  account_type: string | null;
  repository_selection: 'all' | 'selected' | null;
  auto_watch: number;
  status: SourceStatus;
  health: string | null;
  health_checked_at: string | null;
  state_hash: string | null;
  state_expires_at: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

interface SourceRepoRowSql {
  id: string;
  source_id: string;
  org_id: string;
  repo_id: string;
  full_name: string;
  default_branch: string | null;
  private: number;
  html_url: string | null;
  lockfiles: string;
  files_read: string;
  watching: number;
  status: SourceRepoStatus;
  status_detail: string | null;
  project_id: string | null;
  last_commit: string | null;
  last_delivery_at: string | null;
  last_delivery_outcome: string | null;
  last_scan_at: string | null;
  last_scan_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Internal view: the API Source plus the org it belongs to. */
export interface SourceRecord extends Source {
  orgId: string;
}

export interface SourceRepoRecord extends SourceRepo {
  orgId: string;
}

function toSource(s: Store, r: SourceRowSql): SourceRecord {
  const counts = get<{ total: number; watching: number; lost: number }>(
    s,
    `SELECT count(*) AS total, coalesce(sum(watching), 0) AS watching, coalesce(sum(status = 'access_lost'), 0) AS lost FROM source_repo WHERE source_id = ? AND status != 'removed'`,
    r.id,
  ) ?? { total: 0, watching: 0, lost: 0 };
  const last = get<{ received_at: string; event: string; outcome: string }>(
    s,
    'SELECT received_at, event, outcome FROM webhook_delivery WHERE source_id = ? ORDER BY received_at DESC LIMIT 1',
    r.id,
  );
  return {
    id: r.id,
    orgId: r.org_id,
    host: r.host,
    account: r.account,
    accountType: r.account_type,
    installationId: r.installation_id,
    repositorySelection: r.repository_selection,
    autoWatch: r.auto_watch === 1,
    status: r.status,
    health: r.health,
    healthCheckedAt: r.health_checked_at,
    repos: { total: counts.total, watching: counts.watching, accessLost: counts.lost },
    lastDelivery: last ? { at: last.received_at, event: last.event, outcome: last.outcome } : null,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  };
}

function toRepo(r: SourceRepoRowSql): SourceRepoRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    sourceId: r.source_id,
    repoId: r.repo_id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private === 1,
    htmlUrl: r.html_url,
    lockfiles: parseJson<string[]>(r.lockfiles, []),
    filesRead: parseJson<string[]>(r.files_read, []),
    watching: r.watching === 1,
    status: r.status,
    statusDetail: r.status_detail,
    projectId: r.project_id,
    lastCommit: r.last_commit,
    lastDeliveryAt: r.last_delivery_at,
    lastDeliveryOutcome: r.last_delivery_outcome,
    lastScanAt: r.last_scan_at,
    lastScanId: r.last_scan_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Public shape (no orgId). */
export function publicSource(src: SourceRecord): Source {
  const { orgId: _o, ...rest } = src;
  return rest;
}
export function publicRepo(repo: SourceRepoRecord): SourceRepo {
  const { orgId: _o, ...rest } = repo;
  return rest;
}

export const hashState = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A pending source for an install in progress. `stateSecret` is stored only as its SHA-256. */
export function createPendingSource(
  s: Store,
  orgId: string,
  input: { host: SourceHostName; autoWatch: boolean; stateSecret: string; expiresAt: Date },
  actor: string,
): SourceRecord {
  return tx(s, () => {
    const id = newId('src');
    const at = nowIso(s);
    run(
      s,
      `INSERT INTO source (id, org_id, host, auto_watch, status, state_hash, state_expires_at, created_at, created_by, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      id,
      orgId,
      input.host,
      input.autoWatch,
      hashState(input.stateSecret),
      input.expiresAt.toISOString(),
      at,
      actor,
      at,
    );
    writeAudit(s, { orgId, actor, action: 'source.install_start', target: id, detail: { host: input.host, autoWatch: input.autoWatch } });
    return getSourceById(s, id)!;
  });
}

export function getSourceById(s: Store, id: string): SourceRecord | null {
  const r = get<SourceRowSql>(s, 'SELECT * FROM source WHERE id = ?', id);
  return r ? toSource(s, r) : null;
}

export function getSource(s: Store, orgId: string, id: string): SourceRecord | null {
  const r = get<SourceRowSql>(s, 'SELECT * FROM source WHERE id = ? AND org_id = ?', id, orgId);
  return r ? toSource(s, r) : null;
}

/** Sources of the org, newest first. Pending installs older than a day are left out. */
export function listSources(s: Store, orgId: string): SourceRecord[] {
  const cutoff = new Date(s.now().getTime() - 24 * 3600_000).toISOString();
  return all<SourceRowSql>(s, `SELECT * FROM source WHERE org_id = ? AND (status != 'pending' OR created_at >= ?) ORDER BY created_at DESC, rowid DESC`, orgId, cutoff).map((r) =>
    toSource(s, r),
  );
}

export function getSourceByInstallation(s: Store, host: SourceHostName, installationId: string): SourceRecord | null {
  const r = get<SourceRowSql>(s, 'SELECT * FROM source WHERE host = ? AND installation_id = ?', host, installationId);
  return r ? toSource(s, r) : null;
}

/**
 * Check a pending source's state secret (single use, unexpired). Returns the pending source, or
 * null when the state is unknown, used or expired. The state is consumed either way.
 */
export function consumeInstallState(s: Store, sourceId: string, stateSecret: string): SourceRecord | null {
  return tx(s, () => {
    const r = get<SourceRowSql>(s, `SELECT * FROM source WHERE id = ? AND status = 'pending'`, sourceId);
    if (!r || !r.state_hash || !r.state_expires_at) return null;
    run(s, 'UPDATE source SET state_hash = NULL WHERE id = ?', sourceId);
    const a = Buffer.from(r.state_hash, 'hex');
    const b = Buffer.from(hashState(stateSecret), 'hex');
    if (a.length !== b.length || !a.equals(b)) return null;
    if (r.state_expires_at <= nowIso(s)) return null;
    return toSource(s, r);
  });
}

export interface InstallationDetails {
  installationId: string;
  account: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
}

/**
 * Finish an install: the pending source becomes connected to the installation. When the same org
 * already has a source for that installation (a re-install), that one is reconnected and the
 * pending row dropped. Another org's installation is a conflict.
 */
export function connectSource(s: Store, pendingId: string, inst: InstallationDetails, actor: string): SourceRecord {
  return tx(s, () => {
    const pending = get<SourceRowSql>(s, `SELECT * FROM source WHERE id = ? AND status = 'pending'`, pendingId);
    if (!pending) throw new StoreError('not_found', 'Install not found or already finished');
    const existing = get<SourceRowSql>(s, 'SELECT * FROM source WHERE host = ? AND installation_id = ?', pending.host, inst.installationId);
    if (existing && existing.org_id !== pending.org_id) throw new StoreError('conflict', 'This installation is connected to another organisation');
    const at = nowIso(s);
    const targetId = existing ? existing.id : pendingId;
    if (existing) run(s, 'DELETE FROM source WHERE id = ?', pendingId);
    try {
      run(
        s,
        `UPDATE source SET installation_id = ?, account = ?, account_type = ?, repository_selection = ?, status = 'connected', health = NULL,
           health_checked_at = ?, state_hash = NULL, state_expires_at = NULL, auto_watch = ?, updated_at = ? WHERE id = ?`,
        inst.installationId,
        inst.account,
        inst.accountType,
        inst.repositorySelection,
        at,
        pending.auto_watch,
        at,
        targetId,
      );
    } catch (e) {
      if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'This installation is already connected');
      throw e;
    }
    const after = getSourceById(s, targetId)!;
    writeAudit(s, {
      orgId: pending.org_id,
      actor,
      action: 'source.connect',
      target: targetId,
      detail: { host: pending.host, installationId: inst.installationId, account: inst.account, repositorySelection: inst.repositorySelection, reconnected: Boolean(existing) },
    });
    return after;
  });
}

/** Status change with a safe health message; audited when the status changes. */
export function setSourceStatus(s: Store, id: string, status: SourceStatus, health: string | null, actor: string): SourceRecord {
  return tx(s, () => {
    const before = getSourceById(s, id);
    if (!before) throw new StoreError('not_found', 'Source not found');
    const at = nowIso(s);
    run(s, 'UPDATE source SET status = ?, health = ?, health_checked_at = ?, updated_at = ? WHERE id = ?', status, health, at, at, id);
    if (before.status !== status) {
      const action = status === 'access_lost' ? 'source.access_lost' : status === 'disconnected' ? 'source.disconnect' : status === 'connected' ? 'source.access_restored' : 'source.update';
      writeAudit(s, { orgId: before.orgId, actor, action, target: id, detail: { from: before.status, to: status, health } });
    }
    return getSourceById(s, id)!;
  });
}

export function updateSourceSettings(s: Store, orgId: string, id: string, patch: { autoWatch?: boolean; repositorySelection?: 'all' | 'selected'; account?: string }, actor: string): SourceRecord {
  return tx(s, () => {
    const before = getSource(s, orgId, id);
    if (!before) throw new StoreError('not_found', 'Source not found');
    run(
      s,
      'UPDATE source SET auto_watch = ?, repository_selection = ?, account = ?, updated_at = ? WHERE id = ?',
      patch.autoWatch ?? before.autoWatch,
      patch.repositorySelection ?? before.repositorySelection,
      patch.account ?? before.account,
      nowIso(s),
      id,
    );
    const after = getSourceById(s, id)!;
    writeAudit(s, { orgId, actor, action: 'source.update', target: id, detail: { before: { autoWatch: before.autoWatch, repositorySelection: before.repositorySelection }, after: { autoWatch: after.autoWatch, repositorySelection: after.repositorySelection } } });
    return after;
  });
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export function listSourceRepos(s: Store, sourceId: string): SourceRepoRecord[] {
  return all<SourceRepoRowSql>(s, 'SELECT * FROM source_repo WHERE source_id = ? ORDER BY full_name COLLATE NOCASE, rowid', sourceId).map(toRepo);
}

export function getSourceRepo(s: Store, orgId: string, sourceId: string, id: string): SourceRepoRecord | null {
  const r = get<SourceRepoRowSql>(s, 'SELECT * FROM source_repo WHERE id = ? AND source_id = ? AND org_id = ?', id, sourceId, orgId);
  return r ? toRepo(r) : null;
}

export function getSourceRepoById(s: Store, id: string): SourceRepoRecord | null {
  const r = get<SourceRepoRowSql>(s, 'SELECT * FROM source_repo WHERE id = ?', id);
  return r ? toRepo(r) : null;
}

export function getSourceRepoByHostId(s: Store, sourceId: string, repoId: string): SourceRepoRecord | null {
  const r = get<SourceRepoRowSql>(s, 'SELECT * FROM source_repo WHERE source_id = ? AND repo_id = ?', sourceId, repoId);
  return r ? toRepo(r) : null;
}

/** The connected repo behind a project, if the project came from a source. */
export function sourceRepoForProject(s: Store, projectId: string): { source: SourceRecord; repo: SourceRepoRecord } | null {
  const r = get<SourceRepoRowSql>(s, 'SELECT * FROM source_repo WHERE project_id = ?', projectId);
  if (!r) return null;
  const src = getSourceById(s, r.source_id);
  return src ? { source: src, repo: toRepo(r) } : null;
}

export interface RepoUpsert {
  repoId: string;
  fullName: string;
  defaultBranch?: string | null;
  private?: boolean;
  htmlUrl?: string | null;
}

/**
 * Add a repository the source can read, or refresh its name, branch and visibility. A repo that
 * was removed or had lost access comes back as "discovering". New repos are watched when the
 * source auto-watches. Returns the row and whether it was new (or came back).
 */
export function upsertSourceRepo(s: Store, source: SourceRecord, info: RepoUpsert, actor: string): { repo: SourceRepoRecord; added: boolean } {
  return tx(s, () => {
    const at = nowIso(s);
    const prev = getSourceRepoByHostId(s, source.id, info.repoId);
    if (!prev) {
      const id = newId('srp');
      run(
        s,
        `INSERT INTO source_repo (id, source_id, org_id, repo_id, full_name, default_branch, private, html_url, watching, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        source.id,
        source.orgId,
        info.repoId,
        info.fullName,
        info.defaultBranch ?? null,
        info.private ?? true,
        info.htmlUrl ?? null,
        source.autoWatch,
        source.autoWatch ? 'discovering' : 'not_watched',
        at,
        at,
      );
      writeAudit(s, { orgId: source.orgId, actor, action: 'source_repo.add', target: id, detail: { sourceId: source.id, repo: info.fullName, watching: source.autoWatch } });
      return { repo: getSourceRepoById(s, id)!, added: true };
    }
    const cameBack = prev.status === 'removed' || prev.status === 'access_lost';
    run(
      s,
      `UPDATE source_repo SET full_name = ?, default_branch = coalesce(?, default_branch), private = ?, html_url = coalesce(?, html_url),
         status = CASE WHEN status IN ('removed', 'access_lost') THEN (CASE WHEN watching = 1 THEN 'discovering' ELSE 'not_watched' END) ELSE status END,
         status_detail = CASE WHEN status IN ('removed', 'access_lost') THEN NULL ELSE status_detail END,
         updated_at = ? WHERE id = ?`,
      info.fullName,
      info.defaultBranch ?? null,
      info.private ?? prev.private,
      info.htmlUrl ?? null,
      at,
      prev.id,
    );
    if (cameBack) writeAudit(s, { orgId: source.orgId, actor, action: 'source_repo.add', target: prev.id, detail: { sourceId: source.id, repo: info.fullName, restored: true } });
    else if (prev.fullName !== info.fullName) writeAudit(s, { orgId: source.orgId, actor, action: 'source_repo.rename', target: prev.id, detail: { from: prev.fullName, to: info.fullName } });
    return { repo: getSourceRepoById(s, prev.id)!, added: cameBack };
  });
}

/** Taken out of the installation: stop watching, keep the project and its history. */
export function markSourceRepoRemoved(s: Store, repo: SourceRepoRecord, actor: string): void {
  if (repo.status === 'removed') return;
  run(s, `UPDATE source_repo SET status = 'removed', watching = 0, status_detail = NULL, updated_at = ? WHERE id = ?`, nowIso(s), repo.id);
  writeAudit(s, { orgId: repo.orgId, actor, action: 'source_repo.remove', target: repo.id, detail: { sourceId: repo.sourceId, repo: repo.fullName, projectId: repo.projectId } });
}

export function setSourceRepoWatching(s: Store, repo: SourceRepoRecord, watching: boolean, actor: string): SourceRepoRecord {
  return tx(s, () => {
    if (repo.watching === watching) return repo;
    const status: SourceRepoStatus = watching ? 'discovering' : 'not_watched';
    run(s, 'UPDATE source_repo SET watching = ?, status = ?, status_detail = NULL, updated_at = ? WHERE id = ?', watching, status, nowIso(s), repo.id);
    writeAudit(s, { orgId: repo.orgId, actor, action: watching ? 'source_repo.watch' : 'source_repo.unwatch', target: repo.id, detail: { sourceId: repo.sourceId, repo: repo.fullName } });
    return getSourceRepoById(s, repo.id)!;
  });
}

export interface RepoStatusPatch {
  status?: SourceRepoStatus;
  statusDetail?: string | null;
  lockfiles?: string[];
  filesRead?: string[];
  projectId?: string | null;
  lastCommit?: string | null;
  defaultBranch?: string;
  lastScanId?: string;
  lastScanAt?: string;
  lastDelivery?: { at: string; outcome: string };
}

/** Bookkeeping from discovery, scans and deliveries (not user changes: those are audited above). */
export function patchSourceRepo(s: Store, id: string, p: RepoStatusPatch): SourceRepoRecord {
  const cur = getSourceRepoById(s, id);
  if (!cur) throw new StoreError('not_found', 'Repository not found');
  run(
    s,
    `UPDATE source_repo SET status = ?, status_detail = ?, lockfiles = ?, files_read = ?, project_id = ?, last_commit = ?, default_branch = ?,
       last_scan_id = ?, last_scan_at = ?, last_delivery_at = ?, last_delivery_outcome = ?, updated_at = ? WHERE id = ?`,
    p.status ?? cur.status,
    p.statusDetail !== undefined ? p.statusDetail : cur.statusDetail,
    JSON.stringify(p.lockfiles ?? cur.lockfiles),
    JSON.stringify(p.filesRead ?? cur.filesRead),
    p.projectId !== undefined ? p.projectId : cur.projectId,
    p.lastCommit !== undefined ? p.lastCommit : cur.lastCommit,
    p.defaultBranch ?? cur.defaultBranch,
    p.lastScanId ?? cur.lastScanId,
    p.lastScanAt ?? cur.lastScanAt,
    p.lastDelivery?.at ?? cur.lastDeliveryAt,
    p.lastDelivery?.outcome ?? cur.lastDeliveryOutcome,
    nowIso(s),
    id,
  );
  return getSourceRepoById(s, id)!;
}

/** Access lost for every repo of a source (or one repo). Audited per call, never deletes. */
export function markReposAccessLost(s: Store, source: SourceRecord, detail: string, actor: string, repoId?: string): number {
  return tx(s, () => {
    const where = repoId ? `source_id = ? AND id = ? AND status != 'removed'` : `source_id = ? AND status != 'removed'`;
    const params = repoId ? [source.id, repoId] : [source.id];
    const { changes } = run(s, `UPDATE source_repo SET status = 'access_lost', status_detail = ?, updated_at = ? WHERE ${where}`, detail, nowIso(s), ...params);
    if (repoId && changes > 0) writeAudit(s, { orgId: source.orgId, actor, action: 'source_repo.access_lost', target: repoId, detail: { sourceId: source.id, reason: detail } });
    return changes;
  });
}

// ---------------------------------------------------------------------------
// Webhook deliveries
// ---------------------------------------------------------------------------

/** Record a signed delivery. False when this delivery id was already seen (a replay or a redelivery). */
export function recordDelivery(s: Store, d: { host: SourceHostName; deliveryId: string; event: string; action?: string | null; sourceId?: string | null; repoId?: string | null; outcome: string }): boolean {
  try {
    run(
      s,
      'INSERT INTO webhook_delivery (host, delivery_id, event, action, source_id, repo_id, received_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      d.host,
      d.deliveryId,
      d.event,
      d.action ?? null,
      d.sourceId ?? null,
      d.repoId ?? null,
      nowIso(s),
      d.outcome,
    );
    return true;
  } catch (e) {
    if (isConstraintError(e, 'UNIQUE')) return false;
    throw e;
  }
}

export function finishDelivery(s: Store, host: SourceHostName, deliveryId: string, outcome: string, sourceId?: string | null, repoId?: string | null): void {
  run(
    s,
    'UPDATE webhook_delivery SET outcome = ?, source_id = coalesce(?, source_id), repo_id = coalesce(?, repo_id) WHERE host = ? AND delivery_id = ?',
    outcome,
    sourceId ?? null,
    repoId ?? null,
    host,
    deliveryId,
  );
}

/** Drop delivery records older than `days` (dedupe only needs recent ids). */
export function pruneDeliveries(s: Store, days = 30): number {
  const cutoff = new Date(s.now().getTime() - days * 86400_000).toISOString();
  return run(s, 'DELETE FROM webhook_delivery WHERE received_at < ?', cutoff).changes;
}
