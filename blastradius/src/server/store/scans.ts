/**
 * Scans: queue -> running -> succeeded | failed. A succeeded scan stores the engine ScanResult
 * JSON (plus its SHA-256), a summary, the inventory's asset metadata and the finding rows.
 */
import { createHash } from 'node:crypto';
import type { Page, ReportFormat, ReportRow, Scan, ScanRef, ScanStatus, ScanSummary } from '../api-types.js';
import { REPORT_FORMATS } from '../api-types.js';
import type { Inventory, ScanResult } from '../../core/types.js';
import { writeAudit } from './audit.js';
import { all, get, isConstraintError, newId, nextCursorFor, nowIso, pageWindow, parseJson, placeholders, run, StoreError, tx, type Param, type Store } from './db.js';
import { assetMetaFromInventory, emptyCounts, insertFindingRows, isRiskLevel } from './findings.js';

interface ScanRow {
  id: string;
  project_id: string;
  org_id: string;
  status: ScanStatus;
  target: string;
  commit_sha: string | null;
  offline: number;
  requested_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  schema_version: string | null;
  summary_json: string | null;
}

const SCAN_COLUMNS =
  'id, project_id, org_id, status, target, commit_sha, offline, requested_by, created_at, started_at, finished_at, error, schema_version, summary_json';

function toScan(r: ScanRow): Scan {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    target: r.target,
    commit: r.commit_sha,
    offline: r.offline === 1,
    requestedBy: r.requested_by,
    startedAt: r.started_at,
    error: r.error,
    summary: r.status === 'succeeded' ? parseJson<ScanSummary | null>(r.summary_json, null) : null,
    schemaVersion: r.schema_version === '1' ? '1' : null,
  };
}

export function toScanRefFromScan(s: Scan): ScanRef {
  return { id: s.id, projectId: s.projectId, status: s.status, createdAt: s.createdAt, finishedAt: s.finishedAt };
}

export function summarizeResult(result: ScanResult): ScanSummary {
  const counts = emptyCounts();
  for (const f of result.findings) if (isRiskLevel(f.level)) counts[f.level]++;
  return {
    inventory: result.inventory,
    counts,
    findings: result.findings.length,
    outbound: result.outbound?.length ?? 0,
    warnings: (result.warnings ?? []).slice(0, 200),
  };
}

/** Max stored error length; the message must already be safe (no paths, no secrets). */
const MAX_ERROR = 500;

