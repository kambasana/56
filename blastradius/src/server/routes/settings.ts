/**
 * /api/roles, /api/bindings, /api/members, /api/audit.
 * Org-scope permissions only: a project-scope grant never lets anyone edit org-wide roles or
 * bindings (that would be an escalation path).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type {
  CreateBindingResponse,
  CreateRoleResponse,
  InviteMemberResponse,
  ListAuditResponse,
  ListBindingsResponse,
  ListMembersResponse,
  ListRolesResponse,
  OkResponse,
  ResetRoleResponse,
  UpdateRoleResponse,
} from '../api-types.js';
import { ACTION_PERMISSIONS, ORG_ADMIN_ROLE_ID, PAGE_PERMISSIONS, PERMISSION_LABELS, ROLE_TEMPLATES, isBuiltinRoleId, normalizePermissions, permissionsGrantedByBinding, type BindingScope, type Permission } from '../permissions.js';
import { deps, requireOrgPerm, type AppEnv } from '../context.js';
import type { Role } from '../api-types.js';
import type { UserAccess } from '../store/index.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { idParam, pageQuery, parseBody, queryString } from '../request.js';
import {
  createBinding,
  createRole,
  deleteBinding,
  deleteRole,
  getBinding,
  getProject,
  getRole,
  inviteMember,
  isOrgMember,
  listAudit,
  listBindings,
  listMembers,
  listRoles,
  resetRole,
  updateRole,
} from '../store/index.js';

const Perms = z.array(z.string().max(64)).max(64);

const CreateRoleBody = z.strictObject({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  template: z.string().max(64).optional(),
  permissions: Perms.optional(),
});

const UpdateRoleBody = z.strictObject({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  permissions: Perms.optional(),
});

const Subject = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), userId: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal('group'), group: z.string().min(1).max(200) }),
]);
const Scope = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('org') }), z.strictObject({ kind: z.literal('project'), projectId: z.string().min(1).max(100) })]);

const CreateBindingBody = z.strictObject({ roleId: z.string().min(1).max(100), subject: Subject, scope: Scope });

const InviteMemberBody = z.strictObject({
  email: z.string().min(3).max(254),
  name: z.string().min(1).max(200),
  bindings: z
    .array(z.strictObject({ roleId: z.string().min(1).max(100), scope: Scope }))
    .min(1)
    .max(20),
});

function checkedPermissions(input: string[] | undefined): Permission[] | undefined {
  if (input === undefined) return undefined;
  const { permissions, invalid } = normalizePermissions(input);
  if (invalid.length > 0) throw badRequest(`Unknown permission: ${invalid.join(', ')}`, ['permissions']);
  return permissions;
}

/**
 * "Grant only what you hold": manage_members lets a user hand out roles and permissions they
 * themselves have, never more. Only an Org admin can grant, edit or remove Org admin.
 */
function isOrgAdmin(a: UserAccess): boolean {
  return a.roles.some((r) => r.id === ORG_ADMIN_ROLE_ID);
}

/**
 * `scope` is where the grant takes effect. At project scope the granter's holdings there count
 * (org-scope permissions plus their own bindings in that project); at org scope (and for role
 * edits, which apply everywhere) only org-scope permissions count.
 */
function assertCanGrant(a: UserAccess, roleId: string | null, permissions: readonly Permission[], scope: BindingScope = { kind: 'org' }): void {
  if (isOrgAdmin(a)) return;
  if (roleId === ORG_ADMIN_ROLE_ID) throw forbidden('Only an Org admin can grant or change Org admin');
  const held = new Set<Permission>(a.permissions);
  if (scope.kind === 'project') for (const p of a.projectPermissions[scope.projectId] ?? []) held.add(p);
  const missing = permissions.filter((p) => !held.has(p));
  if (missing.length > 0) throw forbidden(`You cannot grant permissions you do not hold: ${missing.join(', ')}`);
}

