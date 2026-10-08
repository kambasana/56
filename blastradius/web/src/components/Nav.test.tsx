import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Nav, type NavProps } from './Nav';
import { DevViewAs } from './DevViewAs';
import { CommandPaletteProvider } from './CommandPalette';
import { SidebarProvider, SidebarTrigger } from './ui/sidebar';
import { AuthProvider } from '@/auth';
import { ProjectProvider } from '@/project';
import { meFor, reportsOnly } from '@/test/fixtures';
import type { MeResponse } from '@server/api-types';
import type { BuiltinRoleId } from '@server/permissions';

const projects = [
  { id: 'p1', name: 'payments-platform' },
  { id: 'p2', name: 'web-storefront' },
];

function renderNavFor(me: MeResponse, path = '/projects/p1/findings', props: Partial<NavProps> = {}, extra: React.ReactNode = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialMe={me}>
        <ProjectProvider initialProjects={projects}>
          <SidebarProvider>
            <CommandPaletteProvider>
              <Nav me={me} projectId="p1" {...props} />
              {extra}
            </CommandPaletteProvider>
          </SidebarProvider>
        </ProjectProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function renderNav(role: BuiltinRoleId, path = '/projects/p1/findings', extra = {}, props: Partial<NavProps> = {}) {
  return renderNavFor(meFor(role, extra), path, props);
}

const linkNames = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .queryAllByRole('link')
    .map((a) => a.textContent);

describe('<Nav>', () => {
  it('shows one level of pages, Reports and Settings at the bottom, for an org admin', () => {
    renderNav('org_admin', '/');
    expect(linkNames()).toEqual(['Overview', 'Findings', 'Incidents', 'Projects', 'Alerts', 'Reports', 'Settings']);
    expect(screen.queryByText('Incident KB')).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('nav-org')).toHaveTextContent('acme-corp');
    expect(screen.getByRole('button', { name: /Search or jump to/ })).toBeInTheDocument();
    // shadcn sidebar: icon-collapsible sidebar.
    expect(document.querySelector('[data-slot=sidebar]')).toHaveAttribute('data-collapsible', '');
  });

  it('sends AppSec to Sources from Settings and shows the role', () => {
    renderNav('appsec');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/integrations');
    expect(linkNames()).toContain('Findings');
    expect(screen.getByTestId('nav-role')).toHaveTextContent('Role: AppSec');
  });

  it('shows only Reports for a reports-only member', () => {
    renderNavFor(reportsOnly(), '/reports');
    expect(linkNames()).toEqual(['Reports']);
  });

  it('marks the current page active and carries the scope on scoped links', () => {
    renderNav('developer', '/projects/p1/exposure?env=prod&severity=critical');
    const projectsLink = screen.getByRole('link', { name: 'Projects' });
    expect(projectsLink).toHaveAttribute('aria-current', 'page');
    expect(projectsLink).toHaveAttribute('data-active', 'true');
    expect(projectsLink).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: 'Findings' })).toHaveAttribute('href', '/findings?env=prod');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/?env=prod');
  });

  it('switches org from the header switcher', async () => {
    const user = userEvent.setup();
    const onSwitchOrg = vi.fn();
    renderNav(
      'org_admin',
      '/',
      {
        orgs: [
          { id: 'org_1', name: 'acme-corp' },
          { id: 'org_2', name: 'globex' },
        ],
      },
      { onSwitchOrg },
    );
    await user.click(screen.getByRole('button', { name: /Switch organization/ }));
    await user.click(screen.getByRole('menuitemradio', { name: 'globex' }));
    expect(onSwitchOrg).toHaveBeenCalledWith('org_2');
  });

  it('labels org items uniquely by name, current one checked', async () => {
    const user = userEvent.setup();
    const onSwitchOrg = vi.fn();
    renderNav(
      'org_admin',
      '/',
      {
        org: { id: 'org_1', name: 'Hammer QA' },
        orgs: [
          { id: 'org_1', name: 'Hammer QA' },
          { id: 'org_2', name: 'Hammer' },
        ],
      },
      { onSwitchOrg },
    );
    await user.click(screen.getByRole('button', { name: /Switch organization/ }));
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['Hammer QA', 'Hammer']);
    expect(within(menu).getByRole('menuitemradio', { name: 'Hammer QA' })).toHaveAttribute('aria-checked', 'true');
    const other = within(menu).getByRole('menuitemradio', { name: 'Hammer' });
    expect(other).toHaveAttribute('aria-checked', 'false');
    await user.click(other);
    expect(onSwitchOrg).toHaveBeenCalledWith('org_2');
  });

  it('keeps the sidebar rail inside the sidebar (never over the page)', () => {
    const { container } = renderNav('org_admin');
    const rail = container.querySelector('[data-slot=sidebar-rail]')!;
    expect(rail.className).toContain('group-data-[side=left]:right-0');
    expect(rail.className).not.toContain('-right-4');
    expect(rail.className).not.toContain('-translate-x-1/2');
  });

  it('closes the mobile nav sheet after choosing a page', async () => {
    const user = userEvent.setup();
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      renderNavFor(meFor('org_admin'), '/projects/p1/findings', {}, <SidebarTrigger />);
      await user.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));
      const sheet = await screen.findByRole('dialog');
      await user.click(within(sheet).getByRole('link', { name: 'Projects' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    } finally {
      window.innerWidth = width;
    }
  });

  it('offers theme and sign out in the user menu, and no dev switcher there', async () => {
    const user = userEvent.setup();
    const onTheme = vi.fn();
    const onLogout = vi.fn();
    renderNav('appsec', '/', { devMode: true, devUsers: [{ id: 'u_x', email: 'x@local', name: 'X', roles: [] }] }, { onThemeChange: onTheme, onLogout, theme: 'system' });
    await user.click(screen.getByTestId('nav-user'));
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('Dev: view as')).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(onTheme).toHaveBeenCalledWith('dark');
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('nav-user'));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalled();
  });

  it('opens the command palette from the search button', async () => {
    const user = userEvent.setup();
    renderNav('org_admin', '/');
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect(await screen.findByRole('combobox', { name: 'Search packages, projects, people, settings' })).toBeInTheDocument();
  });
});

describe('<DevViewAs>', () => {
  const devMe = (devMode: boolean) =>
    meFor('appsec', {
      devMode,
      devUsers: [
        { id: 'u_appsec', email: 'appsec@local', name: 'AppSec', roles: ['AppSec'] },
        { id: 'u_auditor', email: 'auditor@local', name: 'Auditor', roles: ['Auditor'] },
      ],
    });

  it('switches user in dev mode', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn();
    render(<DevViewAs me={devMe(true)} onSwitchUser={onSwitch} />);
    await user.click(screen.getByRole('button', { name: 'Dev: view as' }));
    await user.click(screen.getByRole('menuitemradio', { name: /auditor@local/ }));
    expect(onSwitch).toHaveBeenCalledWith('u_auditor');
  });

  it('renders nothing outside dev mode', () => {
    const { container } = render(<DevViewAs me={devMe(false)} onSwitchUser={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
