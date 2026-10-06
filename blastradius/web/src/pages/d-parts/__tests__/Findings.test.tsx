import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { FindingRow } from '@server/api-types';
import { setFetcher } from '@/api';
import { meFor } from '@/test/fixtures';
import Findings from '../../Findings';
import { fakeApi, findingDetail, findingRow, renderPage } from './kit';

afterEach(() => setFetcher((...a) => fetch(...a)));

const SCAN = { id: 's2', projectId: 'p1', status: 'succeeded' as const, createdAt: '2018-11-27T10:00:00.000Z', finishedAt: '2018-11-27T10:01:00.000Z' };

/** Serve `rows` in pages of `limit` following the cursor, like the real API. */
function serveFindings(rows: FindingRow[], extra: Parameters<typeof fakeApi>[0] = []) {
  return fakeApi([
    [
      'GET',
      /^\/api\/findings$/,
      (url) => {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const items = rows.slice(offset, offset + limit);
        const next = offset + items.length < rows.length ? String(offset + items.length) : null;
        return { items, total: rows.length, nextCursor: next, scan: rows.length || offset ? SCAN : SCAN };
      },
    ],
    ['GET', /^\/api\/findings\/[^/]+$/, (url) => findingDetail(rows.find((r) => url.pathname.endsWith(`/${r.id}`)) ?? rows[0]!)],
    ...extra,
  ]);
}

const at = (q = '') => ({ path: `/projects/p1/findings${q}`, pattern: '/projects/:id/findings', me: meFor('org_admin') });

const bodyRows = () => within(screen.getByRole('table', { name: 'Findings' })).getAllByRole('row').slice(1);

