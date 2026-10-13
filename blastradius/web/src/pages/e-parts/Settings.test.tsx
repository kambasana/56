import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry, ListRolesResponse, Permission, Role } from '@server/api-types';
import { ACTION_PERMISSIONS, PAGE_PERMISSIONS, PERMISSION_LABELS, ROLE_TEMPLATES, defaultRoles } from '@server/permissions';
import Settings from '../Settings';
import { meFor } from '@/test/fixtures';
import { changes, describeAudit, draftFrom, toggle } from './rbac';
import { Reply, choose, fakeApi, renderPage, type Call } from './testkit';

function rolesBody(extra: Role[] = []): ListRolesResponse {
  const items: Role[] = defaultRoles().map((r) => ({ ...r, orgId: 'org_1', builtIn: true, template: r.id, updatedAt: '2026-10-06T00:00:00Z' }));
  return {
    items: [...items, ...extra],
    catalogue: { pages: [...PAGE_PERMISSIONS], actions: [...ACTION_PERMISSIONS], labels: { ...PERMISSION_LABELS } },
  };
}

const members = {
  items: [
    { id: 'u_admin', email: 'admin@local', name: 'Ada Admin', bindings: [{ id: 'b1', orgId: 'org_1', roleId: 'org_admin', subject: { kind: 'user', userId: 'u_admin' }, scope: { kind: 'org' }, createdAt: '2026-10-06T00:00:00Z', createdBy: 'system' }] },
    { id: 'u_dev', email: 'dev@local', name: 'Dee Dev', bindings: [{ id: 'b2', orgId: 'org_1', roleId: 'developer', subject: { kind: 'user', userId: 'u_dev' }, scope: { kind: 'project', projectId: 'p1' }, createdAt: '2026-10-06T00:00:00Z', createdBy: 'u_admin' }] },
  ],
};

const bindings = {
  items: [
    { ...members.items[0]!.bindings[0]!, subjectLabel: 'admin@local', roleName: 'Org admin', scopeLabel: 'Organisation' },
    { ...members.items[1]!.bindings[0]!, subjectLabel: 'dev@local', roleName: 'Developer', scopeLabel: 'payments-platform' },
  ],
};

const auditEntry = (i: number, action: string, detail: Record<string, unknown>): AuditEntry => ({
  id: `a${i}`,
  at: '2026-10-06T02:14:00Z',
  actor: 'u_admin',
  action,
  target: 'developer',
  detail,
});

function settingsApi(overrides: Record<string, (c: Call) => unknown> = {}) {
  let audit: AuditEntry[] = [auditEntry(1, 'project.create', { after: { name: 'payments-platform' } })];
  const api = fakeApi({
    'GET /api/roles': () => rolesBody(),
    'GET /api/bindings': () => bindings,
    'GET /api/members': () => members,
    'GET /api/audit': () => ({ items: audit, total: audit.length, nextCursor: null }),
    'GET /api/projects/p1': () => ({
      id: 'p1',
      orgId: 'org_1',
      name: 'payments-platform',
      tier: 'Standard',
      tierOverrides: { graphNodeCap: 80 },
      target: 'https://github.com/acme/payments',
      owner: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    }),
    'PATCH /api/roles/developer': (c) => {
      const body = c.body as { permissions: Permission[] };
      audit = [
        auditEntry(2, 'role.update', { before: { name: 'Developer', permissions: [...ROLE_TEMPLATES.developer.permissions] }, after: { name: 'Developer', permissions: body.permissions } }),
        ...audit,
      ];
      return { ...rolesBody().items[2], permissions: body.permissions };
    },
    'POST /api/roles': (c) => ({ id: 'role_x', ...(c.body as object) }),
    'POST /api/bindings': () => ({ id: 'b3' }),
    'DELETE /api/bindings/b2': () => ({ ok: true }),
    'PATCH /api/projects/p1': () => ({ ok: true }),
    ...overrides,
  });
  return api;
}

