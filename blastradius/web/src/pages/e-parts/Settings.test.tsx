import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AuditEntry, ListRolesResponse, Permission, Role } from '@server/api-types';
import { ACTION_PERMISSIONS, PAGE_PERMISSIONS, PERMISSION_LABELS, ROLE_TEMPLATES, defaultRoles } from '@server/permissions';
import Settings from '../Settings';
import { meFor } from '@/test/fixtures';
import { changes, describeAudit, draftFrom, toggle } from './rbac';
import { Reply, fakeApi, renderPage, type Call } from './testkit';

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
      ['auditor', false, 0],
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

describe('<Settings>', () => {
  it('lets an admin edit the permission matrix, saves through the API and shows the audit entry', async () => {
    const { calls } = settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    const matrix = await screen.findByRole('table', { name: 'Permissions by role' });
    expect(within(matrix).getAllByRole('columnheader').map((h) => h.textContent?.replace(/Reset$/, ''))).toEqual([
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
    expect(await screen.findByText(/Saved 1 role/)).toBeInTheDocument();
    const recent = screen.getByRole('table', { name: 'Recent role changes' });
    expect(await within(recent).findByText('Updated role Developer: +review')).toBeInTheDocument();
  });

  it('creates a role from a template', async () => {
    const { calls } = settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    const form = await screen.findByRole('form', { name: 'New role from template' });
    await userEvent.type(within(form).getByLabelText('New role'), 'Leadership');
    await userEvent.selectOptions(within(form).getByLabelText('from template'), 'auditor');
    await userEvent.click(within(form).getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/roles')?.body).toEqual({ name: 'Leadership', template: 'auditor' }));
  });

  it('assigns and removes role bindings', async () => {
    const { calls } = settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    const form = await screen.findByRole('form', { name: 'Assign role' });
    await waitFor(() => expect(within(form).getAllByRole('option', { name: /Dee Dev/ })).toHaveLength(1));
    await userEvent.selectOptions(within(form).getByLabelText('Person'), 'u_dev');
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'appsec');
    await userEvent.selectOptions(within(form).getByLabelText('Scope'), 'p1');
    await userEvent.click(within(form).getByRole('button', { name: 'Assign role' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/bindings')?.body).toEqual({
        roleId: 'appsec',
        subject: { kind: 'user', userId: 'u_dev' },
        scope: { kind: 'project', projectId: 'p1' },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove Developer from dev@local' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/bindings/b2')).toBe(true));
  });

  it('is read-only without manage_members', async () => {
    settingsApi();
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('developer', { permissions: [...ROLE_TEMPLATES.developer.permissions, 'settings'] }) });
    const matrix = await screen.findByRole('table', { name: 'Permissions by role' });
    for (const box of within(matrix).getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save roles' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New role from template' })).toBeNull();
    expect(await screen.findByRole('table', { name: 'Role bindings' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Assign role' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.getByText(/Read-only: editing roles needs/)).toBeInTheDocument();
  });

  it('shows the server error when a save is refused', async () => {
    settingsApi({ 'PATCH /api/roles/developer': () => new Reply(403, { error: { code: 'forbidden', message: 'Missing permission: manage_members' } }) });
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Developer: Accept risk' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(await screen.findByText('Missing permission: manage_members')).toBeInTheDocument();
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
    renderPage(<Settings />, { path: '/settings', at: '/settings', me: meFor('org_admin') });
    expect(await screen.findByText('Internal error')).toBeInTheDocument();
  });
});
