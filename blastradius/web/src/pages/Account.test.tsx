/**
 * Account page and the concentration section against a fake API.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AccountDetail, AccountExposureResponse, ConcentrationResponse, MarkCompromisedResponse } from '@server/api-types-accounts';
import { meFor } from '@/test/fixtures';
import { accountPath, accountPathForEntity, activeNavId } from '@/nav';
import { fakeApi, renderPage } from './e-parts/testkit';
import AccountPage from './Account';
import Exposure from './Exposure';

const ref = { registry: 'npm' as const, name: 'right9ctrl', entityId: 'account:npm/right9ctrl', profileUrl: 'https://www.npmjs.com/~right9ctrl' };
const link = { relation: 'maintainer' as const, source: 'npm packument maintainers', confidence: 'high' as const, evidence: 'https://www.npmjs.com/package/event-stream' };

const detail = (over: Partial<AccountDetail> = {}): AccountDetail => ({
  account: ref,
  known: true,
  packages: [
    { name: 'event-stream', links: [link], projects: 1, production: true },
    { name: 'other-thing', links: [{ ...link, relation: 'listed', source: 'npm account package listing' }], projects: 0, production: false },
  ],
  recentPublishes: [{ name: 'event-stream', version: '3.3.6', at: '2018-09-09T08:28:59.503Z', attribution: 'npmUser', projects: 1 }],
  activity: { last24h: 0, last7d: 0, last30d: 0 },
  concentration: { packages: 1, of: 9, share: 0.111 },
  index: { packagesIndexed: 9, packagesWithoutData: 1, listing: { status: 'unavailable', fetchedAt: '2026-10-08T10:00:00Z', count: 0, detail: 'Offline: not in the recorded registry data' }, unverified: 0 },
  incident: null,
  ...over,
});

const exposure = (): AccountExposureResponse => ({
  account: ref,
  since: null,
  asOf: '2026-10-08T10:00:00Z',
  historical: false,
  projectsSearched: 1,
  packages: detail().packages,
  publishedSince: [],
  exposures: [
    {
      projectId: 'p1',
      projectName: 'payments-platform',
      owner: 'Payments team',
      purl: 'pkg:npm/event-stream@3.3.6',
      name: 'event-stream',
      version: '3.3.6',
      production: true,
      direct: true,
      broughtInBy: [],
      reasons: ['can_publish'],
      publishedBy: { account: 'right9ctrl', attribution: 'npmUser', at: '2018-09-09T08:28:59.503Z' },
      links: [link],
      confidence: 'high',
      findingId: 'f1',
    },
  ],
  counts: { exposures: 1, projects: 1, production: 1, packages: 2, packagesInYourProjects: 1, versionsPublishedSince: 0 },
  index: detail().index,
  incident: null,
});

describe('account links', () => {
  it('maps entity ids from "Who\'s behind it" to account pages', () => {
    expect(accountPath('npm', 'GitHub Actions')).toBe('/accounts/npm/GitHub%20Actions');
    expect(accountPathForEntity('account:npm/qix')).toBe('/accounts/npm/qix');
    expect(accountPathForEntity('org:github/chalk')).toBe('/accounts/github/chalk');
    expect(accountPathForEntity('account:github/dominictarr')).toBe('/accounts/github/dominictarr');
    expect(accountPathForEntity('org:npm/x')).toBeNull();
    expect(accountPathForEntity('funder:opencollective/x')).toBeNull();
    expect(activeNavId('/accounts/npm/qix')).toBe('incidents');
  });
});

describe('Account page', () => {
  it('shows exposure production first with owner and link source, packages, publishes and honest index state', async () => {
    fakeApi({ 'GET /api/accounts/npm/right9ctrl': () => detail(), 'GET /api/accounts/npm/right9ctrl/exposure': () => exposure() });
    renderPage(<AccountPage />, { path: '/accounts/:registry/:name', at: '/accounts/npm/right9ctrl', me: meFor('appsec') });
    const table = await screen.findByRole('table', { name: 'Exposure' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('payments-platform');
    expect(rows[1]).toHaveTextContent('Production');
    expect(rows[1]).toHaveTextContent('event-stream@3.3.6');
    expect(rows[1]).toHaveTextContent('Payments team');
    expect(rows[1]).toHaveTextContent('Maintainer · High');
    expect(within(rows[1]!).getByRole('link', { name: 'Open finding' })).toHaveAttribute('href', '/projects/p1/findings/f1');
    const pkgs = screen.getByRole('table', { name: 'Packages it can publish' });
    expect(within(pkgs).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('list', { name: 'Recent publishes' })).toHaveTextContent('event-stream@3.3.6');
    expect(screen.getByText(/Context only, never an alert/)).toBeInTheDocument();
    expect(screen.getByText(/Not available: Offline/)).toBeInTheDocument();
    expect(screen.getByText('11.1%')).toBeInTheDocument();
  });

  it('marks the account as compromised and goes to the incident', async () => {
    const { calls } = fakeApi({
      'GET /api/accounts/npm/right9ctrl': () => detail(),
      'GET /api/accounts/npm/right9ctrl/exposure': () => exposure(),
      'POST /api/accounts/npm/right9ctrl/compromise': (): MarkCompromisedResponse => ({ incidentId: 'ACCOUNT-npm-right9ctrl', created: true, added: 1, raised: 0, exposure: exposure() }),
    });
    renderPage(<AccountPage />, { path: '/accounts/:registry/:name', at: '/accounts/npm/right9ctrl', me: meFor('appsec') });
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as compromised' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Published since/), '2018-09-01T00:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as compromised' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/incidents/ACCOUNT-npm-right9ctrl'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ since: '2018-09-01T00:00:00.000Z' });
  });

  it('keeps the action visible but disabled, with the reason, without Triage', async () => {
    fakeApi({ 'GET /api/accounts/npm/right9ctrl': () => detail(), 'GET /api/accounts/npm/right9ctrl/exposure': () => exposure() });
    renderPage(<AccountPage />, { path: '/accounts/:registry/:name', at: '/accounts/npm/right9ctrl', me: meFor('auditor') });
    expect(await screen.findByRole('button', { name: 'Mark as compromised' })).toBeDisabled();
    expect(screen.getByText(/Needs the Triage permission/)).toBeInTheDocument();
  });

  it('links to the open incident instead of offering a second one', async () => {
    fakeApi({
      'GET /api/accounts/npm/right9ctrl': () => detail({ incident: { id: 'ACCOUNT-npm-right9ctrl', status: 'fixing', since: null, markedAt: '2026-10-08T10:00:00Z' } }),
      'GET /api/accounts/npm/right9ctrl/exposure': () => exposure(),
    });
    renderPage(<AccountPage />, { path: '/accounts/:registry/:name', at: '/accounts/npm/right9ctrl', me: meFor('appsec') });
    expect(await screen.findByRole('link', { name: 'Open the incident' })).toHaveAttribute('href', '/incidents/ACCOUNT-npm-right9ctrl');
    expect(screen.getByRole('button', { name: 'Update the incident' })).toBeEnabled();
  });
});

describe('Exposure: who can publish your production dependencies', () => {
  const conc: ConcentrationResponse = {
    org: { productionPackages: 10, withData: 9, accounts: [{ registry: 'npm', name: 'dominictarr', packages: 7, share: 0.778, projects: 1 }] },
    projects: [{ projectId: 'p1', projectName: 'payments-platform', productionPackages: 10, withData: 9, accounts: [{ registry: 'npm', name: 'dominictarr', packages: 7, share: 0.778 }] }],
  };

  it('shows bars with a Table view and links every account', async () => {
    fakeApi({ 'GET /api/exposure': () => ({ axis: 'project', rows: [], columns: [], cells: [], truncated: false }), 'GET /api/accounts/concentration': () => conc });
    renderPage(<Exposure />, { path: '/exposure', at: '/exposure', me: meFor('appsec') });
    const section = await screen.findByRole('region', { name: 'Who can publish your production dependencies' });
    expect(within(section).getAllByRole('link', { name: 'dominictarr' })[0]).toHaveAttribute('href', '/accounts/npm/dominictarr');
    expect(section).toHaveTextContent('77.8%');
    expect(section).toHaveTextContent('(1 more have none yet)');
    await userEvent.click(within(section).getByRole('button', { name: 'Table' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('cview=table'));
    const t = within(section).getByRole('table', { name: 'Publishing accounts' });
    expect(within(t).getAllByRole('row')).toHaveLength(3);
    expect(t).toHaveTextContent('7 of 9 · in 1 project');
  });
});
