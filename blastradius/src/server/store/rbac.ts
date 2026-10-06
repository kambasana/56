/**
 * Roles, role bindings and members. Every mutation writes an audit entry.
 * Evaluation stays in ../permissions.ts; this module only loads the data it needs.
 */
import type { CreateBindingRequest, CreateRoleRequest, ListBindingsResponse, ListMembersResponse, Role, RoleBinding, UpdateRoleRequest, User } from '../api-types.js';
import {
  ALL_PERMISSIONS,
  BUILTIN_ROLE_IDS,
  ORG_ADMIN_ROLE_ID,
  ROLE_TEMPLATES,
  defaultRoles,
  effectivePermissions,
  isBuiltinRoleId,
  normalizePermissions,
  rolesInScope,
  storedPermissionsFor,
  type BindingScope,
  type BindingSubject,
  type Permission,
} from '../permissions.js';
import { writeAudit } from './audit.js';
import { getUser, getUsers } from './auth.js';
import { all, get, isConstraintError, newId, nowIso, parseJson, run, StoreError, tx, type Store } from './db.js';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

interface RoleRow {
  org_id: string;
  id: string;
  name: string;
  description: string;
  builtin: number;
  template: string | null;
  permissions: string;
  updated_at: string;
}

function toRole(r: RoleRow): Role {
  const { permissions } = normalizePermissions(parseJson<unknown>(r.permissions, []));
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description,
    builtIn: r.builtin === 1,
    template: r.template,
    permissions: storedPermissionsFor(r.id, permissions),
    updatedAt: r.updated_at,
  };
}

const BUILTIN_ORDER = `CASE id ${BUILTIN_ROLE_IDS.map((id, i) => `WHEN '${id}' THEN ${i}`).join(' ')} ELSE 99 END`;

/** Insert the built-in roles for an org (idempotent). */
export function seedOrgRoles(s: Store, orgId: string): void {
  const at = nowIso(s);
  for (const r of defaultRoles()) {
    run(
      s,
      `INSERT OR IGNORE INTO role (org_id, id, name, description, builtin, template, permissions, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      orgId,
      r.id,
      r.name,
      r.description,
      r.id,
      JSON.stringify(storedPermissionsFor(r.id, r.permissions)),
      at,
    );
  }
}

export function listRoles(s: Store, orgId: string): Role[] {
  return all<RoleRow>(s, `SELECT * FROM role WHERE org_id = ? ORDER BY ${BUILTIN_ORDER}, name COLLATE NOCASE`, orgId).map(toRole);
}

export function getRole(s: Store, orgId: string, roleId: string): Role | null {
  const r = get<RoleRow>(s, 'SELECT * FROM role WHERE org_id = ? AND id = ?', orgId, roleId);
  return r ? toRole(r) : null;
}

function cleanName(name: string | undefined, field = 'name'): string {
  const n = (name ?? '').trim();
  if (!n || n.length > 80) throw new StoreError('bad_request', 'Name must be 1–80 characters', [field]);
  return n;
}

function cleanDescription(d: string | undefined): string {
  const t = (d ?? '').trim();
  if (t.length > 500) throw new StoreError('bad_request', 'Description is too long', ['description']);
  return t;
}

function checkedPermissions(input: unknown): Permission[] {
  const { permissions, invalid } = normalizePermissions(input);
  if (invalid.length > 0) throw new StoreError('bad_request', `Unknown permission: ${invalid.join(', ')}`, ['permissions']);
  return permissions;
}

export function createRole(s: Store, orgId: string, input: CreateRoleRequest, actor: string): Role {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  let template: string | null = null;
  let permissions: Permission[] = [];
  if (input.template !== undefined) {
    if (!isBuiltinRoleId(input.template)) throw new StoreError('bad_request', 'Unknown template', ['template']);
    template = input.template;
    permissions = [...ROLE_TEMPLATES[input.template].permissions];
  }
  if (input.permissions !== undefined) permissions = checkedPermissions(input.permissions);
  const id = newId('role');
  return tx(s, () => {
    try {
      run(
        s,
        `INSERT INTO role (org_id, id, name, description, builtin, template, permissions, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
        orgId,
        id,
        name,
        description,
        template,
        JSON.stringify(storedPermissionsFor(id, permissions)),
        nowIso(s),
      );
    } catch (e) {
      if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'A role with this name already exists', ['name']);
      throw e;
    }
    const role = getRole(s, orgId, id)!;
    writeAudit(s, { orgId, actor, action: 'role.create', target: id, detail: { after: role } });
    return role;
  });
}

