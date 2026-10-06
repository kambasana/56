import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Nav } from './Nav';
import { meFor } from '@/test/fixtures';
import type { BuiltinRoleId } from '@server/permissions';

const projects = [
  { id: 'p1', name: 'payments-platform' },
  { id: 'p2', name: 'web-storefront' },
];

function renderNav(role: BuiltinRoleId, path = '/projects/p1/findings', extra = {}) {
  const me = meFor(role, extra);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Nav me={me} projectId="p1" projects={projects} />
    </MemoryRouter>,
  );
}

const linkNames = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .queryAllByRole('link')
    .map((a) => a.textContent);

describe('<Nav>', () => {
  it('shows the three groups from Nav.dc.html for an org admin', () => {
    renderNav('org_admin');
    expect(screen.getByText('Organization', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText('Knowledge')).toBeInTheDocument();
    expect(screen.getByLabelText('Switch project')).toHaveValue('p1');
    expect(linkNames()).toEqual(['Home', 'Projects', 'Reports', 'Integrations', 'Settings', 'Changes', 'Findings', 'Exposure matrix', 'Investigate', 'Scans', 'Incident KB']);
    expect(screen.getByTestId('nav-org')).toHaveTextContent('acme-corp');
  });

  it('hides Settings for AppSec and Developer', () => {
    renderNav('appsec');
    expect(linkNames()).not.toContain('Settings');
    expect(linkNames()).toContain('Findings');
    expect(screen.getByTestId('nav-role')).toHaveTextContent('Role: AppSec');
  });

  it('shows only Reports for an Auditor', () => {
    renderNav('auditor', '/reports');
    expect(linkNames()).toEqual(['Reports']);
    expect(screen.queryByText(/Project ·/)).not.toBeInTheDocument();
    expect(screen.queryByText('Knowledge')).not.toBeInTheDocument();
  });

  it('marks the current page active', () => {
    renderNav('developer', '/projects/p1/exposure');
    const link = screen.getByRole('link', { name: 'Exposure matrix' });
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(link).toHaveAttribute('href', '/projects/p1/exposure');
  });

  it('offers the dev role switcher only in dev mode', async () => {
    const onSwitch = vi.fn();
    const me = meFor('appsec', {
      devMode: true,
      devUsers: [
        { id: 'u_appsec', email: 'appsec@local', name: 'AppSec', roles: ['AppSec'] },
        { id: 'u_auditor', email: 'auditor@local', name: 'Auditor', roles: ['Auditor'] },
      ],
    });
    render(
      <MemoryRouter>
        <Nav me={me} projectId="p1" projects={projects} onSwitchUser={onSwitch} />
      </MemoryRouter>,
    );
    await userEvent.selectOptions(screen.getByLabelText('Dev: view as'), 'u_auditor');
    expect(onSwitch).toHaveBeenCalledWith('u_auditor');
  });

  it('has no dev switcher outside dev mode', () => {
    renderNav('org_admin');
    expect(screen.queryByLabelText('Dev: view as')).not.toBeInTheDocument();
  });
});
