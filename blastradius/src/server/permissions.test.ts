import { describe, expect, it } from 'vitest';
import {
  ACTION_PERMISSIONS,
  ALL_PERMISSIONS,
  PAGE_PERMISSIONS,
  PERMISSION_LABELS,
  ROLE_TEMPLATES,
  WEB_ROUTES,
  allowedPages,
  can,
  canAll,
  canInProject,
  defaultRoles,
  effectivePermissions,
  isPermission,
  normalizePermissions,
  rolesInScope,
  storedPermissionsFor,
  type BindingLike,
  type Permission,
  type RoleLike,
} from './permissions.js';

const roles: RoleLike[] = defaultRoles();
const role = (id: string): RoleLike => roles.find((r) => r.id === id)!;

describe('catalogue', () => {
  it('has the agreed pages and actions, with no overlap and a label each', () => {
    expect([...PAGE_PERMISSIONS]).toEqual(['home', 'projects', 'reports', 'integrations', 'settings', 'changes', 'findings', 'exposure', 'investigate', 'scans']);
    expect([...ACTION_PERMISSIONS]).toEqual([
      'review',
      'send_to_destinations',
      'build_reports',
      'accept_risk',
      'review_entity_links',
      'manage_projects',
      'manage_integrations',
      'manage_members',
    ]);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    for (const p of ALL_PERMISSIONS) expect(PERMISSION_LABELS[p]).toBeTruthy();
  });

  it('isPermission rejects unknown values', () => {
    expect(isPermission('findings')).toBe(true);
    expect(isPermission('manage_members')).toBe(true);
    expect(isPermission('admin')).toBe(false);
    expect(isPermission(undefined)).toBe(false);
    expect(isPermission('__proto__')).toBe(false);
  });
});

describe('default role templates (PLAN §12)', () => {
  it('Org admin has everything', () => {
    for (const p of ALL_PERMISSIONS) expect(can([role('org_admin')], p)).toBe(true);
  });

  it.each(['appsec', 'developer'])('%s sees every page except settings and has no actions', (id) => {
    const r = [role(id)];
    for (const p of PAGE_PERMISSIONS) expect(can(r, p)).toBe(p !== 'settings');
    for (const a of ACTION_PERMISSIONS) expect(can(r, a)).toBe(false);
  });

  it('Auditor sees reports only', () => {
    expect([...effectivePermissions([role('auditor')])]).toEqual(['reports']);
    expect(allowedPages([role('auditor')])).toEqual(['reports']);
  });

  it('defaultRoles returns independent copies', () => {
    const a = defaultRoles();
    a[1]!.permissions.push('manage_members');
    expect(ROLE_TEMPLATES.appsec.permissions).not.toContain('manage_members');
    expect(defaultRoles()[1]!.permissions).not.toContain('manage_members');
  });
});

describe('can / union of roles', () => {
  it('no roles means no permissions', () => {
    expect(can([], 'home')).toBe(false);
    expect(allowedPages([])).toEqual([]);
  });

  it('unions multiple roles', () => {
    const reviewer: RoleLike = { id: 'role_x', permissions: ['review', 'accept_risk'] };
    const r = [role('auditor'), reviewer];
    expect(can(r, 'reports')).toBe(true);
    expect(can(r, 'review')).toBe(true);
    expect(can(r, 'findings')).toBe(false);
    expect(canAll(r, ['reports', 'review'])).toBe(true);
    expect(canAll(r, ['reports', 'findings'])).toBe(false);
  });

  it('org_admin keeps every permission even if its stored list was emptied', () => {
    expect(can([{ id: 'org_admin', permissions: [] }], 'manage_members')).toBe(true);
    expect(effectivePermissions([{ id: 'org_admin', permissions: [] }]).size).toBe(ALL_PERMISSIONS.length);
  });

  it('ignores unknown permission strings', () => {
    const bad = { id: 'role_y', permissions: ['root' as Permission] };
    expect(can([bad], 'root' as Permission)).toBe(false);
    expect(effectivePermissions([bad]).size).toBe(0);
  });
});

describe('normalizePermissions / storedPermissionsFor', () => {
  it('dedupes, orders by catalogue and reports invalid entries', () => {
    const r = normalizePermissions(['review', 'home', 'home', 'nope']);
    expect(r.permissions).toEqual(['home', 'review']);
    expect(r.invalid).toEqual(['nope']);
    expect(normalizePermissions('home').invalid.length).toBe(1);
  });

  it('forces org_admin to everything', () => {
    expect(storedPermissionsFor('org_admin', [])).toEqual([...ALL_PERMISSIONS]);
    expect(storedPermissionsFor('appsec', ['review', 'home'])).toEqual(['home', 'review']);
  });
});

describe('bindings and scope', () => {
  const bindings: BindingLike[] = [
    { roleId: 'developer', subject: { kind: 'user', userId: 'u1' }, scope: { kind: 'org' } },
    { roleId: 'role_rev', subject: { kind: 'user', userId: 'u1' }, scope: { kind: 'project', projectId: 'p1' } },
    { roleId: 'auditor', subject: { kind: 'group', group: 'grc' }, scope: { kind: 'org' } },
    { roleId: 'appsec', subject: { kind: 'user', userId: 'u2' }, scope: { kind: 'project', projectId: 'p2' } },
    { roleId: 'deleted_role', subject: { kind: 'user', userId: 'u1' }, scope: { kind: 'org' } },
  ];
  const all: RoleLike[] = [...roles, { id: 'role_rev', permissions: ['review'] }];

  it('org scope only counts org bindings', () => {
    expect(rolesInScope(bindings, all, { userId: 'u1' }).map((r) => r.id)).toEqual(['developer']);
  });

  it('project scope adds that project only', () => {
    expect(rolesInScope(bindings, all, { userId: 'u1' }, 'p1').map((r) => r.id)).toEqual(['developer', 'role_rev']);
    expect(canInProject(bindings, all, { userId: 'u1' }, 'p1', 'review')).toBe(true);
    expect(canInProject(bindings, all, { userId: 'u1' }, 'p2', 'review')).toBe(false);
  });

  it('project-only users have nothing at org scope', () => {
    expect(rolesInScope(bindings, all, { userId: 'u2' })).toEqual([]);
    expect(canInProject(bindings, all, { userId: 'u2' }, 'p2', 'findings')).toBe(true);
    expect(canInProject(bindings, all, { userId: 'u2' }, 'p1', 'findings')).toBe(false);
  });

  it('group bindings match by group membership', () => {
    expect(rolesInScope(bindings, all, { userId: 'u3', groups: ['grc'] }).map((r) => r.id)).toEqual(['auditor']);
    expect(rolesInScope(bindings, all, { userId: 'u3' })).toEqual([]);
  });
});

describe('web routes', () => {
  it('every route maps to a known page or none', () => {
    for (const r of WEB_ROUTES) expect(r.page === null || (PAGE_PERMISSIONS as readonly string[]).includes(r.page)).toBe(true);
    expect(WEB_ROUTES.find((r) => r.path === '/settings')!.page).toBe('settings');
  });
});
