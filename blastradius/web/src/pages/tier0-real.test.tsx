/**
 * Tier 0 screens on recorded real API answers (src/test/real/tier0-api.json: the teardown web DB
 * migrated to schema 13, after a web rescan of parse-server at 23d7bbca): the package page shows
 * who is behind debug, "Who's behind it" says machine-derived and reviewed apart for debug, chalk
 * and express, and the qix account page flags the INC-2025-0002 versions in place.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AccountDetail, AccountExposureResponse } from '@server/api-types-accounts';
import type { PackageBehindResponse, PackageReachResponse } from '@server/api-types-incidents';
import { meFor } from '@/test/fixtures';
import real from '@/test/real/tier0-api.json';
import { fakeApi, renderPage } from './e-parts/testkit';
import AccountPage from './Account';
import BehindPage from './Behind';
import PackagePage from './Package';

const api = real as unknown as {
  behind: Record<'debug' | 'chalk' | 'express', PackageBehindResponse>;
  qix: AccountDetail;
  qixExposure: AccountExposureResponse;
  reachDebug: PackageReachResponse;
};

describe('package page (real: debug)', () => {
  it('shows publish rights, the publisher of each locked version and the owner, with breadcrumbs to Exposure', async () => {
    fakeApi({ 'GET /api/packages/reach': () => api.reachDebug, 'GET /api/packages/behind': () => api.behind.debug });
    renderPage(<PackagePage />, { path: '/packages', at: '/packages?name=debug', me: meFor('appsec') });
    const section = await screen.findByRole('region', { name: 'Who is behind it' });
    expect(within(section).getByRole('list', { name: 'Publish rights' })).toHaveTextContent('npm · qixnpm · tootallnate');
    expect(within(section).getByRole('list', { name: 'Locked versions' })).toHaveTextContent(/4\.4\.3\s*by qix \(npm _npmUser\)/);
    expect(section).toHaveTextContent('GitHub · debug-js (type unknown)');
    expect(section).toHaveTextContent('Machine-derived (deterministic)');
    expect(section).not.toHaveTextContent('(org)');
    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' });
    expect(crumbs).toHaveTextContent('Exposure');
    expect(crumbs).not.toHaveTextContent('Incidents');
  });
});

describe("who's behind it (real: debug, chalk, express)", () => {
  for (const name of ['debug', 'chalk', 'express'] as const) {
    it(`${name}: links listed, every one machine-derived, none called reviewed`, async () => {
      fakeApi({ 'GET /api/packages/behind': () => api.behind[name] });
      renderPage(<BehindPage />, { path: '/packages/behind', at: `/packages/behind?name=${name}&view=table`, me: meFor('auditor') });
      const table = await screen.findByRole('table', { name: 'Links' });
      const rows = within(table).getAllByRole('row').slice(1);
      expect(rows.length).toBe(api.behind[name].links.length);
      for (const r of rows) expect(r).toHaveTextContent('Machine-derived (deterministic)');
      expect(table).not.toHaveTextContent(/Reviewed/);
      expect(table).not.toHaveTextContent(/casino|funder/i);
    });
  }

  it('chalk: funding pages are "receives funding at", never funders', async () => {
    fakeApi({ 'GET /api/packages/behind': () => api.behind.chalk });
    renderPage(<BehindPage />, { path: '/packages/behind', at: '/packages/behind?name=chalk&view=table', me: meFor('auditor') });
    const table = await screen.findByRole('table', { name: 'Links' });
    const oc = within(table).getAllByRole('row').find((r) => r.textContent?.includes('Open Collective · sindresorhus'))!;
    expect(oc).toHaveTextContent('receives funding at');
    expect(oc).toHaveTextContent('(funding page)');
  });
});

describe('account page (real: qix)', () => {
  it('flags the known-bad versions in place, links INC-2025-0002 with its OSV MAL ids, and counts in one unit', async () => {
    fakeApi({ 'GET /api/accounts/npm/qix': () => api.qix, 'GET /api/accounts/npm/qix/exposure': () => api.qixExposure });
    renderPage(<AccountPage />, { path: '/accounts/:registry/:name', at: '/accounts/npm/qix', me: meFor('auditor') });
    const known = await screen.findByRole('list', { name: 'Known incidents and malware' });
    expect(known).toHaveTextContent('INC-2025-0002');
    expect(known).toHaveTextContent('color-convert@3.1.1');
    expect(known).toHaveTextContent('MAL-2025-46971');
    const pubs = screen.getByRole('list', { name: 'Recent publishes' });
    const bad = within(pubs).getAllByRole('listitem').find((li) => li.textContent?.includes('color-convert@3.1.1'))!;
    expect(bad).toHaveTextContent('Known bad: INC-2025-0002');
    const good = within(pubs).getAllByRole('listitem').find((li) => li.textContent?.includes('debug@4.4.3'))!;
    expect(good).not.toHaveTextContent('Known bad');
    await userEvent.click(screen.getByText('How these are counted'));
    expect(screen.getByText(/^7 in production:/)).toBeInTheDocument();
    expect(screen.getByText(/7 of 1917 packages/)).toBeInTheDocument();
  });
});
