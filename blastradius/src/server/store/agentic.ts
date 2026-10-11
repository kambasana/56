/**
 * Agentic proposals (migration 12): stored from each scan's `ScanResult.agentic`, listed for
 * review, and decided by a person (confirm / reject / remove), every decision audited.
 *
 * Rules:
 * - A rescan refreshes a proposal's gate result, but never undoes a person's decision
 *   (confirmed, rejected, removed rows only get last-seen updated).
 * - Confirm is only for `pending_confirmation` (org jurisdiction); nothing else needs it.
 * - Remove (on request) wipes the value, quote and source URL for good; a later scan that proposes
 *   the same value again finds the removed row and does not restore it.
 * - Sanctions and policy checks (P7) read only `confirmed` org jurisdiction rows.
 */
import type { AgentJson, AgentProposal, AgentProposalStatus, AgenticReport } from '../../core/agentic-types.js';
import { AGENT_PROPOSAL_STATUSES, AGENT_PROPOSALS_NOTE, type AgentDecision, type AgentProposalRow, type AgentProposalsResponse } from '../api-types-agentic.js';
import { PERSON_TASKS } from '../../agentic/privacy.js';
import { writeAudit } from './audit.js';
import { all, get, nextCursorFor, nowIso, pageWindow, parseJson, run, tx, type Store } from './db.js';

interface Row {
  id: string;
  task: string;
  subject: string;
  subject_kind: string;
  status: string;
  value_json: string | null;
  source_url: string | null;
  quote: string | null;
  label: string | null;
  confidence: string;
  checks_json: string;
  reasons_json: string;
  retrieved_at: string | null;
  verified_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  project_id: string | null;
  project_name: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

const DECIDED: ReadonlySet<string> = new Set(['confirmed', 'rejected', 'removed']);

/** Store a scan's proposals (inside the scan's completion transaction). */
export function syncAgentProposals(s: Store, scope: { orgId: string; projectId: string; scanId: string | null }, report: AgenticReport | undefined): number {
  if (!report) return 0;
  const at = nowIso(s);
  let n = 0;
  for (const p of report.proposals) {
    const existing = get<{ status: string }>(s, 'SELECT status FROM agent_proposal WHERE org_id = ? AND id = ?', scope.orgId, p.id);
    if (existing && DECIDED.has(existing.status)) {
      run(s, 'UPDATE agent_proposal SET last_seen_at = ?, scan_id = ?, project_id = ? WHERE org_id = ? AND id = ?', at, scope.scanId, scope.projectId, scope.orgId, p.id);
      continue;
    }
    run(
      s,
      `INSERT INTO agent_proposal (org_id, id, task, subject, subject_kind, status, value_json, source_url, quote, label, confidence, checks_json, reasons_json,
         retrieved_at, verified_at, first_seen_at, last_seen_at, scan_id, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, id) DO UPDATE SET status = excluded.status, checks_json = excluded.checks_json, reasons_json = excluded.reasons_json,
         retrieved_at = excluded.retrieved_at, verified_at = excluded.verified_at, confidence = excluded.confidence,
         last_seen_at = excluded.last_seen_at, scan_id = excluded.scan_id, project_id = excluded.project_id`,
      scope.orgId,
      p.id,
      p.task,
      p.subject,
      p.subjectKind,
      p.status,
      JSON.stringify(p.value),
      p.sourceUrl,
      p.quote.slice(0, 2000),
      p.label ?? null,
      p.confidenceNote.slice(0, 500),
      JSON.stringify(p.checks),
      JSON.stringify(p.reasons),
      p.retrievedAt,
      p.verifiedAt ?? null,
      at,
      at,
      scope.scanId,
      scope.projectId,
    );
    n++;
  }
  return n;
}

function toRow(r: Row): AgentProposalRow {
  return {
    id: r.id,
    task: r.task,
    subject: r.subject,
    subjectKind: r.subject_kind as AgentProposalRow['subjectKind'],
    status: r.status as AgentProposalStatus,
    value: r.value_json === null ? null : parseJson<AgentJson>(r.value_json, null),
    sourceUrl: r.source_url,
    quote: r.quote,
    label: r.label === 'self-declared' ? 'self-declared' : null,
    confidenceNote: r.confidence,
    checks: parseJson(r.checks_json, []),
    reasons: parseJson(r.reasons_json, []),
    retrievedAt: r.retrieved_at,
    verifiedAt: r.verified_at,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    project: r.project_id ? { id: r.project_id, name: r.project_name ?? r.project_id } : null,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
  };
}

const SELECT = `SELECT a.*, p.name AS project_name FROM agent_proposal a LEFT JOIN project p ON p.id = a.project_id`;

/** Proposals visible to the viewer: every project (null) or only these projects. */
export function listAgentProposals(
  s: Store,
  orgId: string,
  q: { projectIds: readonly string[] | null; status?: AgentProposalStatus; task?: string; limit?: number; offset?: number; cursor?: string; canReview: boolean; showPersonLevel: boolean },
): AgentProposalsResponse {
  const where: string[] = ['a.org_id = ?'];
  const params: (string | number)[] = [orgId];
  // Person-level rows (contributor identity, self-declared location) only for manage_projects.
  if (!q.showPersonLevel) {
    where.push(`a.task NOT IN (${PERSON_TASKS.map(() => '?').join(',')})`);
    params.push(...PERSON_TASKS);
  }
  if (q.projectIds !== null) {
    if (q.projectIds.length === 0) where.push('0');
    else {
      where.push(`a.project_id IN (${q.projectIds.map(() => '?').join(',')})`);
      params.push(...q.projectIds);
    }
  }
  const counts = Object.fromEntries(AGENT_PROPOSAL_STATUSES.map((st) => [st, 0])) as Record<AgentProposalStatus, number>;
  for (const c of all<{ status: string; n: number }>(s, `SELECT a.status, count(*) AS n FROM agent_proposal a WHERE ${where.join(' AND ')} GROUP BY a.status`, ...params)) {
    if (c.status in counts) counts[c.status as AgentProposalStatus] = c.n;
  }
  const filtered = [...where];
  const fparams = [...params];
  if (q.status) {
    filtered.push('a.status = ?');
    fparams.push(q.status);
  }
  if (q.task) {
    filtered.push('a.task = ?');
    fparams.push(q.task);
  }
  const { limit, offset } = pageWindow(q);
  const total = get<{ n: number }>(s, `SELECT count(*) AS n FROM agent_proposal a WHERE ${filtered.join(' AND ')}`, ...fparams)?.n ?? 0;
  // Needs-a-person first, then unverified, then the rest; newest first inside.
  const rows = all<Row>(
    s,
    `${SELECT} WHERE ${filtered.join(' AND ')}
     ORDER BY CASE a.status WHEN 'pending_confirmation' THEN 0 WHEN 'unverified' THEN 1 WHEN 'verified' THEN 2 WHEN 'confirmed' THEN 3 ELSE 4 END, a.last_seen_at DESC, a.task, a.subject, a.id
     LIMIT ? OFFSET ?`,
    ...fparams,
    limit,
    offset,
  );
  return { items: rows.map(toRow), total, nextCursor: nextCursorFor(offset, rows.length, total), counts, canReview: q.canReview, personLevelShown: q.showPersonLevel, note: AGENT_PROPOSALS_NOTE };
}

export function getAgentProposal(s: Store, orgId: string, id: string): AgentProposalRow | undefined {
  const r = get<Row>(s, `${SELECT} WHERE a.org_id = ? AND a.id = ?`, orgId, id);
  return r ? toRow(r) : undefined;
}

export class AgentDecisionError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict',
  ) {
    super(message);
  }
}