describe('<Findings>', () => {
  it('lists findings sorted by risk, with level counts and scan meta', async () => {
    serveFindings([findingRow(1, { score: 40, level: 'medium' }), findingRow(2, { score: 99, level: 'critical', name: 'event-stream' })]);
    renderPage(<Findings />, at());
    expect(await screen.findByText('event-stream')).toBeInTheDocument();
    expect(within(bodyRows()[0]!).getByText('event-stream')).toBeInTheDocument();
    expect(screen.getByText(/2 findings · scan 2018-11-27 10:01 UTC/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Critical\s*1/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters by level chip and keeps it in the URL', async () => {
    const user = userEvent.setup();
    serveFindings([findingRow(0), findingRow(1), findingRow(2), findingRow(3)]);
    renderPage(<Findings />, at());
    await screen.findByText('pkg-0');
    await user.click(screen.getByRole('button', { name: /^Critical/ }));
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByTestId('where')).toHaveTextContent('level=critical');
    await user.click(screen.getByRole('button', { name: /^High/ }));
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByTestId('where')).toHaveTextContent('level=critical%2Chigh');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(bodyRows()).toHaveLength(4);
  });

  it('reads level, status and text filters from the URL', async () => {
    serveFindings([findingRow(0), findingRow(4, { status: 'reviewed' }), findingRow(8, { name: 'colors' })]);
    renderPage(<Findings />, at('?level=critical&status=new&q=colors'));
    await screen.findByText('colors');
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByLabelText('Filter Findings')).toHaveValue('colors');
  });

  it('filters by text over the reason detail and hidden purl', async () => {
    const user = userEvent.setup();
    serveFindings([findingRow(1), findingRow(2, { mainReason: { factor: 'malware', detail: 'flatmap payload' } })]);
    renderPage(<Findings />, at());
    await screen.findByText('pkg-1');
    await user.type(screen.getByLabelText('Filter Findings'), 'flatmap');
    expect(bodyRows()).toHaveLength(1);
    await user.clear(screen.getByLabelText('Filter Findings'));
    await user.type(screen.getByLabelText('Filter Findings'), 'pkg:npm/pkg-1@');
    expect(bodyRows()).toHaveLength(1);
  });

  it('opens the side panel with reasons, paths, safe evidence links and graph link', async () => {
    const user = userEvent.setup();
    serveFindings([findingRow(1, { name: 'flatmap-stream' })]);
    renderPage(<Findings />, at());
    await user.click(await screen.findByText('flatmap-stream'));
    const panel = await screen.findByRole('complementary', { name: 'Finding details' });
    expect(await within(panel).findByText('Flagged as malware by the registry')).toBeInTheDocument();
    expect(within(panel).getAllByText('Malware').length).toBeGreaterThan(0);
    expect(within(panel).getByText('payments-api', { selector: 'span.font-medium' })).toBeInTheDocument();
    expect(within(panel).getByText('INC-2018-0001')).toBeInTheDocument();
    const good = within(panel).getByRole('link', { name: 'https://example.org/advisory/1' });
    expect(good).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(panel).queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull();
    expect(within(panel).getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open graph' })).toHaveAttribute('href', '/projects/p1/investigate?finding=f1');
    expect(screen.getByTestId('where')).toHaveTextContent('f=f1');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Finding details' })).toBeNull();
  });

  it('hides graph link and status control without the permissions', async () => {
    const user = userEvent.setup();
    serveFindings([findingRow(1)]);
    const me = meFor('developer', { permissions: ['findings'] });
    renderPage(<Findings />, { ...at(), me });
    await user.click(await screen.findByText('pkg-1'));
    const panel = await screen.findByRole('complementary', { name: 'Finding details' });
    await within(panel).findByText('Flagged as malware by the registry');
    expect(within(panel).queryByRole('link', { name: 'Open graph' })).toBeNull();
    expect(within(panel).queryByRole('form', { name: 'Finding status' })).toBeNull();
  });

  it('changes status with PATCH and updates the row', async () => {
    const user = userEvent.setup();
    const row = findingRow(1);
    const api = serveFindings([row], [['PATCH', /^\/api\/findings\/f1$/, () => ({ ...row, status: 'reviewed' })]]);
    renderPage(<Findings />, at());
    await user.click(await screen.findByText('pkg-1'));
    const panel = await screen.findByRole('complementary', { name: 'Finding details' });
    await user.selectOptions(within(panel).getByLabelText('Status'), 'reviewed');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(bodyRows()[0]!).getByText('Reviewed')).toBeInTheDocument());
    const patch = api.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ status: 'reviewed' });
    expect(patch.headers['X-Requested-With']).toBe('blastradius');
  });

  it('offers accepted risk only with accept_risk', async () => {
    const user = userEvent.setup();
    serveFindings([findingRow(1)]);
    renderPage(<Findings />, { ...at(), me: meFor('developer', { permissions: ['findings', 'review'] }) });
    await user.click(await screen.findByText('pkg-1'));
    const select = await screen.findByLabelText('Status');
    expect(within(select).queryByRole('option', { name: 'Accepted risk' })).toBeNull();
    expect(within(select).getByRole('option', { name: 'Reviewed' })).toBeInTheDocument();
  });

  it('loads 5,000 rows across pages and renders only a virtual window', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => findingRow(i));
    const api = serveFindings(rows);
    renderPage(<Findings />, at());
    await waitFor(() => expect(screen.getByTestId('datatable-count')).toHaveTextContent('5,000 of 5,000'));
    expect(api.calls.filter((c) => c.url.pathname === '/api/findings')).toHaveLength(10);
    expect(bodyRows().length).toBeLessThan(200);
  });

  it('shows an empty state when the project has no scan', async () => {
    fakeApi([['GET', /^\/api\/findings$/, () => ({ items: [], total: 0, nextCursor: null, scan: null })]]);
    renderPage(<Findings />, at());
    expect(await screen.findByText('No completed scan yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Scans' })).toHaveAttribute('href', '/projects/p1/scans');
  });

  it('shows an error state with retry', async () => {
    fakeApi([['GET', /^\/api\/findings$/, () => ({ status: 500, body: { error: { code: 'internal', message: 'Something broke' } } })]]);
    renderPage(<Findings />, at());
    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders untrusted text escaped', async () => {
    serveFindings([findingRow(1, { name: '<img src=x onerror=alert(1)>' })]);
    const { container } = renderPage(<Findings />, at());
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
