import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from './auth';
import { ProjectProvider } from './project';
import { AppRoutes } from './routes';
import { safeNext } from './pages/Login';
import { meFor } from './test/fixtures';
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

  it('renders org home for an admin', async () => {
    renderAt('/', meFor('org_admin'));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('lands an Auditor on /reports', async () => {
    renderAt('/', meFor('auditor'));
    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/reports');
  });

  it('shows a 403 state for a page outside the role', async () => {
    renderAt('/settings', meFor('developer'));
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
    renderAt('/projects/p1/findings', meFor('auditor'));
    expect(await screen.findAllByText("You don't have access to this page")).toHaveLength(2);
  });

  it('allows a project page through a project-scope binding', async () => {
    renderAt('/projects/p1/findings', meFor('auditor', { projectPermissions: { p1: ['findings'] } }));
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
    ];
    for (const [path, title] of screens) {
      const { unmount } = renderAt(path, meFor('org_admin'));
      expect(await screen.findByRole('heading', { name: title, level: 1 })).toBeInTheDocument();
      unmount();
    }
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
});
