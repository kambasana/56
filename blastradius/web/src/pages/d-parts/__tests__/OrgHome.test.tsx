import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExposureMatrixResponse, OrgHomeResponse } from '@server/api-types';
import { setFetcher } from '@/api';
import { meFor } from '@/test/fixtures';
import OrgHome, { sharedComponents } from '../../OrgHome';
import { fakeApi, projectRow, renderPage } from './kit';

afterEach(() => setFetcher((...a) => fetch(...a)));

const HOME: OrgHomeResponse = {
  org: { id: 'org_1', name: 'acme-corp', slug: 'acme-corp', createdAt: '2018-01-01T00:00:00.000Z' },
  totals: { projects: 2, assets: 8, components: 240, counts: { critical: 2, high: 1, medium: 0, low: 8 }, toReview: 5 },
  projects: [projectRow('p1', 'payments-platform'), projectRow('p2', 'web-storefront', { tier: 'Large', counts: { critical: 0, high: 0, medium: 1, low: 2 }, lastScan: null })],
  recentScans: [{ id: 's1', projectId: 'p1', status: 'succeeded', createdAt: '2018-11-27T10:00:00.000Z', finishedAt: '2018-11-27T10:01:00.000Z' }],
};

const EXPOSURE: ExposureMatrixResponse = {
  axis: 'project',
  rows: [
    { key: 'p1', label: 'payments-platform', projectId: 'p1', environment: null, criticality: null, blastScore: 10 },
    { key: 'p2', label: 'web-storefront', projectId: 'p2', environment: null, criticality: null, blastScore: 5 },
  ],
  columns: [
    { findingId: 'f1', projectId: 'p1', purl: 'pkg:npm/solo@1.0.0', name: 'solo', version: '1.0.0', level: 'critical', score: 99, reach: 1 },
    { findingId: 'f2', projectId: 'p1', purl: 'pkg:npm/event-stream@3.3.6', name: 'event-stream', version: '3.3.6', level: 'high', score: 80, reach: 2 },
  ],
  cells: [
    { row: 0, col: 0, exposure: 1, pathCount: 1 },
    { row: 0, col: 1, exposure: 1, pathCount: 1 },
    { row: 1, col: 1, exposure: 0.5, pathCount: 2 },
  ],
  truncated: false,
};

const at = (me = meFor('org_admin')) => ({ path: '/', pattern: '/', me });