/** Which decisions a status allows. */
export function allowedDecisions(status: AgentProposalStatus, task: string): AgentDecision[] {
  const out: AgentDecision[] = [];
  if (status === 'pending_confirmation') out.push('confirm');
  if (status === 'pending_confirmation' || status === 'unverified' || status === 'verified') out.push('reject');
  if (PERSON_TASKS.includes(task) && status !== 'removed') out.push('remove');
  return out;
}

/** Confirm, reject or remove a proposal; audited. */
export function decideAgentProposal(s: Store, orgId: string, id: string, decision: AgentDecision, actor: { id: string; name: string }, note?: string): AgentProposalRow {
  return tx(s, () => {
    const cur = getAgentProposal(s, orgId, id);
    if (!cur) throw new AgentDecisionError('No such proposal', 'not_found');
    if (!allowedDecisions(cur.status, cur.task).includes(decision)) {
      throw new AgentDecisionError(`A ${cur.status.replace(/_/g, ' ')} proposal cannot be ${decision === 'confirm' ? 'confirmed' : decision === 'reject' ? 'rejected' : 'removed'}`, 'conflict');
    }
    const at = nowIso(s);
    const cleanNote = note?.slice(0, 500) ?? null;
    if (decision === 'remove') {
      run(
        s,
        `UPDATE agent_proposal SET status = 'removed', value_json = NULL, quote = NULL, source_url = NULL, confidence = '', checks_json = '[]', reasons_json = '[]',
           decided_by = ?, decided_at = ?, decision_note = ? WHERE org_id = ? AND id = ?`,
        actor.name,
        at,
        cleanNote,
        orgId,
        id,
      );
    } else {
      run(s, 'UPDATE agent_proposal SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE org_id = ? AND id = ?', decision === 'confirm' ? 'confirmed' : 'rejected', actor.name, at, cleanNote, orgId, id);
    }
    // The audit entry names the proposal, never its personal value.
    writeAudit(s, { orgId, actor: actor.id, action: `agent_proposal.${decision}`, target: id, detail: { task: cur.task, subject: cur.subject, from: cur.status, ...(cleanNote ? { note: cleanNote } : {}) } });
    return getAgentProposal(s, orgId, id)!;
  });
}

/**
 * Inputs for org-level sanctions and jurisdiction policy (P7): confirmed org jurisdiction only.
 * Verified-but-unconfirmed values are never returned.
 */
export function confirmedJurisdictions(s: Store, orgId: string): { subject: string; value: AgentJson; sourceUrl: string | null; decidedBy: string | null; decidedAt: string | null }[] {
  return all<Row>(s, `${SELECT} WHERE a.org_id = ? AND a.task = 'org_jurisdiction' AND a.status = 'confirmed' ORDER BY a.subject, a.id`, orgId).map((r) => ({
    subject: r.subject,
    value: parseJson<AgentJson>(r.value_json, null),
    sourceUrl: r.source_url,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  }));
}

/** Insert proposals directly (dev seed). */
export function seedAgentProposals(s: Store, scope: { orgId: string; projectId: string; scanId: string | null }, proposals: readonly AgentProposal[]): number {
  return tx(s, () => syncAgentProposals(s, scope, { model: 'seed', runs: 0, cached: 0, requests: 0, inputTokens: 0, outputTokens: 0, budgetExhausted: false, proposals: [...proposals], privacyRejections: [], refused: [] }));
}
