import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgFindingRow, PackageFindingGroup } from '@server/api-types';
import { setFetcher } from '@/api';
import { meFor } from '@/test/fixtures';
import Findings from '../../Findings';
import { resetAssigneeCache } from '../../a-parts/triage';
import { fakeApi, findingRow, renderPage, type RouteSpec } from './kit';

beforeEach(() => resetAssigneeCache());
afterEach(() => setFetcher((...a) => fetch(...a)));

function orgRow(i: number, over: Partial<OrgFindingRow> = {}): OrgFindingRow {
  return {
    ...findingRow(i),
    projectName: 'payments-platform',
    introducedBy: { direct: false, via: ['event-stream'] },
    spread: { projects: 1, prodProjects: 1 },
    ...over,
  };
}

function group(i: number, over: Partial<PackageFindingGroup> = {}): PackageFindingGroup {
  const r = orgRow(i);
  return {
    purl: r.purl,
    name: r.name,
    version: r.version,
    ecosystem: 'npm',
    level: r.level,
    score: r.score,
    mainReason: r.mainReason,
    introducedBy: r.introducedBy,
    firstSeenAt: r.firstSeenAt,
    projects: 2,
    prodProjects: 1,
    findings: [
      { id: `f${i}`, projectId: 'p1', projectName: 'payments-platform', production: true, status: 'new', owner: null },
      { id: `g${i}`, projectId: 'p2', projectName: 'web', production: false, status: 'reviewed', owner: null },
    ],
    ...over,
  };
}

const PEOPLE: RouteSpec = ['GET', /^\/api\/assignees$/, () => ({ items: [{ id: 'u1', name: 'Sam Rivera' }] })];

function serve(rows: OrgFindingRow[], extra: RouteSpec[] = [], groups: PackageFindingGroup[] = []) {
  return fakeApi([
    PEOPLE,
    ['GET', /^\/api\/findings$/, (url) => ({ items: rows.slice(0, Number(url.searchParams.get('limit') ?? 50)), total: rows.length, nextCursor: null, scannedProjects: 1 })],
    ['GET', /^\/api\/findings\/packages$/, () => ({ items: groups, total: groups.length, nextCursor: null, scannedProjects: 2 })],
    ['GET', /^\/api\/projects\/p1\/health$/, () => ({ items: [] })],
    ...extra,
  ]);
}

const project = (q = '', me = meFor('org_admin')) => ({ path: `/projects/p1/findings${q}`, pattern: '/projects/:id/findings', me });
const org = (q = '', me = meFor('org_admin')) => ({ path: `/findings${q}`, pattern: '/findings', me });
const bodyRows = () => within(screen.getByRole('table', { name: 'Findings' })).getAllByRole('row').slice(1);
const lastQuery = (api: ReturnType<typeof serve>, path: string) => [...api.calls].reverse().find((c) => c.url.pathname === path)!.url.searchParams;

