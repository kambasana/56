/**
 * Types for the agentic gap-filler (src/agentic, docs/WHO-BEHIND-PLAN.md §10 "Agentic
 * gap-filler"). Kept apart from types.ts so the shared contract file only gains two references:
 * the `agent_fact` fact value and `ScanResult.agentic`.
 *
 * A model proposes facts; the app verifies each one deterministically (re-fetch the source,
 * find the quoted text, check the source domain and the value against the quote). Only verified
 * proposals become facts. Everything else stays a proposal for review and is never shown as fact.
 */

/** A JSON value as proposed by the model and checked against the task's schema. */
export type AgentJson = string | number | boolean | null | AgentJson[] | { [k: string]: AgentJson };

/** What a fact request is about. Person-level subjects are only allowed for the self-declared location task. */
export type AgentSubjectKind = 'package' | 'org' | 'person';

/**
 * - `verified`: the gate passed; stored as an `agent_fact` fact.
 * - `pending_confirmation`: the gate passed but the task needs a human (org jurisdiction); not used by
 *   any policy or sanctions check until confirmed.
 * - `confirmed` / `rejected`: a reviewer's decision on a pending or unverified proposal.
 * - `unverified`: the gate failed; kept for review, never shown as fact.
 * - `removed`: removed on request (person data); the value and quote are wiped.
 */
export type AgentProposalStatus = 'verified' | 'pending_confirmation' | 'confirmed' | 'rejected' | 'unverified' | 'removed';

/** One check of the verification gate, in the order they run. */
export interface AgentGateCheck {
  check: 'task_binding' | 'schema' | 'privacy' | 'domain' | 'quote_length' | 'fetch' | 'quote_present' | 'task_rules';
  ok: boolean;
  detail?: string;
}

/** `agent_fact` value: a verified fact from the agentic gap-filler (Fact.source = `agent:<task>`). */
export interface AgentFactValue {
  task: string;
  /** The value, valid against the task's schema. */
  value: AgentJson;
  /** Exact text from the source the value rests on. */
  quote: string;
  sourceUrl: string;
  /** When the agent read the source (web_fetch retrieved_at, else the run time). */
  retrievedAt: string;
  /** When the app re-fetched the source and found the quote. */
  verifiedAt: string;
  /** The model's note on how sure it is and why; shown as the model's words. */
  confidenceNote: string;
  status: 'verified' | 'pending_confirmation' | 'confirmed';
  /** "self-declared" for the person location task. */
  label?: 'self-declared';
  /** Value fields the gate could not check against the source (e.g. "kind": an unverified backer kind). */
  unverifiedFields?: string[];
  /** Stable proposal id (review actions use it). */
  proposalId: string;
}

/** A proposal and its gate result (ScanResult.agentic.proposals). */
export interface AgentProposal {
  id: string;
  task: string;
  subject: string;
  subjectKind: AgentSubjectKind;
  value: AgentJson;
  sourceUrl: string;
  quote: string;
  retrievedAt: string;
  confidenceNote: string;
  status: AgentProposalStatus;
  checks: AgentGateCheck[];
  /** Why the gate failed (empty when it passed). */
  reasons: string[];
  label?: 'self-declared';
  /** Value fields the gate could not check against the source (e.g. a funding `kind`): kept, shown as unverified. */
  unverifiedFields?: string[];
  verifiedAt?: string;
}

/**
 * A proposal refused by the privacy guardrails. The value and quote are NOT kept: storing them is
 * exactly what the guardrail forbids. Only the task, subject and reason are recorded.
 */
export interface AgentPrivacyRejection {
  task: string;
  subject: string;
  reason: string;
}

/** A fact request refused before any model call (unknown task, privacy, person tasks off). */
export interface AgentRefusedRequest {
  task: string;
  subject: string;
  reason: string;
}

/** ScanResult.agentic: what the gap-filler did in one scan. */
export interface AgenticReport {
  model: string;
  /** Fact requests sent to the model (cache hits not counted). */
  runs: number;
  /** Requests answered from the result cache. */
  cached: number;
  /** Model API requests and tokens used (input incl. cache reads/writes, and output). */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** True when a per-scan budget stopped further requests. */
  budgetExhausted: boolean;
  proposals: AgentProposal[];
  privacyRejections: AgentPrivacyRejection[];
  refused: AgentRefusedRequest[];
}