describe('rbac helpers', () => {
  it('drafts toggles, never changes Org admin, and lists changed roles', () => {
    const roles = rolesBody().items;
    let d = draftFrom(roles);
    d = toggle(d, 'org_admin', 'home', false);
    expect(changes(roles, d)).toEqual([]);
    d = toggle(d, 'developer', 'review', true);
    d = toggle(d, 'auditor', 'reports', false);
    expect(changes(roles, d).map((c) => [c.id, c.permissions.includes('review'), c.permissions.length])).toEqual([
      ['developer', true, 10],
      ['auditor', false, 8],
    ]);
    d = toggle(d, 'developer', 'review', false);
    expect(changes(roles, d).map((c) => c.id)).toEqual(['auditor']);
  });

  it('describes audit entries in plain text', () => {
    expect(describeAudit('role.update', 'developer', { before: { name: 'Developer', permissions: ['home'] }, after: { name: 'Developer', permissions: ['home', 'review'] } })).toBe(
      'Updated role Developer: +review',
    );
    expect(describeAudit('role.create', 'role_1', { after: { name: 'Leadership' } })).toBe('Created role Leadership');
    expect(describeAudit('scan.create', 's1', {})).toBe('scan.create s1');
  });
});

const rolesAt = '/settings?tab=roles';