function safeError(msg: string): string {
  const one = msg.replace(/\s+/g, ' ').trim();
  return one.length > MAX_ERROR ? `${one.slice(0, MAX_ERROR)}…` : one || 'Scan failed';
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface EnqueueScanInput {
  requestedBy: string;
  offline?: boolean;
}

/** Queue a scan of the project's current target. 409 when one is already queued or running. */
export function enqueueScan(s: Store, orgId: string, projectId: string, input: EnqueueScanInput): Scan {
  return tx(s, () => {
    const p = get<{ target: string }>(s, 'SELECT target FROM project WHERE id = ? AND org_id = ?', projectId, orgId);
    if (!p) throw new StoreError('not_found', 'Project not found');
    const id = newId('scan');
    try {
      run(
        s,
        `INSERT INTO scan (id, project_id, org_id, status, target, offline, requested_by, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
        id,
        projectId,
        orgId,
        p.target,
        input.offline === true,
        input.requestedBy,
        nowIso(s),
      );
    } catch (e) {
      if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'A scan is already queued or running for this project');
      throw e;
    }
    writeAudit(s, { orgId, actor: input.requestedBy, action: 'scan.create', target: id, detail: { projectId, offline: input.offline === true } });
    return getScanById(s, id)!;
  });
}

function requireStatus(s: Store, scanId: string, allowed: ScanStatus[]): ScanRow {
  const r = get<ScanRow>(s, `SELECT ${SCAN_COLUMNS} FROM scan WHERE id = ?`, scanId);
  if (!r) throw new StoreError('not_found', 'Scan not found');
  if (!allowed.includes(r.status)) throw new StoreError('conflict', `Scan is ${r.status}`);
  return r;
}

export function markScanRunning(s: Store, scanId: string): Scan {
  return tx(s, () => {
    requireStatus(s, scanId, ['queued']);
    run(s, `UPDATE scan SET status = 'running', started_at = ? WHERE id = ?`, nowIso(s), scanId);
    return getScanById(s, scanId)!;
  });
}

/** Resolved commit sha for git targets; may be recorded while running or on completion. */
export function setScanCommit(s: Store, scanId: string, commit: string | null): void {
  if (commit !== null && !/^[0-9a-f]{7,64}$/i.test(commit)) throw new StoreError('bad_request', 'Invalid commit sha', ['commit']);
  run(s, 'UPDATE scan SET commit_sha = ? WHERE id = ?', commit, scanId);
}

export interface CompleteScanInput {
  result: ScanResult;
  /** The engine inventory (from `scan()`); its assets give names/environments to finding rows. */
  inventory?: Inventory;
  commit?: string | null;
  /** Also keep the whole inventory (edges included) for graphs. Default true. */
  storeInventory?: boolean;
}

/** Store the result and finding rows, and mark the scan succeeded, atomically. */
export function completeScan(s: Store, scanId: string, input: CompleteScanInput): Scan {
  return tx(s, () => {
    const row = requireStatus(s, scanId, ['queued', 'running']);
    if (input.commit !== undefined) setScanCommit(s, scanId, input.commit);
    const resultJson = JSON.stringify(input.result);
    const sha256 = createHash('sha256').update(resultJson, 'utf8').digest('hex');
    const assets = assetMetaFromInventory(input.inventory);
    const at = nowIso(s);
    run(
      s,
      `UPDATE scan SET status = 'succeeded', finished_at = ?, started_at = COALESCE(started_at, ?), error = NULL,
         schema_version = ?, result_json = ?, result_sha256 = ?, summary_json = ?, assets_json = ?, inventory_json = ?
       WHERE id = ?`,
      at,
      at,
      input.result.schemaVersion,
      resultJson,
      sha256,
      JSON.stringify(summarizeResult(input.result)),
      JSON.stringify(assets),
      input.inventory && input.storeInventory !== false ? JSON.stringify(input.inventory) : null,
      scanId,
    );
    insertFindingRows(s, { id: scanId, projectId: row.project_id, orgId: row.org_id, createdAt: row.created_at }, input.result.findings, assets);
    return getScanById(s, scanId)!;
  });
}

export function failScan(s: Store, scanId: string, error: string): Scan {
  return tx(s, () => {
    requireStatus(s, scanId, ['queued', 'running']);
    const at = nowIso(s);
    run(s, `UPDATE scan SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`, at, safeError(error), scanId);
    return getScanById(s, scanId)!;
  });
}

/** On server start: scans left queued/running by a previous process can never finish. */
export function failInterruptedScans(s: Store, message = 'Interrupted by a server restart'): number {
  return run(s, `UPDATE scan SET status = 'failed', finished_at = ?, error = ? WHERE status IN ('queued', 'running')`, nowIso(s), message).changes;
}

/** Queued scans, oldest first (for the job runner). */
export function listQueuedScans(s: Store, limit = 50): (Scan & { orgId: string })[] {
  return all<ScanRow>(s, `SELECT ${SCAN_COLUMNS} FROM scan WHERE status = 'queued' ORDER BY created_at, rowid LIMIT ?`, limit).map((r) => ({
    ...toScan(r),
    orgId: r.org_id,
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Unscoped lookup for the job runner. API handlers use getScan (org-scoped). */
export function getScanById(s: Store, scanId: string): (Scan & { orgId: string }) | null {
  const r = get<ScanRow>(s, `SELECT ${SCAN_COLUMNS} FROM scan WHERE id = ?`, scanId);
  return r ? { ...toScan(r), orgId: r.org_id } : null;
}

export function getScan(s: Store, orgId: string, scanId: string): Scan | null {
  const r = get<ScanRow>(s, `SELECT ${SCAN_COLUMNS} FROM scan WHERE id = ? AND org_id = ?`, scanId, orgId);
  return r ? toScan(r) : null;
}

/** Newest first. */
export function listScans(s: Store, orgId: string, projectId: string, q: { limit?: number; cursor?: string; offset?: number } = {}): Page<Scan> {
  const { limit, offset } = pageWindow(q);
  const total = get<{ n: number }>(s, 'SELECT count(*) AS n FROM scan WHERE project_id = ? AND org_id = ?', projectId, orgId)?.n ?? 0;
  const rows = all<ScanRow>(
    s,
    `SELECT ${SCAN_COLUMNS} FROM scan WHERE project_id = ? AND org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    projectId,
    orgId,
    limit,
    offset,
  );
  return { items: rows.map(toScan), total, nextCursor: nextCursorFor(offset, rows.length, total) };
}

export function latestScan(s: Store, projectId: string): ScanRef | null {
  const r = get<ScanRow>(s, `SELECT ${SCAN_COLUMNS} FROM scan WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, projectId);
  return r ? toScanRefFromScan(toScan(r)) : null;
}

/** Most recent scans across the org (any status), newest first. */
export function recentScans(s: Store, orgId: string, opts: { projectIds?: readonly string[] | null; limit?: number } = {}): ScanRef[] {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 10));
  if (opts.projectIds && opts.projectIds.length === 0) return [];
  const filter = opts.projectIds ? ` AND project_id IN (${placeholders(opts.projectIds.length)})` : '';
  return all<ScanRow>(
    s,
    `SELECT ${SCAN_COLUMNS} FROM scan WHERE org_id = ?${filter} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    orgId,
    ...(opts.projectIds ?? []),
    limit,
  ).map((r) => toScanRefFromScan(toScan(r)));
}

/** The stored engine result of a succeeded scan, and its SHA-256 (org-scoped). */
export function getScanResult(s: Store, orgId: string, scanId: string): { result: ScanResult; sha256: string; projectId: string } | null {
  const r = get<{ result_json: string | null; result_sha256: string | null; project_id: string }>(
    s,
    `SELECT result_json, result_sha256, project_id FROM scan WHERE id = ? AND org_id = ? AND status = 'succeeded'`,
    scanId,
    orgId,
  );
  if (!r?.result_json || !r.result_sha256) return null;
  const result = parseJson<ScanResult | null>(r.result_json, null);
  return result ? { result, sha256: r.result_sha256, projectId: r.project_id } : null;
}

/** The stored inventory of a succeeded scan, when it was kept (org-scoped). */
export function getScanInventory(s: Store, orgId: string, scanId: string): Inventory | null {
  const r = get<{ inventory_json: string | null }>(s, 'SELECT inventory_json FROM scan WHERE id = ? AND org_id = ?', scanId, orgId);
  return parseJson<Inventory | null>(r?.inventory_json, null);
}

/** Summaries of a project's succeeded scans, oldest first (last `limit`). */
export function succeededSummaries(s: Store, projectId: string, limit = 12): { id: string; createdAt: string; summary: ScanSummary | null }[] {
  return all<{ id: string; created_at: string; summary_json: string | null }>(
    s,
    `SELECT id, created_at, summary_json FROM (
       SELECT id, created_at, summary_json, rowid AS rid FROM scan WHERE project_id = ? AND status = 'succeeded'
       ORDER BY created_at DESC, rowid DESC LIMIT ?
     ) ORDER BY created_at ASC, rid ASC`,
    projectId,
    limit,
  ).map((r) => ({ id: r.id, createdAt: r.created_at, summary: parseJson<ScanSummary | null>(r.summary_json, null) }));
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function reportDownloads(scanId: string): Record<ReportFormat, string> {
  return Object.fromEntries(REPORT_FORMATS.map((f) => [f, `/api/reports/${scanId}.${f}`])) as Record<ReportFormat, string>;
}

/** GET /api/reports: one row per succeeded scan, newest first. `projectIds` limits visibility. */
export function listReports(
  s: Store,
  orgId: string,
  q: { projectId?: string; projectIds?: readonly string[] | null; limit?: number; cursor?: string; offset?: number } = {},
): Page<ReportRow> {
  const { limit, offset } = pageWindow(q);
  const where: string[] = [`sc.org_id = ?`, `sc.status = 'succeeded'`];
  const params: Param[] = [orgId];
  if (q.projectId !== undefined) {
    where.push('sc.project_id = ?');
    params.push(q.projectId);
  }
  if (q.projectIds) {
    if (q.projectIds.length === 0) return { items: [], total: 0, nextCursor: null };
    where.push(`sc.project_id IN (${placeholders(q.projectIds.length)})`);
    params.push(...q.projectIds);
  }
  const w = where.join(' AND ');
  const total = get<{ n: number }>(s, `SELECT count(*) AS n FROM scan sc WHERE ${w}`, ...params)?.n ?? 0;
  const rows = all<{ id: string; project_id: string; project_name: string; created_at: string; summary_json: string | null; result_sha256: string }>(
    s,
    `SELECT sc.id, sc.project_id, p.name AS project_name, sc.created_at, sc.summary_json, sc.result_sha256
     FROM scan sc JOIN project p ON p.id = sc.project_id WHERE ${w}
     ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return {
    items: rows.map((r) => ({
      scanId: r.id,
      project: { id: r.project_id, name: r.project_name },
      createdAt: r.created_at,
      counts: parseJson<ScanSummary | null>(r.summary_json, null)?.counts ?? emptyCounts(),
      downloads: reportDownloads(r.id),
      sha256: r.result_sha256,
    })),
    total,
    nextCursor: nextCursorFor(offset, rows.length, total),
  };
}