describe('<Findings>', () => {
  it('shows the one table: severity, package, projects, introduced by, first seen, status, owner', async () => {
    const api = serve([orgRow(1, { level: 'critical', name: 'event-stream', version: '3.3.6', owner: { id: 'u1', name: 'Sam Rivera' } })]);
    renderPage(<Findings />, project());
    expect(await screen.findByText('event-stream@3.3.6')).toBeInTheDocument();
    const headers = within(screen.getByRole('table', { name: 'Findings' })).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(1)).toEqual(['Severity', 'Package', 'Projects', 'Introduced by', 'First seen', 'Status', 'Owner']);
    const row = bodyRows()[0]!;
    expect(row).toHaveTextContent('◆Critical');
    expect(row).toHaveTextContent('payments-platform');
    expect(row).toHaveTextContent('event-stream');
    expect(row).toHaveTextContent('Open');
    expect(row).toHaveTextContent('Sam Rivera');
    // One severity, no numbers: no Risk or Spread score column.
    expect(headers.join(' ')).not.toMatch(/Risk|Spread|Blast|Score/);
    expect(lastQuery(api, '/api/findings').get('projects')).toBe('p1');
  });

  it('promoted chips filter through the URL and the API (OR within, AND across)', async () => {
    const user = userEvent.setup();
    const api = serve([], [], [group(1)]);
    renderPage(<Findings />, org());
    await screen.findByText('pkg-1@1.0.1');
    await user.click(screen.getByRole('button', { name: 'Critical' }));
    await user.click(screen.getByRole('button', { name: 'In production' }));
    await user.click(screen.getByRole('button', { name: 'Unassigned' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('severity=critical&reach=production&owner=none'));
    await waitFor(() => expect(lastQuery(api, '/api/findings/packages').get('owner')).toBe('none'));
    const q = lastQuery(api, '/api/findings/packages');
    expect(q.get('level')).toBe('critical');
    expect(q.get('env')).toBe('prod');
    expect(screen.getByRole('list', { name: 'Applied filters' })).toHaveTextContent('Severity: Critical');
    await user.click(screen.getByRole('button', { name: 'Remove filter Severity: Critical' }));
    await waitFor(() => expect(screen.getByTestId('where')).not.toHaveTextContent('severity='));
  });

  it('switches By package / By project and keeps the choice in the URL', async () => {
    const user = userEvent.setup();
    serve([orgRow(1, { name: 'flat' })], [], [group(2, { name: 'minimist', version: '1.2.5' })]);
    renderPage(<Findings />, org());
    expect(await screen.findByText('minimist@1.2.5')).toBeInTheDocument();
    expect(bodyRows()[0]).toHaveTextContent('2 projects');
    expect(bodyRows()[0]).toHaveTextContent('Mixed (2)');
    await user.click(screen.getByRole('button', { name: 'By project' }));
    expect(await screen.findByText('flat@1.0.1')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('group=project');
  });

  it('sorts from the column headers through the URL', async () => {
    const user = userEvent.setup();
    const api = serve([orgRow(1)]);
    renderPage(<Findings />, project());
    await screen.findByText('pkg-1@1.0.1');
    await user.click(screen.getByRole('button', { name: 'First seen' }));
    await waitFor(() => expect(lastQuery(api, '/api/findings').get('sort')).toBe('-firstSeen'));
    expect(screen.getByRole('columnheader', { name: 'First seen' })).toHaveAttribute('aria-sort', 'descending');
  });

  it('loads 50 rows, then more with "Load more"', async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 70 }, (_, i) => orgRow(i));
    serve(rows);
    renderPage(<Findings />, project());
    await screen.findByText('pkg-0@1.0.0');
    expect(bodyRows()).toHaveLength(50);
    expect(screen.getByText('70 findings · showing 50')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load 20 more' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(70));
    expect(screen.getByTestId('where')).toHaveTextContent('shown=100');
  });

  it('opens the peek sheet from a row, saves status and owner, and links the full page', async () => {
    const user = userEvent.setup();
    const row = orgRow(1);
    const api = serve([row], [['PATCH', /^\/api\/findings\/f1$/, () => ({ ...row, status: 'reviewed' })]]);
    renderPage(<Findings />, project());
    await user.click(await screen.findByText('pkg-1@1.0.1'));
    const sheet = await screen.findByRole('dialog');
    expect(screen.getByTestId('where')).toHaveTextContent('peek=f1');
    expect(within(sheet).getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/projects/p1/findings/f1');
    const form = within(sheet).getByRole('form', { name: 'Finding status' });
    await user.click(within(form).getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Triaged' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ status: 'reviewed' });
    await user.click(within(form).getByRole('combobox', { name: /Owner/ }));
    await user.click(await screen.findByRole('option', { name: 'Sam Rivera' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({ ownerId: 'u1' }));
  });

  it('keeps triage visible but disabled for the auditor, with the reason', async () => {
    const user = userEvent.setup();
    serve([orgRow(1)]);
    renderPage(<Findings />, project('', meFor('auditor')));
    await user.click(await screen.findByText('pkg-1@1.0.1'));
    const form = within(await screen.findByRole('dialog')).getByRole('form', { name: 'Finding status' });
    expect(within(form).getByRole('combobox', { name: 'Status' })).toBeDisabled();
    expect(form).toHaveTextContent('Needs the Triage permission: ask an admin.');
  });

  it('selecting rows brings up the bulk bar; set status sends one bulk request', async () => {
    const user = userEvent.setup();
    const api = serve([orgRow(1), orgRow(2)], [['POST', /^\/api\/findings\/bulk$/, () => ({ updated: 2, items: [] })]]);
    renderPage(<Findings />, project());
    await screen.findByText('pkg-1@1.0.1');
    await user.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('2 selected');
    expect(within(bar).getByRole('button', { name: /Create ticket/ })).toBeDisabled();
    await user.click(within(bar).getByRole('button', { name: /Set status/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Fixing' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ ids: ['f1', 'f2'], status: 'fixing' });
    expect(await within(bar).findByText('2 set to Fixing')).toBeInTheDocument();
  });

  it('accept risk asks for a reason and an expiry date before sending', async () => {
    const user = userEvent.setup();
    const api = serve([orgRow(1)], [['POST', /^\/api\/findings\/bulk$/, () => ({ updated: 1, items: [] })]]);
    renderPage(<Findings />, project());
    await screen.findByText('pkg-1@1.0.1');
    await user.click(screen.getByRole('checkbox', { name: /Select pkg-1@1.0.1/ }));
    await user.click(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Accept risk…' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Accept risk' }));
    expect(dialog).toHaveTextContent('Give the reason the risk is accepted.');
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByLabelText('Reason *'), 'Sandboxed build step');
    await user.type(within(dialog).getByLabelText('Expires on *'), '2999-01-31');
    await user.click(within(dialog).getByRole('button', { name: 'Accept risk' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ ids: ['f1'], status: 'accepted_risk', note: 'Sandboxed build step', expiresAt: '2999-01-31T00:00:00.000Z' }));
  });

  it('no results offers exact recoveries; an empty list is an all-clear; errors show the cause', async () => {
    const user = userEvent.setup();
    serve([]);
    const { unmount } = renderPage(<Findings />, project('?severity=critical'));
    const block = await screen.findByText('No findings match these filters');
    await user.click(within(block.closest('[data-slot=state-block]') as HTMLElement).getByRole('button', { name: 'Remove "Severity: Critical"' }));
    expect(await screen.findByText('No findings in payments-platform')).toBeInTheDocument();
    unmount();
    fakeApi([PEOPLE, ['GET', /^\/api\/findings$/, () => ({ status: 500, body: { error: { code: 'internal', message: 'database is locked' } } })]]);
    renderPage(<Findings />, org('?group=project'));
    expect(await screen.findByText('database is locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps the Maintenance view for one project', async () => {
    const user = userEvent.setup();
    serve([orgRow(1)]);
    renderPage(<Findings />, project());
    await screen.findByText('pkg-1@1.0.1');
    await user.click(screen.getByRole('tab', { name: /Maintenance/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('view=health');
  });
});
