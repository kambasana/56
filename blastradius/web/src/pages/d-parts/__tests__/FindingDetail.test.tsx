import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetcher } from '@/api';
import { meFor } from '@/test/fixtures';
import FindingDetail from '../../FindingDetail';
import { fakeApi, findingDetail, findingRow, renderPage } from './kit';

afterEach(() => setFetcher((...a) => fetch(...a)));

const at = (me = meFor('org_admin')) => ({ path: '/projects/p1/findings/f1', pattern: '/projects/:id/findings/:fid', me });

describe('<FindingDetail>', () => {
  it('renders reasons, assets, chain, evidence and history', async () => {
    const row = findingRow(1, { name: 'flatmap-stream', version: '0.1.1' });
    fakeApi([['GET', /^\/api\/findings\/f1$/, () => findingDetail(row)]]);
    renderPage(<FindingDetail />, at());
    expect(await screen.findByRole('heading', { name: 'flatmap-stream@0.1.1' })).toBeInTheDocument();
    expect(screen.getByText('Flagged as malware by the registry')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Paths to assets' })).toHaveTextContent('payments-api→event-stream@3.3.6→pkg-1@1.0.1');
    expect(screen.getByRole('list', { name: 'Score history' })).toHaveTextContent('2018-11-20');
    expect(screen.getByRole('link', { name: 'Open in graph' })).toHaveAttribute('href', '/projects/p1/investigate?finding=f1');
    expect(screen.getByRole('link', { name: 'Back to findings' })).toHaveAttribute('href', '/projects/p1/findings');
    for (const h of ['Why it scored 99', "Who's behind it", 'Evidence', 'History', 'Affected assets']) {
      expect(screen.getByRole('region', { name: h })).toBeInTheDocument();
    }
    expect(screen.getByRole('tab', { name: /Paths/ })).toHaveAttribute('aria-selected', 'true');
  });

  it("shows who is behind an ordinary package (no incident): accounts, owner org and funders, with evidence", async () => {
    const ev = (u: string) => ({ evidence: [u], method: 'deterministic' as const, reviewed: true, confidence: 1 });
    const ownership = [
      { from: 'pkg:npm/chalk', entityId: 'account:npm/qix', relation: 'maintains' as const, ...ev('https://www.npmjs.com/package/chalk') },
      { from: 'pkg:npm/chalk', entityId: 'org:github/chalk', relation: 'owns' as const, ...ev('https://github.com/chalk/chalk') },
      { from: 'org:github/chalk', entityId: 'funder:opencollective/acme-corp', relation: 'funds' as const, ...ev('https://opencollective.com/chalk') },
    ];
    fakeApi([['GET', /^\/api\/findings\/f1$/, () => findingDetail(findingRow(1), { entityChain: [], ownership })]]);
    renderPage(<FindingDetail />, at());
    const list = await screen.findByRole('list', { name: 'Ownership' });
    expect(screen.queryByRole('list', { name: 'Entity chain' })).not.toBeInTheDocument();
    expect(list).toHaveTextContent('chalkmaintains · 1.00Accountnpm/qix');
    expect(list).toHaveTextContent('chalkowns · 1.00Orggithub/chalk');
    expect(list).toHaveTextContent('github/chalkfunds · 1.00Funderopencollective/acme-corp');
    expect(screen.getByRole('link', { name: 'https://opencollective.com/chalk' })).toBeInTheDocument();
  });

  it('loads the scoped graph only when the Graph tab is opened', async () => {
    const user = userEvent.setup();
    const api = fakeApi([
      ['GET', /^\/api\/findings\/f1$/, () => findingDetail(findingRow(1))],
      ['GET', /^\/api\/graph$/, () => ({ status: 500, body: { error: { code: 'internal', message: 'graph down' } } })],
    ]);
    renderPage(<FindingDetail />, at());
    await screen.findByText('Flagged as malware by the registry');
    expect(api.calls.some((c) => c.url.pathname === '/api/graph')).toBe(false);
    await user.click(screen.getByRole('tab', { name: 'Graph' }));
    expect(await screen.findByText('graph down')).toBeInTheDocument();
    expect(api.calls.some((c) => c.url.pathname === '/api/graph')).toBe(true);
  });

  it('updates the status', async () => {
    const user = userEvent.setup();
    const row = findingRow(1);
    fakeApi([
      ['GET', /^\/api\/findings\/f1$/, () => findingDetail(row)],
      ['PATCH', /^\/api\/findings\/f1$/, () => ({ ...row, status: 'accepted_risk' })],
    ]);
    renderPage(<FindingDetail />, at());
    await screen.findByText('Flagged as malware by the registry');
    const form = screen.getByRole('form', { name: 'Finding status' });
    await user.click(within(form).getByLabelText('Status'));
    await user.click(await screen.findByRole('option', { name: 'Accepted risk' }));
    await user.type(within(form).getByLabelText('Note'), 'vendored and patched');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getAllByText('Accepted risk').length).toBeGreaterThan(1));
  });

  it('hides graph and status actions for a read-only user', async () => {
    fakeApi([['GET', /^\/api\/findings\/f1$/, () => findingDetail(findingRow(1))]]);
    renderPage(<FindingDetail />, at(meFor('developer', { permissions: ['findings'] })));
    await screen.findByText('Flagged as malware by the registry');
    expect(screen.queryByRole('link', { name: 'Open in graph' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Finding status' })).toBeNull();
  });

  it('shows not found', async () => {
    fakeApi([]);
    renderPage(<FindingDetail />, at());
    expect(await screen.findByText('Finding not found')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    fakeApi([['GET', /^\/api\/findings\/f1$/, () => ({ status: 500, body: { error: { code: 'internal', message: 'Boom' } } })]]);
    renderPage(<FindingDetail />, at());
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
  });
});
