/**
 * Web API contract for the agentic gap-filler's proposals (docs/WEB-API.md "Proposed facts").
 * Type imports and constant tables only (the web app imports it through the @server alias).
 * Values, quotes and source URLs come from the web through a model and passed (or failed) the
 * app's verification gate: untrusted text, rendered as text only.
 */
import type { AgentGateCheck, AgentJson, AgentProposalStatus, AgentSubjectKind } from '../core/agentic-types.js';
import type { Id, IsoTime, Page, ProjectRef } from './api-types.js';

export type { AgentGateCheck, AgentJson, AgentProposalStatus, AgentSubjectKind };

export const AGENT_PROPOSAL_STATUSES: readonly AgentProposalStatus[] = ['pending_confirmation', 'unverified', 'verified', 'confirmed', 'rejected', 'removed'];

/** Words for each status, shared by the API docs and the web app. */
export const AGENT_PROPOSAL_STATUS_LABELS: Readonly<Record<AgentProposalStatus, string>> = {
  verified: 'Verified',
  pending_confirmation: 'Needs confirmation',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  unverified: 'Unverified proposal',
  removed: 'Removed on request',
};

export const AGENT_TASK_LABELS: Readonly<Record<string, string>> = {
  funding: 'Funding',
  governance: 'Governance',
  org_jurisdiction: 'Organisation jurisdiction',
  lifecycle_events: 'Lifecycle event',
  incident_writeups: 'Incident write-up',
  person_self_declared_location: 'Self-declared location',
  contributor_identity: 'Contributor identity',
};

export interface AgentProposalRow {
  id: Id;
  task: string;
  subject: string;
  subjectKind: AgentSubjectKind;
  status: AgentProposalStatus;
  /** Null once removed on request. */
  value: AgentJson | null;
  sourceUrl: string | null;
  quote: string | null;
  label: 'self-declared' | null;
  /** The model's own note (shown as such). */
  confidenceNote: string;
  checks: AgentGateCheck[];
  /** Why the gate failed; empty when it passed. */
  reasons: string[];
  retrievedAt: IsoTime | null;
  verifiedAt: IsoTime | null;
  firstSeenAt: IsoTime;
  lastSeenAt: IsoTime;
  project: ProjectRef | null;
  decidedBy: string | null;
  decidedAt: IsoTime | null;
  decisionNote: string | null;
}

export interface AgentProposalsResponse extends Page<AgentProposalRow> {
  /** Rows per status in the viewer's scope (before the status/task filter). */
  counts: Record<AgentProposalStatus, number>;
  /** The viewer may confirm, reject and remove (permission `review_entity_links`). */
  canReview: boolean;
  /**
   * Person-level rows (contributor identity, self-declared location) are included only for viewers
   * with `manage_projects`; false = they were left out of items and counts.
   */
  personLevelShown: boolean;
  /** Fixed explanation shown above the list. */
  note: string;
}

export const AGENT_DECISIONS = ['confirm', 'reject', 'remove'] as const;
export type AgentDecision = (typeof AGENT_DECISIONS)[number];

export interface AgentDecisionRequest {
  /** Optional reason, kept in the audit log (max 500 characters). */
  note?: string;
}

export const AGENT_PROPOSALS_NOTE =
  'Proposed by an AI agent from public pages. Only proposals the application verified (it re-fetched the source and found the quoted text) are used as facts; organisation jurisdiction is used only after a person confirms it. Unverified proposals are shown for review and are never used.';
