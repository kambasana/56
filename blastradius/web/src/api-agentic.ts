/**
 * Client for the agentic proposals (docs/WEB-API.md "Proposed facts", types in
 * ../../src/server/api-types-agentic.ts). Same transport, CSRF header and errors as api.ts.
 */
import type { AgentDecision, AgentProposalRow, AgentProposalsResponse, AgentProposalStatus } from '@server/api-types-agentic';
import { request, withQuery } from './api';

export type * from '@server/api-types-agentic';

export const agenticApi = {
  proposals: (q: { status?: AgentProposalStatus; task?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request<AgentProposalsResponse>('GET', withQuery('/api/agentic/proposals', q), undefined, signal),
  decide: (id: string, decision: AgentDecision, note?: string) =>
    request<AgentProposalRow>('POST', `/api/agentic/proposals/${encodeURIComponent(id)}/${decision}`, note ? { note } : {}),
};
