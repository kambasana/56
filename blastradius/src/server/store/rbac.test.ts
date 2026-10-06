import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, can, ROLE_TEMPLATES } from '../permissions.js';
import { listAudit } from './audit.js';
import { createUser } from './auth.js';
import { openStore, StoreError } from './db.js';
import { createOrg, getOrg, listOrgsForUser, slugify } from './orgs.js';
import { createProject } from './projects.js';
import {
  createBinding,
  createRole,
  deleteBinding,
  deleteRole,
  getRole,
  listBindings,
  listMembers,
  listRoles,
  projectsWithPermission,
  resetRole,
  rolesForUser,
  updateRole,
  userAccess,
} from './rbac.js';
import { DEV_USERS, devPassword, seedDev } from './seed.js';
import { verifyLogin } from './auth.js';

function setup() {
  const s = openStore();
  const admin = createUser(s, { email: 'admin@x', name: 'Admin' });
  const dev = createUser(s, { email: 'dev@x', name: 'Dev' });
  const org = createOrg(s, { name: 'Acme Corp' }, admin.id);
  return { s, admin, dev, org };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof StoreError ? e.code : 'other';
  }
  return 'ok';
};

describe('orgs', () => {
  it('creates an org with built-in roles and an admin binding for the creator', () => {
    const { s, admin, org } = setup();
    expect(org.slug).toBe('acme-corp');
    expect(getOrg(s, org.id)?.name).toBe('Acme Corp');
    expect(listRoles(s, org.id).map((r) => r.id)).toEqual(['org_admin', 'appsec', 'developer', 'auditor']);
    expect(listOrgsForUser(s, admin.id).map((o) => o.id)).toEqual([org.id]);
    expect(userAccess(s, org.id, admin.id).permissions).toEqual([...ALL_PERMISSIONS]);
    // Derived slugs get a suffix; explicit duplicates conflict.
    expect(createOrg(s, { name: 'Acme Corp' }, null).slug).toBe('acme-corp-2');
    expect(code(() => createOrg(s, { name: 'X', slug: 'acme-corp' }, null))).toBe('conflict');
    expect(code(() => createOrg(s, { name: 'X', slug: 'Bad Slug' }, null))).toBe('bad_request');
    expect(slugify('!')).toMatch(/^org-/);
  });
});

describe('roles', () => {
  it('seeds templates exactly as permissions.ts', () => {
    const { s, org } = setup();
    for (const r of listRoles(s, org.id)) {
      expect(r.builtIn).toBe(true);
      expect(r.permissions).toEqual([...ROLE_TEMPLATES[r.id as keyof typeof ROLE_TEMPLATES].permissions]);
    }
  });

  it('creates, updates, resets and deletes with audit entries', () => {
    const { s, admin, org } = setup();
    const r = createRole(s, org.id, { name: 'Triage', template: 'developer' }, admin.id);
    expect(r.id).toMatch(/^role_/);
    expect(r.template).toBe('developer');
    expect(r.permissions).not.toContain('settings');
    expect(code(() => createRole(s, org.id, { name: 'Triage' }, admin.id))).toBe('conflict');
    expect(code(() => createRole(s, org.id, { name: 'X', permissions: ['fly'] as never }, admin.id))).toBe('bad_request');
    expect(code(() => createRole(s, org.id, { name: 'X', template: 'root' }, admin.id))).toBe('bad_request');

    const u = updateRole(s, org.id, r.id, { permissions: ['review', 'findings', 'review'] }, admin.id);
    expect(u.permissions).toEqual(['findings', 'review']);

    // Org admin cannot be reduced.
    expect(updateRole(s, org.id, 'org_admin', { permissions: ['home'] }, admin.id).permissions).toEqual([...ALL_PERMISSIONS]);

    updateRole(s, org.id, 'appsec', { permissions: ['findings', 'accept_risk'], name: 'Security' }, admin.id);
    const reset = resetRole(s, org.id, 'appsec', admin.id);
    expect(reset.name).toBe('AppSec');
    expect(reset.permissions).toEqual([...ROLE_TEMPLATES.appsec.permissions]);
    expect(code(() => resetRole(s, org.id, r.id, admin.id))).toBe('bad_request');

    expect(code(() => deleteRole(s, org.id, 'auditor', admin.id))).toBe('conflict');
    const b = createBinding(s, org.id, { roleId: r.id, subject: { kind: 'group', group: 'eng' }, scope: { kind: 'org' } }, admin.id);
    expect(code(() => deleteRole(s, org.id, r.id, admin.id))).toBe('conflict');
    deleteBinding(s, org.id, b.id, admin.id);
    deleteRole(s, org.id, r.id, admin.id);
    expect(getRole(s, org.id, r.id)).toBeNull();

    const actions = listAudit(s, org.id, { limit: 100 }).items.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['org.create', 'role.create', 'role.update', 'role.reset', 'binding.create', 'binding.delete', 'role.delete']),
    );
    // Newest first.
    expect(actions[0]).toBe('role.delete');
  });

  it('keeps roles per org (same built-in ids in two orgs)', () => {
    const { s, admin, org } = setup();
    const other = createOrg(s, { name: 'Other' }, admin.id);
    updateRole(s, other.id, 'auditor', { permissions: ['reports', 'findings'] }, admin.id);
    expect(getRole(s, org.id, 'auditor')?.permissions).toEqual(['reports']);
    expect(getRole(s, other.id, 'auditor')?.permissions).toEqual(['reports', 'findings']);
  });
});

