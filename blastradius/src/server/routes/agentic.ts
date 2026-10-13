/**
 * Agentic proposals (docs/WEB-API.md "Proposed facts").
 *   GET    /api/agentic/proposals[?status=&task=&limit=&cursor=]  proposals from scans of visible projects (page `investigate`)
 *   POST   /api/agentic/proposals/:id/confirm   pending org jurisdiction → confirmed (`review_entity_links`; audited)
 *   POST   /api/agentic/proposals/:id/reject    pending, unverified or verified → rejected (`review_entity_links`; audited)
 *   POST   /api/agentic/proposals/:id/remove    person data removed on request: value, quote and URL wiped (`review_entity_links`; audited)
 * Person-level rows (contributor identity, self-declared location) are listed only for `manage_projects`.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { AGENT_PROPOSAL_STATUSES, type AgentDecision, type AgentProposalRow, type AgentProposalsResponse } from '../api-types-agentic.js';
import { deps, requireOrgPerm, visibleProjects, type AppEnv } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { pageQuery, queryString, readJson } from '../request.js';
import { AgentDecisionError, decideAgentProposal, listAgentProposals } from '../store/index.js';
import type { AgentProposalStatus } from '../../core/agentic-types.js';

const decisionBody = z.object({ note: z.string().max(500).optional() }).strict();

export function registerAgenticRoutes(app: Hono<AppEnv>): void {
  app.get('/api/agentic/proposals', (c) => {
    const { orgId, projectIds } = visibleProjects(c, 'investigate');
    const status = queryString(c, 'status', 40);
    if (status !== undefined && !(AGENT_PROPOSAL_STATUSES as readonly string[]).includes(status)) throw badRequest(`status must be one of ${AGENT_PROPOSAL_STATUSES.join(', ')}`, ['status']);
    const task = queryString(c, 'task', 60);
    if (task !== undefined && !/^[a-z][a-z0-9_]{1,60}$/.test(task)) throw badRequest('invalid task', ['task']);
    const { store } = deps(c);
    // Decisions need the org-scope permission; the list only shows whether the viewer has it.
    let canReview = true;
    try {
      requireOrgPerm(c, 'review_entity_links');
    } catch {
      canReview = false;
    }
    let showPersonLevel = true;
    try {
      requireOrgPerm(c, 'manage_projects');
    } catch {
      showPersonLevel = false;
    }
    return c.json<AgentProposalsResponse>(
      listAgentProposals(store, orgId, { projectIds, ...(status ? { status: status as AgentProposalStatus } : {}), ...(task ? { task } : {}), ...pageQuery(c), canReview, showPersonLevel }),
    );
  });

  for (const decision of ['confirm', 'reject', 'remove'] as const satisfies readonly AgentDecision[]) {
    app.post(`/api/agentic/proposals/:id/${decision}`, async (c) => {
      const { orgId, session } = requireOrgPerm(c, 'review_entity_links');
      const id = c.req.param('id');
      if (!/^prop_[0-9a-f]{20}$/.test(id)) throw notFound('No such proposal');
      const parsed = decisionBody.safeParse(await readJson(c));
      if (!parsed.success) throw badRequest('note must be a string of at most 500 characters', ['note']);
      try {
        return c.json<AgentProposalRow>(decideAgentProposal(deps(c).store, orgId, id, decision, { id: session.user.id, name: session.user.name }, parsed.data.note));
      } catch (e) {
        if (e instanceof AgentDecisionError) throw e.code === 'not_found' ? notFound(e.message) : conflict(e.message);
        throw e;
      }
    });
  }
}