describe('<OrgHome>', () => {
  it('shows totals, the projects table and recent scans', async () => {
    fakeApi([
      ['GET', /^\/api\/home$/, () => HOME],
      ['GET', /^\/api\/exposure$/, () => EXPOSURE],
    ]);
    renderPage(<OrgHome />, at());
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(within(table).getByText('payments-platform')).toBeInTheDocument();
    expect(within(table).getByText('Large')).toBeInTheDocument();
    expect(within(table).getByText('never')).toBeInTheDocument();
    expect(screen.getByText('2 projects · 8 assets · 240 components')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Recent scans' })).toHaveTextContent('payments-platform');
    expect(screen.getByRole('heading', { name: 'Projects', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recent scans' })).toBeInTheDocument();
  });

  it('shows a skeleton while loading', async () => {
    fakeApi([['GET', /^\/api\/home$/, () => new Promise(() => {})]]);
    renderPage(<OrgHome />, at(meFor('developer', { permissions: ['home'] })));
    expect(screen.getByRole('status', { name: 'Loading organization…' })).toBeInTheDocument();
  });

  it('lists shared risky components, most shared first', async () => {
    fakeApi([
      ['GET', /^\/api\/home$/, () => HOME],
      ['GET', /^\/api\/exposure$/, () => EXPOSURE],
    ]);
    renderPage(<OrgHome />, at());
    const list = await screen.findByRole('list', { name: 'Shared risky components' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('event-stream@3.3.6');
    expect(items[0]).toHaveTextContent('2 projects');
    expect(within(items[0]!).getByRole('link', { name: 'Investigate' })).toHaveAttribute('href', '/projects/p1/investigate?node=pkg%3Anpm%2Fevent-stream%403.3.6');
    expect(sharedComponents(EXPOSURE).map((c) => c.name)).toEqual(['event-stream', 'solo']);
  });

  it('opens a project on row click', async () => {
    const user = userEvent.setup();
    fakeApi([
      ['GET', /^\/api\/home$/, () => HOME],
      ['GET', /^\/api\/exposure$/, () => EXPOSURE],
    ]);
    renderPage(<OrgHome />, at());
    await user.click(await screen.findByText('web-storefront'));
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p2/findings');
  });

  it('hides New project and shared components without the permissions', async () => {
    const api = fakeApi([['GET', /^\/api\/home$/, () => HOME]]);
    renderPage(<OrgHome />, at(meFor('developer', { permissions: ['home', 'findings'] })));
    await screen.findByRole('table', { name: 'Projects' });
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    expect(screen.queryByText('Shared risky components')).toBeNull();
    expect(api.calls.some((c) => c.url.pathname === '/api/exposure')).toBe(false);
  });

  it('creates a project from the dialog', async () => {
    const user = userEvent.setup();
    const api = fakeApi([
      ['GET', /^\/api\/home$/, () => HOME],
      ['GET', /^\/api\/exposure$/, () => EXPOSURE],
      ['POST', /^\/api\/projects$/, () => ({ status: 201, body: { ...projectRow('p9', 'new-one') } })],
    ]);
    renderPage(<OrgHome />, at());
    await screen.findByRole('table', { name: 'Projects' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    expect(within(dialog).getByLabelText('Name')).toHaveFocus();
    await user.type(within(dialog).getByLabelText('Name'), 'new-one');
    await user.type(within(dialog).getByLabelText('Target'), 'https://github.com/acme/new-one');
    await user.click(within(dialog).getByRole('combobox', { name: 'Size tier' }));
    await user.click(await screen.findByRole('option', { name: /^Small/ }));
    expect(within(dialog).getByRole('combobox', { name: 'Size tier' })).toHaveTextContent(/^Small/);
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/projects/p9/scans'));
    expect(await screen.findByText('Project “new-one” created')).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ name: 'new-one', tier: 'Small', target: 'https://github.com/acme/new-one' });
  });

  it('shows server validation errors in the dialog and closes on Escape', async () => {
    const user = userEvent.setup();
    fakeApi([
      ['GET', /^\/api\/home$/, () => HOME],
      ['GET', /^\/api\/exposure$/, () => EXPOSURE],
      ['POST', /^\/api\/projects$/, () => ({ status: 400, body: { error: { code: 'bad_request', message: 'Target host is not allowed', fields: ['target'] } } })],
    ]);
    renderPage(<OrgHome />, at());
    await screen.findByRole('table', { name: 'Projects' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'x');
    await user.type(within(dialog).getByLabelText('Target'), 'https://evil.example/x');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Target host is not allowed');
    expect(within(dialog).getByText('Target host is not allowed').closest('[data-slot=field]')).toContainElement(within(dialog).getByLabelText('Target'));
    expect(within(dialog).getByLabelText('Target')).toHaveAttribute('aria-invalid', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an empty state with no projects, and an error state', async () => {
    fakeApi([
      ['GET', /^\/api\/home$/, () => ({ ...HOME, projects: [], recentScans: [] })],
      ['GET', /^\/api\/exposure$/, () => ({ ...EXPOSURE, columns: [], cells: [], rows: [] })],
    ]);
    renderPage(<OrgHome />, at());
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    fakeApi([['GET', /^\/api\/home$/, () => ({ status: 500, body: { error: { code: 'internal', message: 'Boom' } } })]]);
    renderPage(<OrgHome />, at(meFor('developer', { permissions: ['home'] })));
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
  });

  it('falls back to /api/projects for a user without the home page', async () => {
    const api = fakeApi([['GET', /^\/api\/projects$/, () => ({ items: HOME.projects, total: 2, nextCursor: null })]]);
    renderPage(<OrgHome />, at(meFor('developer', { permissions: ['projects', 'findings'] })));
    await screen.findByRole('table', { name: 'Projects' });
    expect(api.calls.some((c) => c.url.pathname === '/api/home')).toBe(false);
    expect(screen.getByText('2 projects · 8 assets · 240 components')).toBeInTheDocument();
  });
});
