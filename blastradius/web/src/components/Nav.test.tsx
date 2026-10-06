import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Nav, type NavProps } from './Nav';
import { SidebarProvider } from './ui/sidebar';
import { meFor } from '@/test/fixtures';
import type { BuiltinRoleId } from '@server/permissions';

const projects = [
  { id: 'p1', name: 'payments-platform' },
  { id: 'p2', name: 'web-storefront' },
];

function renderNav(role: BuiltinRoleId, path = '/projects/p1/findings', extra = {}, props: Partial<NavProps> = {}) {
  const me = meFor(role, extra);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <Nav me={me} projectId="p1" projects={projects} {...props} />
      </SidebarProvider>
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
    expect(screen.getByRole('button', { name: 'Switch project' })).toHaveTextContent('payments-platform');
    expect(linkNames()).toEqual(['Home', 'Projects', 'Reports', 'Integrations', 'Settings', 'Changes', 'Findings', 'Exposure matrix', 'Investigate', 'Scans', 'Incident KB']);
    expect(screen.getByTestId('nav-org')).toHaveTextContent('acme-corp');
    // shadcn sidebar-07: icon-collapsible sidebar.
    expect(document.querySelector('[data-slot=sidebar]')).toHaveAttribute('data-collapsible', '');
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
    expect(link).toHaveAttribute('data-active', 'true');
    expect(link).toHaveAttribute('href', '/projects/p1/exposure');
  });

  it('switches project from the project group label', async () => {
    const user = userEvent.setup();
    renderNav('developer', '/projects/p1/exposure');
    await user.click(screen.getByRole('button', { name: 'Switch project' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'web-storefront' }));
    expect(screen.getByRole('link', { name: 'Exposure matrix' })).toBeInTheDocument();
  });

  it('switches org from the header switcher', async () => {
    const user = userEvent.setup();
    const onSwitchOrg = vi.fn();
    renderNav('org_admin', '/', { orgs: [{ id: 'org_1', name: 'acme-corp' }, { id: 'org_2', name: 'globex' }] }, { onSwitchOrg });
    await user.click(screen.getByRole('button', { name: /Switch organization/ }));
    await user.click(screen.getByRole('menuitem', { name: /globex/ }));
    expect(onSwitchOrg).toHaveBeenCalledWith('org_2');
  });

  it('offers theme, the dev role switcher in dev mode, and sign out in the user menu', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn();
    const onTheme = vi.fn();
    const onLogout = vi.fn();
    renderNav(
      'appsec',
      '/',
      {
        devMode: true,
        devUsers: [
          { id: 'u_appsec', email: 'appsec@local', name: 'AppSec', roles: ['AppSec'] },
          { id: 'u_auditor', email: 'auditor@local', name: 'Auditor', roles: ['Auditor'] },
        ],
      },
      { onSwitchUser: onSwitch, onThemeChange: onTheme, onLogout, theme: 'system' },
    );
    await user.click(screen.getByTestId('nav-user'));
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(onTheme).toHaveBeenCalledWith('dark');
    expect(screen.getByText('Dev: view as')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitemradio', { name: /auditor@local/ }));
    expect(onSwitch).toHaveBeenCalledWith('u_auditor');
    await user.click(screen.getByTestId('nav-user'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalled();
  });

  it('has no dev switcher outside dev mode', async () => {
    const user = userEvent.setup();
    renderNav('org_admin', '/', {}, { onSwitchUser: vi.fn() });
    await user.click(screen.getByTestId('nav-user'));
    expect(screen.queryByText('Dev: view as')).not.toBeInTheDocument();
  });
});
