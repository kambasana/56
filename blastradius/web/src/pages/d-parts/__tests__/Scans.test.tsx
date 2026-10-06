import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scan as ScanT } from '@server/api-types';
import { setFetcher } from '@/api';
import { meFor } from '@/test/fixtures';
import Scans from '../../Scans';
import { fakeApi, renderPage, scan } from './kit';

afterEach(() => setFetcher((...a) => fetch(...a)));

const at = (me = meFor('org_admin')) => ({ path: '/projects/p1/scans', pattern: '/projects/:id/scans', me });
const page = (items: ScanT[], serverTime = '2018-11-27T10:05:00.000Z') => ({ items, total: items.length, nextCursor: null, serverTime });

describe('<Scans>', () => {
  it('lists scans with status and summary', async () => {
    fakeApi([['GET', /^\/api\/projects\/p1\/scans$/, () => page([scan('s2'), scan('s1', { status: 'failed', summary: null, error: 'Clone failed', finishedAt: null })])]]);
    renderPage(<Scans />, at());
    const table = await screen.findByRole('table', { name: 'Scans' });
    expect(within(table).getByText('Succeeded')).toBeInTheDocument();
    expect(within(table).getByText('Failed')).toBeInTheDocument();
    expect(within(table).getByText('Clone failed')).toBeInTheDocument();
    expect(within(table).getByText('1m 30s')).toBeInTheDocument();
  });

  it('runs a scan with the CSRF header and reloads', async () => {
    const user = userEvent.setup();
    let items: ScanT[] = [scan('s1')];
    const api = fakeApi([
      ['GET', /^\/api\/projects\/p1\/scans$/, () => page(items)],
      [
        'POST',
        /^\/api\/projects\/p1\/scans$/,
        () => {
          const s = scan('s2', { status: 'queued', summary: null, finishedAt: null, startedAt: null });
          items = [s, ...items];
          return { status: 202, body: s };
        },
      ],
    ]);
    renderPage(<Scans />, at());
    await user.click(await screen.findByRole('button', { name: 'Run scan' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Run a scan of payments-platform?' });
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Run scan' }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(await screen.findByText('Scan queued')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.headers['X-Requested-With']).toBe('blastradius');
    expect(screen.getByRole('button', { name: 'Scan in progress' })).toBeDisabled();
  });

  it('shows a conflict from the server', async () => {
    const user = userEvent.setup();
    fakeApi([
      ['GET', /^\/api\/projects\/p1\/scans$/, () => page([scan('s1')])],
      ['POST', /^\/api\/projects\/p1\/scans$/, () => ({ status: 409, body: { error: { code: 'conflict', message: 'A scan is already running' } } })],
    ]);
    renderPage(<Scans />, at());
    await user.click(await screen.findByRole('button', { name: 'Run scan' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Run scan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A scan is already running');
  });

  it('hides Run scan and New project without manage_projects', async () => {
    fakeApi([['GET', /^\/api\/projects\/p1\/scans$/, () => page([])]]);
    renderPage(<Scans />, at(meFor('developer')));
    expect(await screen.findByText('No scans yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run scan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });

  it('allows Run scan through a project-scope manage_projects binding', async () => {
    fakeApi([['GET', /^\/api\/projects\/p1\/scans$/, () => page([])]]);
    renderPage(<Scans />, at(meFor('developer', { projectPermissions: { p1: ['manage_projects'] } })));
    expect(await screen.findByRole('button', { name: 'Run scan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });

  it('opens a scan panel with report downloads', async () => {
    const user = userEvent.setup();
    fakeApi([['GET', /^\/api\/projects\/p1\/scans$/, () => page([scan('s2', { summary: { ...scan('s2').summary!, warnings: ['registry slow'] } })])]]);
    renderPage(<Scans />, at());
    await user.click(await screen.findByText('Succeeded'));
    const panel = screen.getByRole('complementary', { name: 'Scan details' });
    expect(within(panel).getByRole('link', { name: 'SARIF' })).toHaveAttribute('href', '/api/reports/s2.sarif');
    expect(within(panel).getByText('registry slow')).toBeInTheDocument();
  });

  it('polls while a scan is running', async () => {
    let calls = 0;
    fakeApi([
      [
        'GET',
        /^\/api\/projects\/p1\/scans$/,
        () => {
          calls += 1;
          return page([calls < 2 ? scan('s1', { status: 'running', summary: null, finishedAt: null }) : scan('s1')]);
        },
      ],
    ]);
    renderPage(<Scans />, at());
    expect(await screen.findByText('Running')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Succeeded')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('polls with updatedSince and keeps older pages that were loaded', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const api = fakeApi([
      [
        'GET',
        /^\/api\/projects\/p1\/scans$/,
        (url) => {
          if (url.searchParams.get('updatedSince')) {
            polls += 1;
            // The running scan finished; nothing else changed.
            return { items: [scan('s3')], total: 1, nextCursor: null, serverTime: `2018-11-27T10:1${polls}:00.000Z` };
          }
          return url.searchParams.get('cursor') === 'c1'
            ? { items: [scan('s1', { status: 'failed', summary: null, error: 'Old failure', finishedAt: null })], total: 2, nextCursor: null, serverTime: 'x' }
            : { items: [scan('s3', { status: 'running', summary: null, finishedAt: null }), scan('s2')], total: 3, nextCursor: 'c1', serverTime: '2018-11-27T10:10:00.000Z' };
        },
      ],
    ]);
    renderPage(<Scans />, at());
    expect(await screen.findByText('Running')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load older scans' }));
    expect(await screen.findByText('Old failure')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Running')).toBeNull(), { timeout: 4000 });
    // The older page is still there, and the poll only asked for what changed.
    expect(screen.getByText('Old failure')).toBeInTheDocument();
    expect(screen.getByTestId('datatable-count')).toHaveTextContent('Showing 3 of 3');
    const poll = api.calls.find((c) => c.url.searchParams.get('updatedSince'))!;
    expect(poll.url.searchParams.get('updatedSince')).toBe('2018-11-27T10:10:00.000Z');
    expect(poll.url.searchParams.get('cursor')).toBeNull();
  });

  it('cancels the run-scan confirmation without starting a scan', async () => {
    const user = userEvent.setup();
    const api = fakeApi([['GET', /^\/api\/projects\/p1\/scans$/, () => page([scan('s1')])]]);
    renderPage(<Scans />, at());
    await user.click(await screen.findByRole('button', { name: 'Run scan' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('opens New project as a dialog', async () => {
    const user = userEvent.setup();
    fakeApi([['GET', /^\/api\/projects\/p1\/scans$/, () => page([])]]);
    renderPage(<Scans />, at());
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    expect(within(dialog).getByRole('button', { name: 'Create project' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('loads older scans past the first page', async () => {
    const user = userEvent.setup();
    const api = fakeApi([
      [
        'GET',
        /^\/api\/projects\/p1\/scans$/,
        (url) =>
          url.searchParams.get('cursor') === 'c1'
            ? { items: [scan('s1', { status: 'failed', summary: null, error: 'Old failure', finishedAt: null })], total: 2, nextCursor: null }
            : { items: [scan('s2')], total: 2, nextCursor: 'c1' },
      ],
    ]);
    renderPage(<Scans />, at());
    await user.click(await screen.findByRole('button', { name: 'Load older scans' }));
    expect(await screen.findByText('Old failure')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older scans' })).toBeNull();
    expect(api.calls.filter((c) => c.method === 'GET').map((c) => c.url.searchParams.get('cursor'))).toEqual([null, 'c1']);
  });

  it('shows an error state', async () => {
    fakeApi([['GET', /^\/api\/projects\/p1\/scans$/, () => ({ status: 500, body: { error: { code: 'internal', message: 'Boom' } } })]]);
    renderPage(<Scans />, at());
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
  });
});
