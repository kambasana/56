/**
 * Tier 0.5 screens: the package page while the account index is still running (pending, not
 * "unknown"), on the recorded real answer for debug (src/test/real/tier0-api.json) as the index
 * returns it before its registry data is in; and the demo project's badge on the Projects page.
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PackageBehindResponse, PackageReachResponse } from '@server/api-types-incidents';
import type { ProjectRow } from '@server/api-types';
import { meFor } from '@/test/fixtures';
import real from '@/test/real/tier0-api.json';
import { fakeApi, renderPage } from './e-parts/testkit';
import PackagePage from './Package';
import ProjectsPage from './Projects';

const api = real as unknown as { behind: Record<'debug', PackageBehindResponse>; reachDebug: PackageReachResponse };

describe('package page while the account index runs (real: debug)', () => {
  it('says "indexing" for publish rights and publishers, never "not known"', async () => {
    const debug = api.behind.debug;
    const pending: PackageBehindResponse = { ...debug, publishRights: null, pending: true, lockedVersions: debug.lockedVersions.map((v) => ({ ...v, publisher: null })) };
    fakeApi({ 'GET /api/packages/reach': () => api.reachDebug, 'GET /api/packages/behind': () => pending });
    renderPage(<PackagePage />, { path: '/packages', at: '/packages?name=debug', me: meFor('appsec') });
    const section = await screen.findByRole('region', { name: 'Who is behind it' });
    expect(within(section).getByRole('status')).toHaveTextContent('Indexing: the account index is still fetching registry data for it.');
    expect(within(section).getByRole('list', { name: 'Locked versions' })).toHaveTextContent('publisher: indexing…');
    expect(section).not.toHaveTextContent('publisher not known');
    expect(section).not.toHaveTextContent('No registry data for it yet');
  });
});

describe('projects page with the demo project', () => {
  const row = (id: string, name: string, extra: Partial<ProjectRow> = {}): ProjectRow => ({
    id,
    orgId: 'o1',
    name,
    tier: 'Standard',
    tierOverrides: {},
    target: name === 'payments-platform' ? '/srv/blastradius/test/fixtures/e2e-repo' : `https://github.com/acme/${name}`,
    owner: null,
    createdAt: '2026-10-12T00:00:00Z',
    updatedAt: '2026-10-12T00:00:00Z',
    lastScan: null,
    assets: 1,
    components: 10,
    counts: { critical: 1, high: 0, medium: 2, low: 0 },
    trend: [],
    toReview: 1,
    ...extra,
  });

  it('badges it "demo" and leaves it out of the count', async () => {
    fakeApi({ 'GET /api/projects': () => ({ items: [row('p1', 'payments-platform', { demo: true }), row('p2', 'parse-server')], nextCursor: null }) });
    renderPage(<ProjectsPage />, { path: '/projects', at: '/projects', me: meFor('org_admin') });
    const table = await screen.findByRole('table', { name: 'Projects' });
    const demo = within(table).getAllByRole('row').find((r) => r.textContent?.includes('payments-platform'))!;
    expect(within(demo).getByText('demo')).toBeInTheDocument();
    const real = within(table).getAllByRole('row').find((r) => r.textContent?.includes('parse-server'))!;
    expect(within(real).queryByText('demo')).toBeNull();
    expect(screen.getByText('1 project · 1 demo (not counted)')).toBeInTheDocument();
  });
});
