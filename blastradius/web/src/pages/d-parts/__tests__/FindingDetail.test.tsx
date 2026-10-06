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
    await user.selectOptions(within(form).getByLabelText('Status'), 'accepted_risk');
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