describe('bindings and access', () => {
  it('validates, dedupes and protects the last org admin', () => {
    const { s, admin, dev, org } = setup();
    const other = createOrg(s, { name: 'Other' }, null);
    const foreign = createProject(s, other.id, { name: 'p', tier: 'Small', target: '/srv/p' }, admin.id);
    expect(code(() => createBinding(s, org.id, { roleId: 'nope', subject: { kind: 'user', userId: dev.id }, scope: { kind: 'org' } }, admin.id))).toBe(
      'bad_request',
    );
    expect(
      code(() => createBinding(s, org.id, { roleId: 'developer', subject: { kind: 'user', userId: 'usr_missing' }, scope: { kind: 'org' } }, admin.id)),
    ).toBe('bad_request');
    expect(
      code(() =>
        createBinding(s, org.id, { roleId: 'developer', subject: { kind: 'user', userId: dev.id }, scope: { kind: 'project', projectId: foreign.id } }, admin.id),
      ),
    ).toBe('bad_request');
    createBinding(s, org.id, { roleId: 'developer', subject: { kind: 'user', userId: dev.id }, scope: { kind: 'org' } }, admin.id);
    expect(code(() => createBinding(s, org.id, { roleId: 'developer', subject: { kind: 'user', userId: dev.id }, scope: { kind: 'org' } }, admin.id))).toBe(
      'conflict',
    );

    const adminBinding = listBindings(s, org.id).items.find((b) => b.roleId === 'org_admin')!;
    expect(adminBinding.subjectLabel).toBe('admin@x');
    expect(adminBinding.roleName).toBe('Org admin');
    expect(adminBinding.scopeLabel).toBe('Organisation');
    expect(code(() => deleteBinding(s, org.id, adminBinding.id, admin.id))).toBe('conflict');
    const second = createBinding(s, org.id, { roleId: 'org_admin', subject: { kind: 'user', userId: dev.id }, scope: { kind: 'org' } }, admin.id);
    deleteBinding(s, org.id, adminBinding.id, admin.id);
    expect(code(() => deleteBinding(s, org.id, second.id, admin.id))).toBe('conflict');
    // Cross-org lookups are not_found.
    expect(code(() => deleteBinding(s, other.id, second.id, admin.id))).toBe('not_found');
  });

  it('unions org and project bindings', () => {
    const { s, admin, dev, org } = setup();
    const p1 = createProject(s, org.id, { name: 'one', tier: 'Small', target: '/srv/one' }, admin.id);
    const p2 = createProject(s, org.id, { name: 'two', tier: 'Small', target: '/srv/two' }, admin.id);
    createBinding(s, org.id, { roleId: 'auditor', subject: { kind: 'user', userId: dev.id }, scope: { kind: 'org' } }, admin.id);
    const triage = createRole(s, org.id, { name: 'Triage', permissions: ['findings', 'review'] }, admin.id);
    const pb = createBinding(s, org.id, { roleId: triage.id, subject: { kind: 'user', userId: dev.id }, scope: { kind: 'project', projectId: p1.id } }, admin.id);

    const access = userAccess(s, org.id, dev.id);
    expect(access.permissions).toEqual(['reports']);
    expect(access.projectPermissions).toEqual({ [p1.id]: ['reports', 'findings', 'review'] });
    expect(can(rolesForUser(s, org.id, dev.id, p1.id), 'review')).toBe(true);
    expect(can(rolesForUser(s, org.id, dev.id, p2.id), 'review')).toBe(false);
    expect(can(rolesForUser(s, org.id, dev.id), 'findings')).toBe(false);
    expect(projectsWithPermission(s, org.id, dev.id, 'findings')).toEqual([p1.id]);
    expect(projectsWithPermission(s, org.id, dev.id, 'reports')).toBeNull();
    expect(listBindings(s, org.id, { projectId: p2.id }).items.some((b) => b.id === pb.id)).toBe(false);
    expect(listBindings(s, org.id, { projectId: p1.id }).items.find((b) => b.id === pb.id)?.scopeLabel).toBe('one');

    // Group bindings apply when the principal carries the group.
    createBinding(s, org.id, { roleId: 'appsec', subject: { kind: 'group', group: 'sec' }, scope: { kind: 'org' } }, admin.id);
    expect(userAccess(s, org.id, dev.id, ['sec']).permissions).toContain('exposure');

    const members = listMembers(s, org.id).items;
    expect(members.map((m) => m.email)).toEqual(['admin@x', 'dev@x']);
    expect(members[1]!.bindings).toHaveLength(2);
  });
});

describe('dev seed', () => {
  it('refuses outside dev mode', async () => {
    const s = openStore();
    await expect(seedDev(s, { devMode: false })).rejects.toThrow(/dev mode/);
  });

  it('creates acme and four bound users, idempotently', async () => {
    const s = openStore();
    const r = await seedDev(s, { devMode: true, password: 'pw-for-test' });
    expect(r.org.slug).toBe('acme');
    expect(r.users.map((u) => u.email)).toEqual(DEV_USERS.map((u) => u.email));
    expect(r.created).toHaveLength(4);
    for (const u of r.users) expect(rolesForUser(s, r.org.id, u.id).map((x) => x.id)).toEqual([u.role]);
    expect(userAccess(s, r.org.id, r.users[3]!.id).permissions).toEqual(['reports']);
    expect((await verifyLogin(s, 'appsec@local', 'pw-for-test'))?.email).toBe('appsec@local');

    const again = await seedDev(s, { devMode: true, password: 'other' });
    expect(again.org.id).toBe(r.org.id);
    expect(again.created).toEqual([]);
    expect(listBindings(s, r.org.id).items).toHaveLength(4);
    expect(await verifyLogin(s, 'appsec@local', 'pw-for-test')).not.toBeNull();
  });

  it('reads the password from the environment', () => {
    expect(devPassword({})).toBe('blastradius-dev');
    expect(devPassword({ BLASTRADIUS_DEV_PASSWORD: 'x1' })).toBe('x1');
  });
});
