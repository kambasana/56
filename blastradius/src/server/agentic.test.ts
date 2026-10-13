/**
 * Proposed facts API (docs/WEB-API.md "Proposed facts"): the dev seed's proposals (real gate output
 * on recorded pages), listing by permission, confirm / reject / remove with permission checks and
 * audit, decisions that survive rescans, removal of person data, and P7's confirmed-only input.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import type { AgentProposal } from '../core/agentic-types.js';
import type { AgentProposalRow, AgentProposalsResponse } from './api-types-agentic.js';
import type { ListAuditResponse } from './api-types.js';
import { createServer, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from './serve.js';
import { confirmedJurisdictions, get, syncAgentProposals } from './store/index.js';

type App = ReturnType<typeof createServer>;
const XRW = { 'X-Requested-With': 'blastradius' };

let srv: App;
let projectId: string;
let orgId: string;
const cookies: Record<string, string> = {};

async function call(method: string, path: string, opts: { as?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? XRW : {}) };
  if (opts.as) headers.Cookie = `br_session=${cookies[opts.as]}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return srv.app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}

async function list(as: string, q = ''): Promise<AgentProposalsResponse> {
  const res = await call('GET', `/api/agentic/proposals${q}`, { as });
  expect(res.status).toBe(200);
  return (await res.json()) as AgentProposalsResponse;
}

beforeAll(async () => {
  srv = createServer({
    devMode: true,
    offline: true,
    fixturesDir: FIXTURES_DIR,
    asOf: FIXTURE_AS_OF,
    webDir: null,
    scanOptions: {
      http: new HttpClient({ offline: true, fixturesDir: FIXTURES_DIR, cacheDir: false, minIntervalMs: 0, transport: async (r) => Promise.reject(new Error(`network in test: ${r.url}`)) }),
      cacheDir: false,
    },
    log: () => {},
  });
  const seed = await seedDevData(srv.deps);
  projectId = seed.projectId;
  orgId = seed.orgId;
  await srv.jobs.waitFor(seed.scanId!);
  for (const u of ['admin', 'appsec', 'auditor']) {
    const res = await call('POST', '/api/auth/login', { body: { email: `${u}@local`, password: 'blastradius-dev' } });
    expect(res.status).toBe(200);
    cookies[u] = /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  }
}, 60_000);

afterAll(() => srv.jobs.stop());

describe('GET /api/agentic/proposals', () => {
  it('lists the seeded proposals, people-needed first, with gate results and the fixed note', async () => {
    const body = await list('appsec');
    expect(body.counts).toMatchObject({ pending_confirmation: 2, unverified: 1, verified: 7, confirmed: 0, rejected: 0, removed: 0 });
    expect(body.items.slice(0, 2).map((r) => r.status)).toEqual(['pending_confirmation', 'pending_confirmation']);
    expect(body.items[2]!.status).toBe('unverified');
    expect(body.items[2]!.reasons).toEqual(['the quoted text is not on the source page']);
    expect(body.canReview).toBe(false);
    expect(body.note).toMatch(/never used/);
    for (const r of body.items) expect(r.project).toEqual({ id: projectId, name: 'payments-platform' });
  });

  it('filters by status and task, validates them, and is readable by the auditor', async () => {
    expect((await list('auditor', '?status=pending_confirmation')).items.map((r) => r.task)).toEqual(['org_jurisdiction', 'org_jurisdiction']);
    expect((await list('admin', '?task=funding')).total).toBe(5);
    expect((await call('GET', '/api/agentic/proposals?status=bogus', { as: 'admin' })).status).toBe(400);
    expect((await list('admin')).canReview).toBe(true);
    expect((await call('GET', '/api/agentic/proposals')).status).toBe(401);
  });
});

describe('contributor identity rows', () => {
  it('are hidden without manage_projects and removable on request', async () => {
    const row: AgentProposal = {
      id: 'prop_abcdefabcdefabcdef01',
      task: 'contributor_identity',
      subject: 'person:github/synthetic--profile',
      subjectKind: 'person',
      value: { field: 'role', role: 'lead maintainer', project: 'widget' },
      sourceUrl: 'https://github.com/synthetic--org/widget/blob/main/MAINTAINERS.md',
      quote: '@synthetic--profile (lead maintainer of widget since 2019)',
      retrievedAt: '2026-10-11T12:00:00Z',
      confidenceNote: 'synthetic',
      status: 'verified',
      checks: [],
      reasons: [],
    };
    syncAgentProposals(srv.store, { orgId, projectId, scanId: null }, { model: 'm', runs: 0, cached: 0, requests: 0, inputTokens: 0, outputTokens: 0, budgetExhausted: false, proposals: [row], privacyRejections: [], refused: [] });
    expect((await list('appsec', '?task=contributor_identity')).total).toBe(0);
    expect((await list('admin', '?task=contributor_identity')).items.map((r) => r.value)).toEqual([row.value]);
    expect((await call('POST', `/api/agentic/proposals/${row.id}/remove`, { as: 'appsec' })).status).toBe(403);
    expect((await call('POST', `/api/agentic/proposals/${row.id}/remove`, { as: 'admin' })).status).toBe(200);
    const after = (await list('admin', '?task=contributor_identity')).items[0]!;
    expect([after.status, after.value, after.quote, after.sourceUrl]).toEqual(['removed', null, null, null]);
  });
});

describe('decisions', () => {
  let pending: AgentProposalRow[];
  beforeAll(async () => {
    pending = (await list('admin', '?status=pending_confirmation')).items;
  });

  it('need review_entity_links (AppSec cannot) and the CSRF header', async () => {
    expect((await call('POST', `/api/agentic/proposals/${pending[0]!.id}/confirm`, { as: 'appsec' })).status).toBe(403);
    const noCsrf = await srv.app.request(`/api/agentic/proposals/${pending[0]!.id}/confirm`, { method: 'POST', headers: { Cookie: `br_session=${cookies.admin}` } });
    expect(noCsrf.status).toBe(403);
  });

  it('confirm: pending org jurisdiction becomes confirmed, audited without the value; only confirmed rows feed P7', async () => {
    expect(confirmedJurisdictions(srv.store, orgId)).toEqual([]);
    const osc = pending.find((r) => r.subject === 'funder:opencollective/opensource')!;
    const res = await call('POST', `/api/agentic/proposals/${osc.id}/confirm`, { as: 'admin', body: { note: 'Checked the EIN on the IRS site.' } });
    expect(res.status).toBe(200);
    const row = (await res.json()) as AgentProposalRow;
    expect([row.status, row.decidedBy, row.decisionNote]).toEqual(['confirmed', 'Dev Admin', 'Checked the EIN on the IRS site.']);
    const p7 = confirmedJurisdictions(srv.store, orgId);
    expect(p7.map((x) => [x.subject, (x.value as { country: string }).country])).toEqual([['funder:opencollective/opensource', 'US']]);
    const audit = (await (await call('GET', '/api/audit?limit=5', { as: 'admin' })).json()) as ListAuditResponse;
    const entry = audit.items.find((a) => a.action === 'agent_proposal.confirm')!;
    expect(entry.target).toBe(osc.id);
    expect(entry.detail).toMatchObject({ task: 'org_jurisdiction', from: 'pending_confirmation' });
    expect(JSON.stringify(entry.detail)).not.toContain('"US"');
  });

  it('reject works on pending and unverified; confirm on anything but pending is a conflict', async () => {
    const edgar = pending.find((r) => r.subject === 'org:github/elastic')!;
    expect((await call('POST', `/api/agentic/proposals/${edgar.id}/reject`, { as: 'admin' })).status).toBe(200);
    const unverified = (await list('admin', '?status=unverified')).items[0]!;
    expect((await call('POST', `/api/agentic/proposals/${unverified.id}/confirm`, { as: 'admin' })).status).toBe(409);
    expect((await call('POST', `/api/agentic/proposals/${unverified.id}/reject`, { as: 'admin', body: { note: 'not on the page' } })).status).toBe(200);
    expect((await call('POST', `/api/agentic/proposals/${unverified.id}/remove`, { as: 'admin' })).status).toBe(409);
    expect((await call('POST', '/api/agentic/proposals/prop_00000000000000000000/reject', { as: 'admin' })).status).toBe(404);
    expect((await call('POST', `/api/agentic/proposals/${edgar.id}/reject`, { as: 'admin', body: { note: 5 } })).status).toBe(400);
    expect(confirmedJurisdictions(srv.store, orgId)).toHaveLength(1);
  });

  it('a rescan never undoes a decision', async () => {
    const before = await list('admin');
    const decided = before.items.filter((r) => r.status === 'confirmed' || r.status === 'rejected');
    const seedRows = decided.map((r) => ({ ...r, status: r.task === 'org_jurisdiction' ? 'pending_confirmation' : 'unverified' }) as unknown as AgentProposal);
    syncAgentProposals(srv.store, { orgId, projectId, scanId: 'scan_rescan' }, { model: 'm', runs: 0, cached: 0, requests: 0, inputTokens: 0, outputTokens: 0, budgetExhausted: false, proposals: seedRows.map((r) => ({ ...r, quote: r.quote ?? '', sourceUrl: r.sourceUrl ?? '', retrievedAt: '', confidenceNote: '', checks: [], reasons: [] })), privacyRejections: [], refused: [] });
    const after = await list('admin');
    for (const d of decided) expect(after.items.find((r) => r.id === d.id)!.status).toBe(d.status);
  });

  it('remove on request wipes a self-declared location for good, even if a later scan proposes it again', async () => {
    const person: AgentProposal = {
      id: 'prop_0123456789abcdef0123',
      task: 'person_self_declared_location',
      subject: 'person:github/synthetic--profile',
      subjectKind: 'person',
      value: { location: 'Lisbon, Portugal' },
      sourceUrl: 'https://github.com/synthetic--profile',
      quote: 'Lisbon, Portugal',
      retrievedAt: '2026-10-11T12:00:00Z',
      confidenceNote: 'synthetic',
      status: 'verified',
      checks: [],
      reasons: [],
      label: 'self-declared',
    };
    const report = { model: 'm', runs: 0, cached: 0, requests: 0, inputTokens: 0, outputTokens: 0, budgetExhausted: false, proposals: [person], privacyRejections: [], refused: [] };
    syncAgentProposals(srv.store, { orgId, projectId, scanId: null }, report);
    const shown = (await list('admin', '?task=person_self_declared_location')).items[0]!;
    expect([shown.label, shown.value]).toEqual(['self-declared', { location: 'Lisbon, Portugal' }]);
    // Person-level rows are listed only for manage_projects (the org admin here), not for AppSec or the auditor.
    const appsec = await list('appsec');
    expect(appsec.personLevelShown).toBe(false);
    expect(appsec.items.some((r) => r.subjectKind === 'person')).toBe(false);
    expect((await list('auditor', '?task=person_self_declared_location')).total).toBe(0);
    expect((await list('admin')).personLevelShown).toBe(true);
    const res = await call('POST', `/api/agentic/proposals/${person.id}/remove`, { as: 'admin', body: { note: 'Removal requested by the person.' } });
    expect(res.status).toBe(200);
    syncAgentProposals(srv.store, { orgId, projectId, scanId: null }, report);
    const row = get<{ status: string; value_json: string | null; quote: string | null; source_url: string | null }>(srv.store, 'SELECT status, value_json, quote, source_url FROM agent_proposal WHERE id = ?', person.id)!;
    expect(row).toEqual({ status: 'removed', value_json: null, quote: null, source_url: null });
    const audit = (await (await call('GET', '/api/audit?limit=3', { as: 'admin' })).json()) as ListAuditResponse;
    expect(JSON.stringify(audit.items.find((a) => a.action === 'agent_proposal.remove'))).not.toContain('Lisbon');
  });
});