export function updateRole(s: Store, orgId: string, roleId: string, patch: UpdateRoleRequest, actor: string): Role {
  return tx(s, () => {
    const before = getRole(s, orgId, roleId);
    if (!before) throw new StoreError('not_found', 'Role not found');
    const name = patch.name !== undefined ? cleanName(patch.name) : before.name;
    const description = patch.description !== undefined ? cleanDescription(patch.description) : before.description;
    const permissions = patch.permissions !== undefined ? storedPermissionsFor(roleId, checkedPermissions(patch.permissions)) : before.permissions;
    try {
      run(
        s,
        'UPDATE role SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE org_id = ? AND id = ?',
        name,
        description,
        JSON.stringify(permissions),
        nowIso(s),
        orgId,
        roleId,
      );
    } catch (e) {
      if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'A role with this name already exists', ['name']);
      throw e;
    }
    const after = getRole(s, orgId, roleId)!;
    writeAudit(s, { orgId, actor, action: 'role.update', target: roleId, detail: { before, after } });
    return after;
  });
}

/** Built-in roles only: restore the template's name, description and permissions. */
export function resetRole(s: Store, orgId: string, roleId: string, actor: string): Role {
  return tx(s, () => {
    const before = getRole(s, orgId, roleId);
    if (!before) throw new StoreError('not_found', 'Role not found');
    if (!before.builtIn || !isBuiltinRoleId(roleId)) throw new StoreError('bad_request', 'Only built-in roles can be reset');
    const t = ROLE_TEMPLATES[roleId];
    run(
      s,
      'UPDATE role SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE org_id = ? AND id = ?',
      t.name,
      t.description,
      JSON.stringify(storedPermissionsFor(roleId, t.permissions)),
      nowIso(s),
      orgId,
      roleId,
    );
    const after = getRole(s, orgId, roleId)!;
    writeAudit(s, { orgId, actor, action: 'role.reset', target: roleId, detail: { before, after } });
    return after;
  });
}

