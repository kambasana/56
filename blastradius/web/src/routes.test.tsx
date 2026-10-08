import { lazy } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth';
import { ProjectProvider } from './project';
import { AppRoutes, PAGES, RouteErrorBoundary, isChunkLoadError } from './routes';
import { safeNext } from './pages/Login';
import { meFor, reportsOnly } from './test/fixtures';
import type { MeResponse } from '@server/api-types';

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function renderAt(path: string, me: MeResponse | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialMe={me}>
        <ProjectProvider initialProjects={[{ id: 'p1', name: 'payments-platform' }]}>
          <AppRoutes />
          <Where />
        </ProjectProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('routes', () => {
  it('sends anonymous users to /login with next', async () => {
    renderAt('/projects/p1/findings', null);
    expect(await screen.findByRole('heading', { name: 'Sign in to Blastradius' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/login?next=%2Fprojects%2Fp1%2Ffindings');
  });

  it('renders the Overview for an admin', async () => {
    renderAt('/', meFor('org_admin'));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('lands an Auditor on /reports', async () => {
    renderAt('/', reportsOnly());
    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/reports');
  });

  it('shows a 403 state for a page outside the role', async () => {
    renderAt('/settings', meFor('developer'));
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
    renderAt('/projects/p1/findings', reportsOnly());
    expect(await screen.findAllByText("You don't have access to this page")).toHaveLength(2);
  });

  it('allows a project page through a project-scope binding', async () => {
    renderAt('/projects/p1/findings', reportsOnly({ projectPermissions: { p1: ['findings'] } }));
    expect(await screen.findByRole('heading', { name: 'Findings' })).toBeInTheDocument();
  });

  it('registers every screen route', async () => {
    const screens: [string, string][] = [
      ['/projects/p1/changes', 'Changes'],
      ['/projects/p1/findings/f1', 'Finding'],
      ['/projects/p1/exposure', 'Exposure matrix'],
      ['/projects/p1/investigate', 'Investigate'],
      ['/projects/p1/scans', 'Scans'],
      ['/integrations', 'Integrations'],
      ['/settings', 'Settings'],
      ['/projects', 'Projects'],
      ['/incidents', 'Incidents'],
      ['/alerts', 'Alerts'],
      ['/packages?name=lodash&version=4.17.20', 'lodash@4.17.20'],
    ];
    for (const [path, title] of screens) {
      const { unmount } = renderAt(path, meFor('org_admin'));
      expect(await screen.findByRole('heading', { name: title, level: 1 })).toBeInTheDocument();
      unmount();
    }
  });

  it('opens the org-wide Findings at /findings, keeping scope and filters in the URL', async () => {
    renderAt('/findings?env=prod&severity=critical', meFor('developer'));
    expect(await screen.findByRole('heading', { name: 'Findings', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/findings?env=prod&severity=critical');
  });

  it('opens a project on its first allowed page', async () => {
    renderAt('/projects/p1', meFor('org_admin'));
    expect(await screen.findByRole('heading', { name: 'Findings', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p1/findings');
  });

  it('shows the project sub-nav on project pages and every crumb as a link', async () => {
    renderAt('/projects/p1/scans', meFor('org_admin'));
    await screen.findByRole('heading', { name: 'Scans', level: 1 });
    const sub = screen.getByRole('navigation', { name: 'Project' });
    expect(within(sub).getAllByRole('link').map((a) => a.textContent)).toEqual(['Changes', 'Findings', 'Exposure matrix', 'Investigate', 'Scans']);
    expect(within(sub).getByRole('link', { name: 'Scans' })).toHaveAttribute('aria-current', 'page');
    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' });
    const links = within(crumbs).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['acme-corp', 'payments-platform', 'Scans']);
    expect(links[1]).toHaveAttribute('href', '/projects/p1');
    expect(links[2]).toHaveAttribute('aria-current', 'page');
  });

  it('shows the settings sub-nav with Sources', async () => {
    renderAt('/integrations', meFor('org_admin'));
    await screen.findByRole('heading', { name: 'Integrations', level: 1 });
    const sub = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(sub).getAllByRole('link').map((a) => a.textContent)).toEqual(['Members and roles', 'Sources']);
  });

  it('shows not found for unknown paths', async () => {
    renderAt('/nope', meFor('org_admin'));
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('only allows same-app redirects after login', () => {
    expect(safeNext('/reports')).toBe('/reports');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });

  it('shows ErrorState inside the shell when a page throws, retries, and resets on navigation', async () => {
    const original = PAGES['/integrations']!;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    function Broken() {
      if (fail) throw new Error('Page exploded');
      return <h1>Recovered page</h1>;
    }
    PAGES['/integrations'] = lazy(async () => ({ default: Broken }));
    try {
      const { unmount } = renderAt('/integrations', meFor('org_admin'));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not load this page');
      expect(alert).toHaveTextContent('Page exploded');
      // The shell is still mounted and usable.
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect(nav).toBeInTheDocument();
      fail = false;
      await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { name: 'Recovered page' })).toBeInTheDocument();
      unmount();
      // Navigating away from a failed page clears the error.
      fail = true;
      renderAt('/integrations', meFor('org_admin'));
      await screen.findByRole('alert');
      await userEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Reports' }));
      expect(await screen.findByRole('heading', { name: 'Reports', level: 1 })).toBeInTheDocument();
      expect(screen.queryByText('Could not load this page')).toBeNull();
    } finally {
      PAGES['/integrations'] = original;
      quiet.mockRestore();
    }
  });

  it('clears a caught page error when the location key changes (same route, new params)', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Page({ id }: { id: string }) {
      if (id === 'f1') throw new Error('f1 broke');
      return <p>finding {id}</p>;
    }
    const { rerender } = render(
      <RouteErrorBoundary resetKey="k1">
        <Page id="f1" />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('f1 broke');
    rerender(
      <RouteErrorBoundary resetKey="k2">
        <Page id="f2" />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText('finding f2')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    quiet.mockRestore();
  });

  it('recognises a failed lazy chunk', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/Findings-abc.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Page exploded'))).toBe(false);
  });
});