/** Check a binding of `role` at `scope`, counting the permissions the scope itself adds. */
function assertCanBind(a: UserAccess, role: Role, scope: BindingScope): void {
  assertCanGrant(a, role.id, permissionsGrantedByBinding(role, scope), scope);
}

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  app.get('/api/roles', (c) => {
    const { orgId } = requireOrgPerm(c, 'settings');
    return c.json<ListRolesResponse>({
      items: listRoles(deps(c).store, orgId),
      catalogue: { pages: [...PAGE_PERMISSIONS], actions: [...ACTION_PERMISSIONS], labels: { ...PERMISSION_LABELS } },
    });
  });

  app.post('/api/roles', async (c) => {
    const { orgId, session, access } = requireOrgPerm(c, 'manage_members');
    const body = await parseBody(c, CreateRoleBody);
    const permissions = checkedPermissions(body.permissions);
    const fromTemplate = body.template !== undefined && isBuiltinRoleId(body.template) ? ROLE_TEMPLATES[body.template].permissions : [];
    assertCanGrant(access, null, permissions ?? fromTemplate);
    const role = createRole(
      deps(c).store,
      orgId,
      {
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.template !== undefined ? { template: body.template } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
      },
      session.user.id,
    );
    return c.json<CreateRoleResponse>(role, 201);
  });

  app.patch('/api/roles/:id', async (c) => {
    const id = idParam(c, 'id');
    const { orgId, session, access } = requireOrgPerm(c, 'manage_members');
    const body = await parseBody(c, UpdateRoleBody);
    const permissions = checkedPermissions(body.permissions);
    const existing = getRole(deps(c).store, orgId, id);
    if (!existing) throw notFound('Role not found');
    assertCanGrant(access, id, permissions ?? []);
    const role = updateRole(
      deps(c).store,
      orgId,
      id,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
      },
      session.user.id,
    );
    return c.json<UpdateRoleResponse>(role);
  });

  app.post('/api/roles/:id/reset', (c) => {
    const id = idParam(c, 'id');
    const { orgId, session, access } = requireOrgPerm(c, 'manage_members');
    if (isBuiltinRoleId(id)) assertCanGrant(access, id, ROLE_TEMPLATES[id].permissions);
    return c.json<ResetRoleResponse>(resetRole(deps(c).store, orgId, id, session.user.id));
  });

  app.delete('/api/roles/:id', (c) => {
    const id = idParam(c, 'id');
    const { orgId, session } = requireOrgPerm(c, 'manage_members');
    deleteRole(deps(c).store, orgId, id, session.user.id);
    return c.json<OkResponse>({ ok: true });
  });

  app.get('/api/bindings', (c) => {
    const { orgId } = requireOrgPerm(c, 'settings');
    const projectId = queryString(c, 'project', 100);
    if (projectId !== undefined && !getProject(deps(c).store, orgId, projectId)) throw notFound('Project not found');
    return c.json<ListBindingsResponse>(listBindings(deps(c).store, orgId, projectId !== undefined ? { projectId } : {}));
  });

  app.post('/api/bindings', async (c) => {
    const { orgId, session, access } = requireOrgPerm(c, 'manage_members');
    const body = await parseBody(c, CreateBindingBody);
    const { store } = deps(c);
    const role = getRole(store, orgId, body.roleId);
    if (role) assertCanBind(access, role, body.scope);
    // Only members of this org can be bound; others come in through POST /api/members. The same
    // answer for unknown users and non-members, so this cannot probe accounts in other orgs.
    if (body.subject.kind === 'user' && !isOrgMember(store, orgId, body.subject.userId)) {
      throw badRequest('Unknown user: invite them to the organisation first', ['subject.userId']);
    }
    return c.json<CreateBindingResponse>(createBinding(store, orgId, body, session.user.id), 201);
  });

  app.delete('/api/bindings/:id', (c) => {
    const id = idParam(c, 'id');
    const { orgId, session, access } = requireOrgPerm(c, 'manage_members');
    const binding = getBinding(deps(c).store, orgId, id);
    if (!binding) throw notFound('Binding not found');
    const role = getRole(deps(c).store, orgId, binding.roleId);
    if (role) assertCanBind(access, role, binding.scope);
    else assertCanGrant(access, binding.roleId, [], binding.scope);
    deleteBinding(deps(c).store, orgId, id, session.user.id);
    return c.json<OkResponse>({ ok: true });
  });

  app.get('/api/members', (c) => {
    const { orgId } = requireOrgPerm(c, 'settings');
    return c.json<ListMembersResponse>(listMembers(deps(c).store, orgId));
  });

  app.post('/api/members', async (c) => {
    const { orgId, session, access } = requireOrgPerm(c, 'manage_members');
    const body = await parseBody(c, InviteMemberBody);
    const { store, config } = deps(c);
    body.bindings.forEach((b, i) => {
      const role = getRole(store, orgId, b.roleId);
      if (!role) throw badRequest('Unknown role', [`bindings.${i}.roleId`]);
      assertCanBind(access, role, b.scope);
    });
    const out = inviteMember(store, orgId, { email: body.email, name: body.name, bindings: body.bindings, devMode: config.devMode }, session.user.id);
    // The one-time password or invite token is in this response only: never log it.
    return c.json<InviteMemberResponse>(
      {
        ...(out.member ? { member: out.member } : {}),
        ...(out.oneTimePassword !== undefined ? { oneTimePassword: out.oneTimePassword } : {}),
        ...(out.invite ? { invite: { token: out.invite.token, expiresAt: out.invite.expiresAt, email: out.invite.email, name: out.invite.name } } : {}),
      },
      201,
    );
  });

  app.get('/api/audit', (c) => {
    const { orgId } = requireOrgPerm(c, 'settings');
    return c.json<ListAuditResponse>(listAudit(deps(c).store, orgId, pageQuery(c)));
  });
}