describe('<Settings>', () => {
  it('has Members, Roles, Bindings, Project and Audit log tabs synced to the URL', async () => {
    settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    const tabs = await screen.findByRole('tablist', { name: 'Settings sections' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Members', 'Roles', 'Bindings', 'Project · payments-platform', 'Audit log']);
    expect(within(tabs).getByRole('tab', { name: 'Members' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Roles' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings?tab=roles');
    expect(await screen.findByRole('table', { name: 'Permissions by role' })).toBeInTheDocument();
  });

  it('lets an admin edit the permission matrix, saves through the API and shows the audit entry', async () => {
    const { calls } = settingsApi();
    renderPage(<Settings />, { path: '/settings', at: rolesAt, me: meFor('org_admin') });
    const matrix = await screen.findByRole('table', { name: 'Permissions by role' });
    expect(within(matrix).getAllByRole('columnheader').map((h) => h.textContent?.replace(/(Reset|Delete)$/, ''))).toEqual([
      'Permission',
      'Org adminBuilt-in template',
      'AppSecBuilt-in template',
      'DeveloperBuilt-in template',
      'AuditorBuilt-in template',
    ]);
    const adminBox = within(matrix).getByRole('checkbox', { name: 'Org admin: Settings' });
    expect(adminBox).toBeChecked();
    expect(adminBox).toBeDisabled();
    const box = within(matrix).getByRole('checkbox', { name: 'Developer: Review changes and findings' });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.getByText('1 unsaved')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    const patch = await waitFor(() => {
      const c = calls.find((x) => x.method === 'PATCH');
      expect(c).toBeDefined();
      return c!;
    });
    expect(patch.path).toBe('/api/roles/developer');
    expect((patch.body as { permissions: string[] }).permissions).toContain('review');
    // Success is a toast.
    expect(await screen.findByText(/Saved 1 role/)).toBeInTheDocument();
    const recent = screen.getByRole('table', { name: 'Recent role changes' });
    expect(await within(recent).findByText('Updated role Developer: +review')).toBeInTheDocument();
  });

  it('keeps unsaved edits when saving roles partly fails and says which roles saved', async () => {
    // The server keeps what was saved, so the reload reflects the AppSec save only.
    let saved = rolesBody();
    const { calls } = settingsApi({
      'GET /api/roles': () => saved,
      'PATCH /api/roles/appsec': (c) => {
        const body = c.body as { permissions: Permission[] };
        saved = { ...saved, items: saved.items.map((r) => (r.id === 'appsec' ? { ...r, permissions: body.permissions } : r)) };
        return saved.items.find((r) => r.id === 'appsec');
      },
      'PATCH /api/roles/developer': () => new Reply(500, { error: { code: 'internal', message: 'Database is busy' } }),
    });
    renderPage(<Settings />, { path: '/settings', at: rolesAt, me: meFor('org_admin') });
    const matrix = await screen.findByRole('table', { name: 'Permissions by role' });
    const appsec = within(matrix).getByRole('checkbox', { name: 'AppSec: Settings' });
    const dev = within(matrix).getByRole('checkbox', { name: 'Developer: Review changes and findings' });
    const auditor = within(matrix).getByRole('checkbox', { name: 'Auditor: Review changes and findings' });
    expect(appsec).not.toBeChecked();
    expect(dev).not.toBeChecked();
    expect(auditor).not.toBeChecked();
    await userEvent.click(appsec);
    await userEvent.click(dev);
    await userEvent.click(auditor);
    expect(screen.getByText('3 unsaved')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Saved AppSec.');
    expect(alert).toHaveTextContent('Not saved: Developer, Auditor');
    expect(alert).toHaveTextContent('Database is busy');
    expect(await screen.findByText(/Saved AppSec\. The change is in the audit log/)).toBeInTheDocument();
    // Saving stops at the failure: Auditor was never sent.
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.path)).toEqual(['/api/roles/appsec', '/api/roles/developer']);
    // After the roles reload, the failed and remaining drafts are still there; the saved one is applied.
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/roles')).toHaveLength(2));
    await waitFor(() => expect(screen.getByText('2 unsaved')).toBeInTheDocument());
    expect(within(matrix).getByRole('checkbox', { name: 'AppSec: Settings' })).toBeChecked();
    expect(within(matrix).getByRole('checkbox', { name: 'Developer: Review changes and findings' })).toBeChecked();
    expect(within(matrix).getByRole('checkbox', { name: 'Auditor: Review changes and findings' })).toBeChecked();
  });

  it('creates a role from a template', async () => {
    const { calls } = settingsApi();
    renderPage(<Settings />, { path: '/settings', at: rolesAt, me: meFor('org_admin') });
    const form = await screen.findByRole('form', { name: 'New role from template' });
    await userEvent.type(within(form).getByLabelText('New role'), 'Leadership');
    await choose('from template', 'Auditor', within(form));
    await userEvent.click(within(form).getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/roles')?.body).toEqual({ name: 'Leadership', template: 'auditor' }));
  });

  it('confirms a role reset in an alert dialog', async () => {
    const { calls } = settingsApi({ 'POST /api/roles/developer/reset': () => ({ ok: true }) });
    renderPage(<Settings />, { path: '/settings', at: rolesAt, me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('button', { name: 'Reset Developer to template' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset Developer to its template?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.path === '/api/roles/developer/reset')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Reset Developer to template' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset role' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/roles/developer/reset')).toBe(true));
  });

  it('assigns roles to members only and removes bindings after confirming', async () => {
    const { calls } = settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings?tab=bindings', me: meFor('org_admin') });
    const form = await screen.findByRole('form', { name: 'Assign role' });
    await userEvent.click(within(form).getByRole('combobox', { name: 'Person' }));
    // Only members of the org are offered.
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Ada Admin · admin@local', 'Dee Dev · dev@local']);
    await userEvent.click(screen.getByRole('option', { name: /Dee Dev/ }));
    await choose('Role', 'AppSec', within(form));
    await choose('Scope', 'Project · payments-platform', within(form));
    await userEvent.click(within(form).getByRole('button', { name: 'Assign role' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/bindings')?.body).toEqual({
        roleId: 'appsec',
        subject: { kind: 'user', userId: 'u_dev' },
        scope: { kind: 'project', projectId: 'p1' },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove Developer from dev@local' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Developer from dev@local?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove role' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/bindings/b2')).toBe(true));
  });

  it('shows a copyable accept-invite link for a pending invite', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    settingsApi({
      'POST /api/members': (c) => {
        const b = c.body as { email: string; name: string };
        return new Reply(201, { invite: { token: 'tok_abc-123', expiresAt: '2026-10-13T00:00:00.000Z', email: b.email, name: b.name } });
      },
    });
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite member' });
    await userEvent.type(within(dialog).getByLabelText('Email'), 'new@acme.test');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Nia New');
    await choose('Role', 'Developer', within(dialog));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    const done = await screen.findByRole('dialog', { name: 'Invite created' });
    const link = `${window.location.origin}/accept-invite#token=tok_abc-123`;
    expect(within(done).getByLabelText('Invite link')).toHaveValue(link);
    expect(within(done).getByText(/Nia New \(new@acme.test\)/)).toBeInTheDocument();
    await userEvent.click(within(done).getByRole('button', { name: 'Copy invite link' }));
    expect(writeText).toHaveBeenCalledWith(link);
  });

  it('invites a member and shows the one-time password once with a copy button', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { calls } = settingsApi({
      'POST /api/members': (c) => {
        const b = c.body as { email: string; name: string };
        return new Reply(201, { member: { id: 'u_new', email: b.email, name: b.name, bindings: [] }, oneTimePassword: 'correct-horse-battery' });
      },
    });
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite member' });
    expect(within(dialog).getByRole('button', { name: 'Send invite' })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Email'), 'new@acme.test');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Nia New');
    await choose('Role', 'Developer', within(dialog));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/members')?.body).toEqual({
        email: 'new@acme.test',
        name: 'Nia New',
        bindings: [{ roleId: 'developer', scope: { kind: 'org' } }],
      }),
    );
    const done = await screen.findByRole('dialog', { name: 'Member invited' });
    expect(within(done).getByLabelText('One-time password')).toHaveValue('correct-horse-battery');
    expect(within(done).getByText(/shown only once/)).toBeInTheDocument();
    await userEvent.click(within(done).getByRole('button', { name: 'Copy one-time password' }));
    expect(writeText).toHaveBeenCalledWith('correct-horse-battery');
    await userEvent.click(within(done).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Re-opening starts a fresh form: the secret is not kept.
    await userEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    expect(screen.queryByDisplayValue('correct-horse-battery')).toBeNull();
  });

  it('shows the invite token outside dev mode and the server error on conflict', async () => {
    let n = 0;
    settingsApi({
      'POST /api/members': () =>
        n++ === 0
          ? new Reply(409, { error: { code: 'conflict', message: 'Already a member of this organization' } })
          : new Reply(201, { invite: { token: 'tok_abc', expiresAt: '2026-10-13T00:00:00Z', email: 'x@acme.test', name: 'X' } }),
    });
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite member' });
    await userEvent.type(within(dialog).getByLabelText('Email'), 'x@acme.test');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'X');
    await choose('Role', 'Auditor', within(dialog));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Already a member of this organization');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    const done = await screen.findByRole('dialog', { name: 'Invite created' });
    expect(within(done).getByLabelText('Invite link')).toHaveValue(`${window.location.origin}/accept-invite#token=tok_abc`);
    expect(done).toHaveTextContent('2026-10-13 00:00 UTC');
  });

  it('is read-only without manage_members', async () => {
    settingsApi();
    const me = meFor('developer', { permissions: [...ROLE_TEMPLATES.developer.permissions, 'settings'] });
    const { unmount } = renderPage(<Settings />, { path: '/settings', at: rolesAt, me });
    const matrix = await screen.findByRole('table', { name: 'Permissions by role' });
    for (const box of within(matrix).getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save roles' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New role from template' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reset / })).toBeNull();
    expect(screen.getByText(/Read-only: editing roles needs/)).toBeInTheDocument();
    unmount();
    renderPage(<Settings />, { path: '/settings', at: '/settings?tab=bindings', me });
    expect(await screen.findByRole('table', { name: 'Role bindings' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Assign role' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });

  it('hides "Invite member" without manage_members', async () => {
    settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('developer', { permissions: [...ROLE_TEMPLATES.developer.permissions, 'settings'] }) });
    expect(await screen.findByRole('table', { name: 'Members' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
  });

  it('shows the server error when a save is refused', async () => {
    settingsApi({ 'PATCH /api/roles/developer': () => new Reply(403, { error: { code: 'forbidden', message: 'Missing permission: manage_members' } }) });
    renderPage(<Settings />, { path: '/settings', at: rolesAt, me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Developer: Accept risk' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Missing permission: manage_members');
  });

  it('lists members with their role bindings and shows the audit log tab', async () => {
    settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    const table = await screen.findByRole('table', { name: 'Members' });
    await waitFor(() => expect(within(table).getByText('Dee Dev').closest('tr')).toHaveTextContent('Developer· payments-platform'));
    await userEvent.click(screen.getByRole('tab', { name: 'Audit log' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings?tab=audit');
    const log = await screen.findByRole('table', { name: 'Audit log' });
    expect(within(log).getByText('project.create')).toBeInTheDocument();
    expect(within(log).getByText('admin@local')).toBeInTheDocument();
  });

  it('edits the project tier with manage_projects', async () => {
    const { calls } = settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings?tab=project', me: meFor('org_admin') });
    const group = await screen.findByRole('radiogroup', { name: 'Size tier' });
    expect(within(group).getByRole('radio', { name: /Standard/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('table', { name: 'Standard tier settings' })).toHaveTextContent('80 nodes(override)');
    await userEvent.click(within(group).getByRole('radio', { name: /Large/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/api/projects/p1')?.body).toEqual({ tier: 'Large' }));
  });

  it('shows an error state when roles cannot be loaded', async () => {
    settingsApi({ 'GET /api/roles': () => new Reply(500, { error: { code: 'internal', message: 'Internal error' } }) });
    renderPage(<Settings />, { path: '/settings', at: rolesAt, me: meFor('org_admin') });
    expect(await screen.findByText('Internal error')).toBeInTheDocument();
  });
});
