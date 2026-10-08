import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { OverviewResponse } from '@server/api-types';
import { setFetcher } from '@/api';
import { meFor } from '@/test/fixtures';
import OrgHome from '../../OrgHome';
import { fakeApi, renderPage } from './kit';

afterEach(() => setFetcher((...a) => fetch(...a)));

const NOW = new Date().toISOString();

const OVERVIEW: OverviewResponse = {
  at: NOW,
  since: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  projects: 3,
  scannedProjects: 2,
  attention: {
    criticalOpen: 4,
    criticalOpenProd: 2,
    highUnassigned: 11,
    highUnassignedOldest: new Date(Date.now() - 9 * 86_400_000).toISOString(),
    newThisWeek: 23,
    newThisWeekProjects: 2,
    sourcesToCheck: [{ projectId: 'p3', projectName: 'billing', problem: 'failed', detail: 'GitHub returned 404' }],
  },
  bySeverity: [
    { level: 'critical', open: 4, newInRange: 3 },
    { level: 'high', open: 17, newInRange: 5 },
    { level: 'medium', open: 61, newInRange: 0 },
    { level: 'low', open: 46, newInRange: 2 },
  ],
  topPackages: [{ purl: 'pkg:npm/minimist@1.2.5', name: 'minimist', version: '1.2.5', level: 'high', reason: 'Prototype pollution', projects: 9, prodProjects: 4 }],
  incident: { advisoryId: 'GHSA-pjwm-rvh2-c87w', purl: 'pkg:npm/ua-parser-js@0.7.29', name: 'ua-parser-js', version: '0.7.29', projects: 3, production: 1, detectedAt: NOW },
};

const at = (path = '/', me = meFor('org_admin')) => ({ path, pattern: '/', me });

describe('<OrgHome> (Overview)', () => {
  it('shows the incident banner, four tiles linking to filtered Findings, severity counts and top packages', async () => {
    const api = fakeApi([['GET', /^\/api\/overview$/, () => OVERVIEW]]);
    renderPage(<OrgHome />, at('/?env=prod'));
    const banner = await screen.findByRole('link', { name: /Active incident/ });
    expect(banner).toHaveAttribute('href', '/incidents/GHSA-pjwm-rvh2-c87w');
    expect(banner).toHaveTextContent('3 projects affected · 1 in production');
    const tiles = within(screen.getByRole('region', { name: 'Needs attention' })).getAllByRole('link');
    expect(tiles.map((t) => t.getAttribute('href'))).toEqual([
      '/findings?env=prod&severity=critical&status=new%2Creviewed%2Cfixing',
      '/findings?env=prod&severity=high&owner=none&status=new%2Creviewed%2Cfixing',
      '/findings?env=prod&new=week&status=new%2Creviewed%2Cfixing',
      '/projects/p3/scans',
    ]);
    expect(tiles[0]).toHaveTextContent('Critical open42 in production');
    expect(tiles[1]).toHaveTextContent('Oldest first seen 9 d ago');
    expect(tiles[3]).toHaveTextContent('billing: last scan failed');
    const sev = screen.getByRole('table', { name: 'Open findings by severity' });
    expect(within(sev).getAllByRole('row').map((r) => r.textContent)).toContain('▲ High17+5 new');
    expect(screen.getByText(/no trend line is drawn/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /minimist@1.2.5/ })).toHaveAttribute('href', '/packages?name=minimist&version=1.2.5');
    expect(screen.getByRole('link', { name: /minimist@1.2.5/ })).toHaveTextContent('9 projects · 4 prod');
    await waitFor(() => expect(api.calls.find((c) => c.url.pathname === '/api/overview')!.url.searchParams.get('env')).toBe('prod'));
  });

  it('shows no banner without an incident, and an all-clear without open findings', async () => {
    fakeApi([['GET', /^\/api\/overview$/, () => ({ ...OVERVIEW, incident: null, topPackages: [] })]]);
    renderPage(<OrgHome />, at());
    expect(await screen.findByText('No open findings')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Active incident/ })).toBeNull();
  });

  it('explains a missing permission and errors where they happen', async () => {
    fakeApi([['GET', /^\/api\/overview$/, () => ({ status: 403, body: { error: { code: 'forbidden', message: 'Missing permission: findings' } } })]]);
    const { unmount } = renderPage(<OrgHome />, at());
    expect(await screen.findByText('Findings are not part of your roles')).toBeInTheDocument();
    unmount();
    fakeApi([['GET', /^\/api\/overview$/, () => ({ status: 500, body: { error: { code: 'internal', message: 'database is locked' } } })]]);
    renderPage(<OrgHome />, at());
    expect(await screen.findByText('database is locked')).toBeInTheDocument();
  });
});
