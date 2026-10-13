/**
 * Proposed facts page against a fake API: status tiles filter, gate reasons and the agent's note
 * are shown as text, decisions appear only with review rights, confirm posts and reloads, and a
 * self-declared location is labelled and removable.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AgentProposalRow, AgentProposalsResponse } from '@/api-agentic';
import { meFor } from '@/test/fixtures';
import { fakeApi, renderPage } from './e-parts/testkit';
import ProposedFacts, { valueText } from './ProposedFacts';

const p1 = { id: 'p1', name: 'payments-platform' };
function row(over: Partial<AgentProposalRow>): AgentProposalRow {
  return {
    id: 'prop_00000000000000000001',
    task: 'org_jurisdiction',
    subject: 'funder:opencollective/opensource',
    subjectKind: 'org',
    status: 'pending_confirmation',
    value: { country: 'US', basis: 'tax_registration', registry: 'org_legal_page', identifier: '82-2037583' },
    sourceUrl: 'https://www.oscollective.org/',
    quote: "We're a 501(c)(6) non-profit registered in the USA. EIN 82-2037583",
    label: null,
    confidenceNote: "Medium: the organisation's own site.",
    checks: [],
    reasons: [],
    retrievedAt: '2026-10-11T12:04:00Z',
    verifiedAt: '2026-10-11T12:00:00Z',
    firstSeenAt: '2026-10-11T12:00:00Z',
    lastSeenAt: '2026-10-11T12:00:00Z',
    project: p1,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    ...over,
  };
}
const unverified = row({ id: 'prop_00000000000000000002', task: 'funding', subject: 'pkg:npm/@babel/core', subjectKind: 'package', status: 'unverified', value: { kind: 'corporate_backer', organization: 'Google' }, sourceUrl: 'https://opencollective.com/babel', quote: 'Babel is funded entirely by Google', reasons: ['the quoted text is not on the source page'], verifiedAt: null });
const person = row({ id: 'prop_00000000000000000003', task: 'person_self_declared_location', subject: 'person:github/synthetic--profile', subjectKind: 'person', status: 'verified', value: { location: 'Lisbon, Portugal' }, sourceUrl: 'https://github.com/synthetic--profile', quote: 'Lisbon, Portugal', label: 'self-declared' });

function response(items: AgentProposalRow[], canReview: boolean): AgentProposalsResponse {
  const counts = { pending_confirmation: 0, unverified: 0, verified: 0, confirmed: 0, rejected: 0, removed: 0 };
  for (const i of items) counts[i.status]++;
  return { items, total: items.length, nextCursor: null, counts, canReview, personLevelShown: canReview, note: 'Proposed by an AI agent from public pages. Unverified proposals are shown for review and are never used.' };
}

describe('ProposedFacts', () => {
  it('formats values per task', () => {
    expect(valueText(row({}))).toBe('US · tax registration · org legal page · id 82-2037583');
    expect(valueText({ task: 'funding', value: { kind: 'corporate_backer', organization: 'Airbnb', amount: { value: 217858, currency: 'USD', since: 'Apr 2018' } } })).toBe('corporate backer · Airbnb · 217,858 USD since Apr 2018');
    expect(valueText(person)).toBe('Lisbon, Portugal (self-declared on own profile)');
    expect(valueText({ task: 'contributor_identity', value: { field: 'role', role: 'lead maintainer', project: 'widget' } })).toBe('lead maintainer · widget');
    expect(valueText({ task: 'contributor_identity', value: { field: 'signing_key', keyType: 'gpg', keyId: '3AA5C34371567BD2' } })).toBe('GPG signing key 3AA5C34371567BD2');
  });

  it('shows evidence and gate reasons; no decision column without review rights', async () => {
    fakeApi({ 'GET /api/agentic/proposals': () => response([row({}), unverified], false) });
    renderPage(<ProposedFacts />, { path: '/proposed-facts', at: '/proposed-facts', me: meFor('appsec') });
    const table = await screen.findByRole('table', { name: 'Proposed facts' });
    expect(within(table).getByText('the quoted text is not on the source page')).toBeInTheDocument();
    expect(within(table).getByText('Unverified proposal')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'www.oscollective.org' })).toHaveAttribute('href', 'https://www.oscollective.org/');
    expect(within(table).queryByRole('button')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent(/never used/);
  });

  it('status tiles filter through the API', async () => {
    const { calls } = fakeApi({ 'GET /api/agentic/proposals': (c) => response(c.url.searchParams.get('status') === 'unverified' ? [unverified] : [row({}), unverified], false) });
    renderPage(<ProposedFacts />, { path: '/proposed-facts', at: '/proposed-facts', me: meFor('appsec') });
    await screen.findByRole('table', { name: 'Proposed facts' });
    await userEvent.click(screen.getByRole('button', { name: /Unverified proposal/ }));
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get('status')).toBe('unverified'));
    expect(screen.getByRole('button', { name: /Unverified proposal/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a reviewer confirms org jurisdiction and can remove a self-declared location', async () => {
    let confirmed = false;
    const { calls } = fakeApi({
      'GET /api/agentic/proposals': () => response([confirmed ? row({ status: 'confirmed', decidedBy: 'Dev Admin' }) : row({}), person], true),
      'POST /api/agentic/proposals/prop_00000000000000000001/confirm': () => {
        confirmed = true;
        return row({ status: 'confirmed' });
      },
      'POST /api/agentic/proposals/prop_00000000000000000003/remove': () => ({ ...person, status: 'removed' }),
    });
    renderPage(<ProposedFacts />, { path: '/proposed-facts', at: '/proposed-facts', me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('button', { name: /^Confirm Organisation jurisdiction for funder:opencollective\/opensource: US/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/confirm'))).toBe(true));
    expect(await screen.findByText('by Dev Admin')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Proposed facts' });
    expect(within(table).getByText('Self-declared')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Remove Self-declared location for person:github\/synthetic--profile/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/remove'))).toBe(true));
  });
});
