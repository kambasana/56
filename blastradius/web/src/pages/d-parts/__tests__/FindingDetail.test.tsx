import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFetcher } from '@/api';
import { meFor } from '@/test/fixtures';
import FindingDetail, { whatToDo } from '../../FindingDetail';
import { advisoryIds } from '../../a-parts/links';
import { resetAssigneeCache } from '../../a-parts/triage';
import { fakeApi, findingDetail, findingRow, renderPage, type RouteSpec } from './kit';

beforeEach(() => resetAssigneeCache());
afterEach(() => setFetcher((...a) => fetch(...a)));

const at = (me = meFor('org_admin')) => ({ path: '/projects/p1/findings/f1', pattern: '/projects/:id/findings/:fid', me });
const PEOPLE: RouteSpec = ['GET', /^\/api\/assignees$/, () => ({ items: [{ id: 'u1', name: 'Sam Rivera' }] })];

describe('<FindingDetail>', () => {
  it('has one header, a status track, an on-page index and stacked sections without tabs', async () => {
    const row = findingRow(1, { name: 'flatmap-stream', version: '0.1.1', level: 'critical' });
    fakeApi([
      PEOPLE,
      [
        'GET',
        /^\/api\/findings\/f1$/,
        () =>
          findingDetail(row, {
            projectName: 'payments-platform',
            introducedBy: { direct: false, via: ['event-stream'] },
            spread: { projects: 3, prodProjects: 1 },
            alerts: [{ advisoryId: 'GHSA-mh6f-8j2x-4483', advisoryPublished: '2018-11-26T00:00:00.000Z', createdAt: '2018-11-28T00:00:00.000Z' }],
          }),
      ],
    ]);
    renderPage(<FindingDetail />, at());
    expect(await screen.findByRole('heading', { name: 'flatmap-stream@0.1.1', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText('Critical').length).toBeGreaterThan(0);
    expect(screen.getByRole('list', { name: 'Finding status' })).toHaveTextContent('Open› Triaged› Fixing› Resolved');
    expect(screen.getByRole('button', { name: 'Mark triaged' })).toBeEnabled();
    const index = screen.getByRole('navigation', { name: 'On this page' });
    expect(within(index).getAllByRole('link').map((a) => a.textContent)).toEqual(['Where it reaches', 'What to do', "Who's behind it", 'Evidence', 'Timeline']);
    for (const h of ['Where it reaches', 'What to do', "Who's behind it", 'Evidence', 'Timeline']) expect(screen.getByRole('region', { name: h })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('list', { name: 'Paths to assets' })).toHaveTextContent('payments-api → event-stream@3.3.6 → pkg-1@1.0.1');
    expect(screen.getByRole('link', { name: 'See the full reach and every path →' })).toHaveAttribute('href', '/packages?name=flatmap-stream&version=0.1.1');
    expect(screen.getByRole('link', { name: 'Open the graph →' })).toHaveAttribute('href', '/packages/behind?name=flatmap-stream');
    expect(screen.getByRole('link', { name: 'Open in graph' })).toHaveAttribute('href', '/projects/p1/investigate?finding=f1');
    expect(screen.getByRole('region', { name: 'What to do' })).toHaveTextContent('It comes in through event-stream');
    expect(screen.getByRole('list', { name: 'Timeline' })).toHaveTextContent('GHSA-mh6f-8j2x-4483');
    const rail = screen.getByRole('complementary', { name: 'Details' });
    expect(rail).toHaveTextContent('3 projects · 1 in production');
    expect(rail).toHaveTextContent('GHSA-mh6f-8j2x-4483');
    expect(rail).toHaveTextContent('Nov 26 2018');
    // First seen 2018-11-27, advisory 2018-11-26: no early warning, said plainly.
    expect(rail).toHaveTextContent('None: the advisory came first');
    expect(rail).toHaveTextContent('ReleasedNot recorded');
  });

  it("shows who is behind an ordinary package (no incident): accounts, owner org and funders, with evidence", async () => {
    const ev = (u: string) => ({ evidence: [u], method: 'deterministic' as const, reviewed: true, confidence: 1 });
    const ownership = [
      { from: 'pkg:npm/chalk', entityId: 'account:npm/qix', relation: 'maintains' as const, ...ev('https://www.npmjs.com/package/chalk') },
      { from: 'org:github/chalk', entityId: 'funder:opencollective/acme-corp', relation: 'funds' as const, ...ev('https://opencollective.com/chalk') },
    ];
    fakeApi([PEOPLE, ['GET', /^\/api\/findings\/f1$/, () => findingDetail(findingRow(1), { entityChain: [], ownership })]]);
    renderPage(<FindingDetail />, at());
    const list = await screen.findByRole('list', { name: 'Ownership' });
    expect(list).toHaveTextContent('chalkmaintains · 1.00Accountnpm/qix');
    expect(screen.getByRole('link', { name: 'https://opencollective.com/chalk' })).toBeInTheDocument();
  });

  it('the primary action moves the status one step; the rail edits status and owner', async () => {
    const user = userEvent.setup();
    const row = findingRow(1);
    const api = fakeApi([
      PEOPLE,
      ['GET', /^\/api\/findings\/f1$/, () => findingDetail(row)],
      ['PATCH', /^\/api\/findings\/f1$/, (_u, init) => ({ ...row, ...(JSON.parse(String(init?.body)) as object), owner: null })],
    ]);
    renderPage(<FindingDetail />, at());
    await user.click(await screen.findByRole('button', { name: 'Mark triaged' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'reviewed' }));
    expect(await screen.findByRole('button', { name: 'Start fixing' })).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Details' });
    await user.click(within(rail).getByRole('combobox', { name: /Owner/ }));
    await user.click(await screen.findByRole('option', { name: 'Sam Rivera' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ ownerId: 'u1' }));
  });

  it('accepting risk from the split menu asks for a reason and an expiry', async () => {
    const user = userEvent.setup();
    const row = findingRow(1);
    const api = fakeApi([PEOPLE, ['GET', /^\/api\/findings\/f1$/, () => findingDetail(row)], ['PATCH', /^\/api\/findings\/f1$/, () => ({ ...row, status: 'accepted_risk', riskExpiresAt: '2999-01-31T00:00:00.000Z' })]]);
    renderPage(<FindingDetail />, at());
    await user.click(await screen.findByRole('button', { name: 'More status options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Accept risk…' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason *'), 'vendored and patched');
    await user.type(within(dialog).getByLabelText('Expires on *'), '2999-01-31');
    await user.click(within(dialog).getByRole('button', { name: 'Accept risk' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'accepted_risk', note: 'vendored and patched', expiresAt: '2999-01-31T00:00:00.000Z' }));
    expect(await screen.findByText('Accepted until Jan 31 2999')).toBeInTheDocument();
  });

  it('keeps the controls visible but disabled, with why, for a read-only user', async () => {
    fakeApi([PEOPLE, ['GET', /^\/api\/findings\/f1$/, () => findingDetail(findingRow(1))]]);
    renderPage(<FindingDetail />, at(meFor('developer', { permissions: ['findings'] })));
    await screen.findByText('Flagged as malware by the registry');
    expect(screen.queryByRole('link', { name: 'Open in graph' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark triaged' })).toBeDisabled();
    const form = screen.getByRole('form', { name: 'Finding status' });
    const status = within(form).getByRole('combobox', { name: 'Status' });
    expect(status).toBeDisabled();
    expect(status).toHaveAccessibleDescription('Needs the Triage permission: ask an admin.');
  });

  it('shows not found with a way back, and errors with the cause', async () => {
    fakeApi([]);
    const { unmount } = renderPage(<FindingDetail />, at());
    expect(await screen.findByText('Finding not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to findings' })).toHaveAttribute('href', '/projects/p1/findings');
    unmount();
    fakeApi([['GET', /^\/api\/findings\/f1$/, () => ({ status: 500, body: { error: { code: 'internal', message: 'Boom' } } })]]);
    renderPage(<FindingDetail />, at());
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
  });
});

describe('helpers', () => {
  it('advisoryIds finds GHSA, CVE and MAL ids once', () => {
    expect(advisoryIds(['see https://github.com/advisories/GHSA-MH6F-8J2X-4483', 'CVE-2021-44228 and GHSA-mh6f-8j2x-4483', 'MAL-2022-1'])).toEqual(['GHSA-mh6f-8j2x-4483', 'CVE-2021-44228', 'MAL-2022-1']);
  });

  it('whatToDo follows the reasons and the introducer', () => {
    const d = findingDetail(findingRow(1, { name: 'x', version: '1.0.0' }), { introducedBy: { direct: true, via: [] } });
    expect(whatToDo(d)[0]).toMatch(/^Remove x@1.0.0/);
    expect(whatToDo(d).at(-1)).toBe('It is a direct dependency: change it in the manifest.');
    const v = findingDetail(findingRow(2, { name: 'y' }), { reasons: [{ factor: 'vuln', value: 1, weight: 1, contribution: 1, detail: 'd', evidence: [] }] });
    expect(whatToDo(v)[0]).toBe('Upgrade y to a version the advisory lists as fixed.');
  });
});
