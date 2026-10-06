import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReportRow } from '@server/api-types';
import Integrations from '../Integrations';
import Reports from '../Reports';
import { meFor } from '@/test/fixtures';
import { Reply, choose, fakeApi, renderPage } from './testkit';

function report(i: number, project = { id: 'p1', name: 'payments-platform' }): ReportRow {
  const id = `scan_${String(i).padStart(4, '0')}`;
  return {
    scanId: id,
    project,
    createdAt: new Date(Date.UTC(2026, 9, 6, 2, 14) - i * 60_000).toISOString(),
    counts: { critical: 2, high: 0, medium: 1, low: 8 },
    downloads: { html: `/api/reports/${id}.html`, json: `/api/reports/${id}.json`, sarif: `/api/reports/${id}.sarif` },
    sha256: 'a'.repeat(60) + 'beef',
  };
}

describe('<Reports>', () => {
  it('lists snapshots with HTML, JSON and SARIF downloads', async () => {
    fakeApi({ 'GET /api/reports': () => ({ items: [report(1)], total: 1, nextCursor: null }) });
    renderPage(<Reports />, { path: '/reports', at: '/reports', me: meFor('auditor') });
    const table = await screen.findByRole('table', { name: 'Report history' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('payments-platform');
    expect(row).toHaveTextContent('2026-10-06 02:13 UTC');
    expect(row).toHaveTextContent('aaaaaaaa…beef');
    // HTML is one click away (split button); every format is in the download menu.
    const html = within(row).getByRole('link', { name: /^Download HTML report for payments-platform/ });
    expect(html).toHaveAttribute('href', '/api/reports/scan_0001.html');
    expect(html).toHaveAttribute('download', 'blastradius-scan_0001.html');
    await userEvent.click(within(row).getByRole('button', { name: /More download formats/ }));
    const menu = await screen.findByRole('menu');
    for (const f of ['html', 'json', 'sarif']) {
      const a = within(menu).getByRole('menuitem', { name: new RegExp(`Download ${f.toUpperCase()} report`) });
      expect(a).toHaveAttribute('href', `/api/reports/scan_0001.${f}`);
      expect(a).toHaveAttribute('download', `blastradius-scan_0001.${f}`);
    }
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('filters by project and pages with Load more', async () => {
    const { calls } = fakeApi({
      'GET /api/reports': (c) =>
        c.url.searchParams.get('cursor')
          ? { items: [report(2)], total: 2, nextCursor: null }
          : { items: [report(1)], total: 2, nextCursor: 'next' },
    });
    renderPage(<Reports />, { path: '/reports', at: '/reports', me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByTestId('datatable-count')).toHaveTextContent('Showing 2 of 2'));
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('next');
    await choose('Project', 'payments-platform');
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get('project')).toBe('p1'));
  });

  it('virtualises thousands of report rows', async () => {
    const items = Array.from({ length: 5000 }, (_, i) => report(i));
    fakeApi({ 'GET /api/reports': () => ({ items, total: 5000, nextCursor: null }) });
    renderPage(<Reports />, { path: '/reports', at: '/reports', me: meFor('org_admin') });
    const table = await screen.findByRole('table', { name: 'Report history' });
    expect(within(table).getAllByRole('row').length).toBeLessThan(200);
    expect(screen.getByTestId('datatable-count')).toHaveTextContent('Showing 5,000 of 5,000');
  });

  it('shows empty and error states', async () => {
    fakeApi({ 'GET /api/reports': () => ({ items: [], total: 0, nextCursor: null }) });
    const { unmount } = renderPage(<Reports />, { path: '/reports', at: '/reports', me: meFor('auditor') });
    expect(await screen.findByText('No reports yet')).toBeInTheDocument();
    unmount();
    fakeApi({ 'GET /api/reports': () => new Reply(403, { error: { code: 'forbidden', message: 'Missing permission: reports' } }) });
    renderPage(<Reports />, { path: '/reports', at: '/reports', me: meFor('auditor') });
    expect(await screen.findByRole('alert')).toHaveTextContent('Missing permission: reports');
  });
});

describe('<Integrations>', () => {
  it('shows server status and read-only destinations marked coming soon', async () => {
    fakeApi({
      'GET /api/integrations': () => ({
        items: [
          { id: 'github', kind: 'github', name: 'GitHub', status: 'ok', detail: 'GITHUB_TOKEN is set.' },
          { id: 'webhook', kind: 'webhook', name: 'Webhooks', status: 'not_configured', detail: 'Not available yet.' },
        ],
      }),
    });
    renderPage(<Integrations />, { path: '/integrations', at: '/integrations', me: meFor('org_admin') });
    const status = await screen.findByRole('region', { name: 'Server status' });
    expect(within(status).getByText('Connected')).toBeInTheDocument();
    expect(within(status).getByText('Not configured')).toBeInTheDocument();
    const dests = screen.getByRole('list', { name: 'Destinations' });
    const cards = within(dests).getAllByRole('listitem');
    expect(cards).toHaveLength(5);
    expect(within(dests).getAllByText('Coming soon')).toHaveLength(5);
    expect(within(cards[0]!).getByText('GitHub code scanning')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Token set')).toBeInTheDocument();
    expect(within(cards[0]!).getByRole('link', { name: 'Open Reports' })).toHaveAttribute('href', '/reports');
    // Read-only: no configure buttons at all.
    expect(screen.queryByRole('button', { name: /configure|edit|add/i })).toBeNull();
    // Each destination has a disabled switch until it is implemented.
    const switches = within(dests).getAllByRole('switch');
    expect(switches).toHaveLength(5);
    for (const sw of switches) expect(sw).toBeDisabled();
    expect(within(cards[2]!).getByRole('switch', { name: 'Enable Webhooks' })).not.toBeChecked();
  });

  it('shows an error state', async () => {
    fakeApi({ 'GET /api/integrations': () => new Reply(500, { error: { code: 'internal', message: 'Internal error' } }) });
    renderPage(<Integrations />, { path: '/integrations', at: '/integrations', me: meFor('org_admin') });
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal error');
  });
});