/** 409 for built-in roles and for roles that still have bindings. */
export function deleteRole(s: Store, orgId: string, roleId: string, actor: string): void {
  tx(s, () => {
    const before = getRole(s, orgId, roleId);
    if (!before) throw new StoreError('not_found', 'Role not found');
    if (before.builtIn) throw new StoreError('conflict', 'Built-in roles cannot be deleted');
    const n = get<{ n: number }>(s, 'SELECT count(*) AS n FROM role_binding WHERE org_id = ? AND role_id = ?', orgId, roleId)?.n ?? 0;
    if (n > 0) throw new StoreError('conflict', 'Role is still bound; remove its bindings first');
    run(s, 'DELETE FROM role WHERE org_id = ? AND id = ?', orgId, roleId);
    writeAudit(s, { orgId, actor, action: 'role.delete', target: roleId, detail: { before } });
  });
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

interface BindingRow {
  id: string;
  org_id: string;
  role_id: string;
  subject_kind: 'user' | 'group';
  subject_ref: string;
  scope_kind: 'org' | 'project';
  project_id: string | null;
  created_at: string;
  created_by: string;
}

function toBinding(r: BindingRow): RoleBinding {
  const subject: BindingSubject = r.subject_kind === 'user' ? { kind: 'user', userId: r.subject_ref } : { kind: 'group', group: r.subject_ref };
  const scope: BindingScope = r.scope_kind === 'org' ? { kind: 'org' } : { kind: 'project', projectId: r.project_id! };
  return { id: r.id, orgId: r.org_id, roleId: r.role_id, subject, scope, createdAt: r.created_at, createdBy: r.created_by };
}

export function getBinding(s: Store, orgId: string, id: string): RoleBinding | null {
  const r = get<BindingRow>(s, 'SELECT * FROM role_binding WHERE org_id = ? AND id = ?', orgId, id);
  return r ? toBinding(r) : null;
}

/** All bindings in an org (optionally only org-scope plus one project's). */
export function listBindingRecords(s: Store, orgId: string, opts: { projectId?: string } = {}): RoleBinding[] {
  const rows =
    opts.projectId !== undefined
      ? all<BindingRow>(
          s,
          `SELECT * FROM role_binding WHERE org_id = ? AND (scope_kind = 'org' OR project_id = ?) ORDER BY created_at, rowid`,
          orgId,
          opts.projectId,
        )
      : all<BindingRow>(s, 'SELECT * FROM role_binding WHERE org_id = ? ORDER BY created_at, rowid', orgId);
  return rows.map(toBinding);
}

/**
 * GET /api/bindings. With `projectId`: the org-scope bindings plus that project's bindings
 * (everything that applies inside the project). Without: every binding in the org.
 */
export function listBindings(s: Store, orgId: string, opts: { projectId?: string } = {}): ListBindingsResponse {
  const bindings = listBindingRecords(s, orgId, opts);
  const roles = new Map(listRoles(s, orgId).map((r) => [r.id, r] as const));
  const users = getUsers(
    s,
    bindings.flatMap((b) => (b.subject.kind === 'user' ? [b.subject.userId] : [])),
  );
  const projectNames = new Map(
    all<{ id: string; name: string }>(s, 'SELECT id, name FROM project WHERE org_id = ?', orgId).map((p) => [p.id, p.name] as const),
  );
  return {
    items: bindings.map((b) => ({
      ...b,
      subjectLabel: b.subject.kind === 'user' ? (users.get(b.subject.userId)?.email ?? b.subject.userId) : `group:${b.subject.group}`,
      roleName: roles.get(b.roleId)?.name ?? b.roleId,
      scopeLabel: b.scope.kind === 'org' ? 'Organisation' : (projectNames.get(b.scope.projectId) ?? b.scope.projectId),
    })),
  };
}

export function createBinding(s: Store, orgId: string, input: CreateBindingRequest, actor: string): RoleBinding {
  return tx(s, () => {
    if (!getRole(s, orgId, input.roleId)) throw new StoreError('bad_request', 'Unknown role', ['roleId']);
    let subjectRef: string;
    if (input.subject.kind === 'user') {
      if (!getUser(s, input.subject.userId)) throw new StoreError('bad_request', 'Unknown user', ['subject.userId']);
      subjectRef = input.subject.userId;
    } else {
      const g = input.subject.group.trim();
      if (!g || g.length > 200) throw new StoreError('bad_request', 'Invalid group', ['subject.group']);
      subjectRef = g;
    }
    let projectId: string | null = null;
    if (input.scope.kind === 'project') {
      const p = get<{ id: string }>(s, 'SELECT id FROM project WHERE org_id = ? AND id = ?', orgId, input.scope.projectId);
      if (!p) throw new StoreError('bad_request', 'Unknown project', ['scope.projectId']);
      projectId = p.id;
    }
    const id = newId('bnd');
    try {
      run(
        s,
        `INSERT INTO role_binding (id, org_id, role_id, subject_kind, subject_ref, scope_kind, project_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        orgId,
        input.roleId,
        input.subject.kind,
        subjectRef,
        input.scope.kind,
        projectId,
        nowIso(s),
        actor,
      );
    } catch (e) {
      if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'This binding already exists');
      throw e;
    }
    const b = getBinding(s, orgId, id)!;
    writeAudit(s, { orgId, actor, action: 'binding.create', target: id, detail: { after: b } });
    return b;
  });
}

function orgAdminUserBindingCount(s: Store, orgId: string): number {
  return (
    get<{ n: number }>(
      s,
      `SELECT count(*) AS n FROM role_binding WHERE org_id = ? AND role_id = ? AND scope_kind = 'org' AND subject_kind = 'user'`,
      orgId,
      ORG_ADMIN_ROLE_ID,
    )?.n ?? 0
  );
}

/** 409 when it would remove the org's last org-scope Org admin user binding. */
export function deleteBinding(s: Store, orgId: string, id: string, actor: string): void {
  tx(s, () => {
    const b = getBinding(s, orgId, id);
    if (!b) throw new StoreError('not_found', 'Binding not found');
    if (b.roleId === ORG_ADMIN_ROLE_ID && b.scope.kind === 'org' && b.subject.kind === 'user' && orgAdminUserBindingCount(s, orgId) <= 1) {
      throw new StoreError('conflict', 'Cannot remove the last Org admin');
    }
    run(s, 'DELETE FROM role_binding WHERE org_id = ? AND id = ?', orgId, id);
    writeAudit(s, { orgId, actor, action: 'binding.delete', target: id, detail: { before: b } });
  });
}

// ---------------------------------------------------------------------------
// Access for one user
// ---------------------------------------------------------------------------

/** Bindings that name this user (or one of their groups) in an org. */
export function bindingsForUser(s: Store, orgId: string, userId: string, groups: readonly string[] = []): RoleBinding[] {
  return listBindingRecords(s, orgId).filter(
    (b) => (b.subject.kind === 'user' && b.subject.userId === userId) || (b.subject.kind === 'group' && groups.includes(b.subject.group)),
  );
}

/** Roles that apply to the user at org scope, or inside one project (org ∪ project bindings). */
export function rolesForUser(s: Store, orgId: string, userId: string, projectId?: string, groups: readonly string[] = []): Role[] {
  return rolesInScope(bindingsForUser(s, orgId, userId, groups), listRoles(s, orgId), { userId, groups }, projectId);
}

export interface UserAccess {
  /** Org-scope roles. */
  roles: Role[];
  /** Effective org-scope permissions, catalogue order. */
  permissions: Permission[];
  /** For each project with a project-scope binding: effective (org ∪ project) permissions. */
  projectPermissions: Record<string, Permission[]>;
  /** True when the user has any binding in the org. */
  member: boolean;
}

/** Everything /api/me needs about one user's access in one org. */
export function userAccess(s: Store, orgId: string, userId: string, groups: readonly string[] = []): UserAccess {
  const bindings = bindingsForUser(s, orgId, userId, groups);
  const roles = listRoles(s, orgId);
  const who = { userId, groups };
  const orgRoles = rolesInScope(bindings, roles, who);
  const orgEff = effectivePermissions(orgRoles);
  const projectPermissions: Record<string, Permission[]> = {};
  for (const b of bindings) {
    if (b.scope.kind !== 'project' || projectPermissions[b.scope.projectId]) continue;
    const eff = effectivePermissions(rolesInScope(bindings, roles, who, b.scope.projectId));
    projectPermissions[b.scope.projectId] = ALL_PERMISSIONS.filter((p) => eff.has(p));
  }
  return { roles: orgRoles, permissions: ALL_PERMISSIONS.filter((p) => orgEff.has(p)), projectPermissions, member: bindings.length > 0 };
}

/**
 * Project ids in the org where the user holds `permission` (org-scope grant = every project).
 * Returns null for "every project" so callers can skip filtering.
 */
export function projectsWithPermission(s: Store, orgId: string, userId: string, permission: Permission, groups: readonly string[] = []): string[] | null {
  const access = userAccess(s, orgId, userId, groups);
  if (access.permissions.includes(permission)) return null;
  return Object.entries(access.projectPermissions)
    .filter(([, perms]) => perms.includes(permission))
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** True when the user has any user binding in the org (org or project scope). */
export function isOrgMember(s: Store, orgId: string, userId: string): boolean {
  return get<{ x: number }>(s, `SELECT 1 AS x FROM role_binding WHERE org_id = ? AND subject_kind = 'user' AND subject_ref = ? LIMIT 1`, orgId, userId) !== undefined;
}

/** Users with at least one user binding in the org, with those bindings. */
export function listMembers(s: Store, orgId: string): ListMembersResponse {
  const bindings = listBindingRecords(s, orgId);
  const byUser = new Map<string, RoleBinding[]>();
  for (const b of bindings) {
    if (b.subject.kind !== 'user') continue;
    const list = byUser.get(b.subject.userId) ?? [];
    list.push(b);
    byUser.set(b.subject.userId, list);
  }
  const users = getUsers(s, [...byUser.keys()]);
  const items: (User & { bindings: RoleBinding[] })[] = [];
  for (const [id, list] of byUser) {
    const u = users.get(id);
    if (u) items.push({ ...u, bindings: list });
  }
  items.sort((a, b) => a.email.localeCompare(b.email));
  return { items };
}
