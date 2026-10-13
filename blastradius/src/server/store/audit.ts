/** Audit log: append-only record of role, binding, project, scan and finding-status changes. */
import type { AuditEntry, Page } from '../api-types.js';
import { all, get, newId, nextCursorFor, nowIso, pageWindow, parseJson, run, type Store } from './db.js';

export interface AuditInput {
  orgId: string | null;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

/** Keys never written to the audit log, whatever the caller passes. */
const SECRET_KEYS = /pass(word)?|secret|token|hash|cookie|authorization/i;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(x, depth + 1);
    return out;
  }
  if (typeof v === 'string' && v.length > 2000) return `${v.slice(0, 2000)}…`;
  return v;
}

export function writeAudit(s: Store, e: AuditInput): AuditEntry {
  const entry: AuditEntry = {
    id: newId('aud'),
    at: nowIso(s),
    actor: e.actor,
    action: e.action,
    target: e.target,
    detail: (scrub(e.detail ?? {}) as Record<string, unknown>) ?? {},
  };
  run(
    s,
    'INSERT INTO audit_log (id, org_id, at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    entry.id,
    e.orgId,
    entry.at,
    entry.actor,
    entry.action,
    entry.target,
    JSON.stringify(entry.detail),
  );
  return entry;
}

interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

/** Newest first. */
export function listAudit(
  s: Store,
  orgId: string,
  q: { limit?: number; cursor?: string; offset?: number; action?: string } = {},
): Page<AuditEntry> {
  const { limit, offset } = pageWindow(q);
  const where = q.action ? 'org_id = ? AND action = ?' : 'org_id = ?';
  const params = q.action ? [orgId, q.action] : [orgId];
  const total = get<{ n: number }>(s, `SELECT count(*) AS n FROM audit_log WHERE ${where}`, ...params)?.n ?? 0;
  const rows = all<AuditRow>(
    s,
    `SELECT id, at, actor, action, target, detail FROM audit_log WHERE ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return {
    items: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, target: r.target, detail: parseJson(r.detail, {}) })),
    total,
    nextCursor: nextCursorFor(offset, rows.length, total),
  };
}
