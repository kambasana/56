import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChangesResponse } from '@server/api-types';
import { setFetcher } from '@/api';
import { meFor } from '@/test/fixtures';
import Changes from '../../Changes';
import { change, fakeApi, renderPage } from './kit';

afterEach(() => setFetcher((...a) => fetch(...a)));

const from = { id: 's1', projectId: 'p1', status: 'succeeded' as const, createdAt: '2018-11-20T10:00:00.000Z', finishedAt: '2018-11-20T10:01:00.000Z' };
const to = { ...from, id: 's2', createdAt: '2018-11-27T10:00:00.000Z', finishedAt: '2018-11-27T10:01:00.000Z' };

function body(over: Partial<ChangesResponse> = {}): ChangesResponse {
  const items = [change('new_finding', 'flatmap-stream'), change('risk_up', 'event-stream'), change('resolved', 'left-pad'), change('new_reason', 'colors')];
  return { projectId: 'p1', fromScan: from, toScan: to, items, counts: { new_finding: 1, risk_up: 1, resolved: 1, risk_down: 0, new_reason: 1 }, ...over };
}

const at = (q = '', me = meFor('org_admin')) => ({ path: `/projects/p1/changes${q}`, pattern: '/projects/:id/changes', me });
const bodyRows = () => within(screen.getByRole('table', { name: 'Changes' })).getAllByRole('row').slice(1);

describe('<Changes>', () => {
  it('lists changes between the two latest scans', async () => {
    fakeApi([['GET', /^\/api\/changes$/, () => body()]]);
    renderPage(<Changes />, at());
    expect(await screen.findByText('flatmap-stream@1.0.0')).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByText('2018-11-20 10:01 UTC → 2018-11-27 10:01 UTC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Risk down\s*0/ })).toBeInTheDocument();
  });

  it('filters by change type via the URL', async () => {
    const user = userEvent.setup();
    fakeApi([['GET', /^\/api\/changes$/, () => body()]]);
    renderPage(<Changes />, at('?type=resolved'));
    await screen.findByText('left-pad@1.0.0');
    expect(bodyRows()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^All/ }));
    expect(bodyRows()).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: /^New reason/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('type=new_reason');
    expect(bodyRows()).toHaveLength(1);
  });

  it('opens a panel with links to the finding and Investigate', async () => {
    const user = userEvent.setup();
    fakeApi([['GET', /^\/api\/changes$/, () => body()]]);
    renderPage(<Changes />, at());
    await user.click(await screen.findByText('event-stream@1.0.0'));
    const panel = screen.getByRole('complementary', { name: 'Change details' });
    expect(within(panel).getByRole('link', { name: 'Open finding' })).toHaveAttribute('href', '/projects/p1/findings/f-event-stream');
    expect(within(panel).getByRole('link', { name: 'Investigate' })).toBeInTheDocument();
  });

  it('notes a first scan and handles no scans', async () => {
    fakeApi([['GET', /^\/api\/changes$/, () => body({ fromScan: null })]]);
    renderPage(<Changes />, at());
    expect(await screen.findByText(/every finding shows as new/)).toBeInTheDocument();
  });

  it('shows an empty state without a completed scan', async () => {
    fakeApi([['GET', /^\/api\/changes$/, () => body({ fromScan: null, toScan: null, items: [] })]]);
    renderPage(<Changes />, at());
    expect(await screen.findByText('No completed scan yet')).toBeInTheDocument();
  });

  it('shows "Nothing changed" when the scans match', async () => {
    fakeApi([['GET', /^\/api\/changes$/, () => body({ items: [], counts: { new_finding: 0, risk_up: 0, resolved: 0, risk_down: 0, new_reason: 0 } })]]);
    renderPage(<Changes />, at());
    expect(await screen.findByText('Nothing changed')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    fakeApi([['GET', /^\/api\/changes$/, () => ({ status: 403, body: { error: { code: 'forbidden', message: 'Missing permission' } } })]]);
    renderPage(<Changes />, at());
    expect(await screen.findByRole('alert')).toHaveTextContent('Missing permission');
  });
});
