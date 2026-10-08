/**
 * Incidents in the store: the status of each advisory that hit a project (incident_state), its
 * timeline beyond the alerts themselves (incident_event: status changes, notifications sent), and
 * every org-wide check of stored inventories (alert_check). The incidents themselves are derived
 * from alerts (see ../incidents.ts).
 */
import type { IncidentEvent, IncidentStatus } from '../api-types-incidents.js';
import { INCIDENT_STATUSES } from '../api-types-incidents.js';
import { writeAudit } from './audit.js';
import { all, get, nowIso, placeholders, run, tx, type Store } from './db.js';

export function isIncidentStatus(v: unknown): v is IncidentStatus {
  return typeof v === 'string' && (INCIDENT_STATUSES as readonly string[]).includes(v);
}

export const INCIDENT_STATUS_LABEL: Readonly<Record<IncidentStatus, string>> = {
  investigating: 'Investigating',
  fixing: 'Fixing',
  monitoring: 'Monitoring',
  closed: 'Closed',
};

export interface IncidentStateRow {
  advisoryId: string;
  status: IncidentStatus;
  updatedAt: string;
  updatedBy: string;
}

/** Stored states by advisory id (absent = Investigating). */
export function incidentStates(s: Store, orgId: string, advisoryIds?: readonly string[]): Map<string, IncidentStateRow> {
  if (advisoryIds && advisoryIds.length === 0) return new Map();
  const filter = advisoryIds ? ` AND advisory_id IN (${placeholders(advisoryIds.length)})` : '';
  const rows = all<IncidentStateRow>(
    s,
    `SELECT advisory_id AS advisoryId, status, updated_at AS updatedAt, updated_by AS updatedBy FROM incident_state WHERE org_id = ?${filter}`,
    orgId,
    ...(advisoryIds ?? []),
  );
  return new Map(rows.map((r) => [r.advisoryId, r] as const));
}

/** When each incident was last closed (only for incidents whose status is Closed now). */
export function closedAt(s: Store, orgId: string, advisoryId: string): string | null {
  return get<{ at: string }>(s, `SELECT at FROM incident_event WHERE org_id = ? AND advisory_id = ? AND kind = 'status' AND to_value = 'closed' ORDER BY seq DESC LIMIT 1`, orgId, advisoryId)?.at ?? null;
}

/** Move an incident to `status`; records a timeline event and an audit entry. No-op when unchanged. */
export function setIncidentStatus(s: Store, orgId: string, advisoryId: string, status: IncidentStatus, actor: { id: string; name: string }): boolean {
  return tx(s, () => {
    const prev = incidentStates(s, orgId, [advisoryId]).get(advisoryId)?.status ?? 'investigating';
    if (prev === status) return false;
    const at = nowIso(s);
    run(
      s,
      `INSERT INTO incident_state (org_id, advisory_id, status, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (org_id, advisory_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      orgId,
      advisoryId,
      status,
      at,
      actor.id,
    );
    run(
      s,
      `INSERT INTO incident_event (org_id, advisory_id, at, actor, kind, title, detail, from_value, to_value) VALUES (?, ?, ?, ?, 'status', ?, ?, ?, ?)`,
      orgId,
      advisoryId,
      at,
      actor.id,
      `${actor.name} moved it to ${INCIDENT_STATUS_LABEL[status]}`,
      `Status: ${INCIDENT_STATUS_LABEL[prev]} → ${INCIDENT_STATUS_LABEL[status]}`,
      prev,
      status,
    );
    writeAudit(s, { orgId, actor: actor.id, action: 'incident.status', target: advisoryId, detail: { from: prev, to: status } });
    return true;
  });
}

/** A notification that left the server (Slack webhook), on the timeline of each named advisory. */
export function recordNotified(s: Store, orgId: string, advisoryIds: readonly string[], actor: string, title: string, detail: string): void {
  if (advisoryIds.length === 0) return;
  tx(s, () => {
    const at = nowIso(s);
    for (const id of new Set(advisoryIds)) {
      run(s, `INSERT INTO incident_event (org_id, advisory_id, at, actor, kind, title, detail) VALUES (?, ?, ?, ?, 'notified', ?, ?)`, orgId, id, at, actor, title.slice(0, 300), detail.slice(0, 1000));
    }
  });
}

/** Status changes and notifications, oldest first. */
export function incidentEvents(s: Store, orgId: string, advisoryId: string): IncidentEvent[] {
  return all<{ at: string; kind: 'status' | 'notified'; title: string; detail: string; from_value: string | null; to_value: string | null }>(
    s,
    'SELECT at, kind, title, detail, from_value, to_value FROM incident_event WHERE org_id = ? AND advisory_id = ? ORDER BY seq',
    orgId,
    advisoryId,
  ).map((r) => ({ at: r.at, kind: r.kind, title: r.title, detail: r.detail, ...(r.kind === 'status' ? { from: r.from_value, to: r.to_value } : {}) }));
}

export interface AlertCheckRow {
  at: string;
  source: 'pack' | 'advisories';
  projectsChecked: number;
  created: number;
}

/** One org-wide check of stored inventories. */
export function recordAlertCheck(s: Store, orgId: string, source: 'pack' | 'advisories', projectsChecked: number, created: number): void {
  run(s, 'INSERT INTO alert_check (org_id, at, source, projects_checked, created) VALUES (?, ?, ?, ?, ?)', orgId, nowIso(s), source, projectsChecked, created);
}

/** Checks at or after `since`, oldest first (newest 50). */
export function alertChecks(s: Store, orgId: string, since?: string): AlertCheckRow[] {
  return all<AlertCheckRow>(
    s,
    `SELECT * FROM (SELECT seq, at, source, projects_checked AS projectsChecked, created FROM alert_check WHERE org_id = ? AND at >= ? ORDER BY seq DESC LIMIT 50) ORDER BY seq`,
    orgId,
    since ?? '',
  ).map(({ at, source, projectsChecked, created }) => ({ at, source, projectsChecked, created }));
}

export function latestAlertCheck(s: Store, orgId: string): AlertCheckRow | null {
  return get<AlertCheckRow>(s, 'SELECT at, source, projects_checked AS projectsChecked, created FROM alert_check WHERE org_id = ? ORDER BY seq DESC LIMIT 1', orgId) ?? null;
}
