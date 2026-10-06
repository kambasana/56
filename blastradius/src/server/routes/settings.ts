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
  ListAuditResponse,
  ListBindingsResponse,
  ListMembersResponse,
  ListRolesResponse,
  OkResponse,
  ResetRoleResponse,
  UpdateRoleResponse,
} from '../api-types.js';
import { ACTION_PERMISSIONS, ALL_PERMISSIONS, ORG_ADMIN_ROLE_ID, PAGE_PERMISSIONS, PERMISSION_LABELS, ROLE_TEMPLATES, isBuiltinRoleId, normalizePermissions, type Permission } from '../permissions.js';
import { deps, requireOrgPerm, type AppEnv } from '../context.js';
import type { UserAccess } from '../store/index.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { idParam, pageQuery, parseBody, queryString } from '../request.js';
import { createBinding, createRole, deleteBinding, deleteRole, getBinding, getProject, getRole, listAudit, listBindings, listMembers, listRoles, resetRole, updateRole } from '../store/index.js';

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

function assertCanGrant(a: UserAccess, roleId: string | null, permissions: readonly Permission[]): void {
  if (isOrgAdmin(a)) return;
  if (roleId === ORG_ADMIN_ROLE_ID) throw forbidden('Only an Org admin can grant or change Org admin');
  const missing = permissions.filter((p) => !a.permissions.includes(p));
  if (missing.length > 0) throw forbidden(`You cannot grant permissions you do not hold: ${missing.join(', ')}`);
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
    const role = getRole(deps(c).store, orgId, body.roleId);
    if (role) assertCanGrant(access, role.id, role.id === ORG_ADMIN_ROLE_ID ? ALL_PERMISSIONS : role.permissions);
    return c.json<CreateBindingResponse>(createBinding(deps(c).store, orgId, body, session.user.id), 201);
  });

  app.delete('/api/bindings/:id', (c) => {
    const id = idParam(c, 'id');
    const { orgId, session, access } = requireOrgPerm(c, 'manage_members');
    const binding = getBinding(deps(c).store, orgId, id);
    if (!binding) throw notFound('Binding not found');
    const role = getRole(deps(c).store, orgId, binding.roleId);
    assertCanGrant(access, binding.roleId, role?.permissions ?? []);
    deleteBinding(deps(c).store, orgId, id, session.user.id);
    return c.json<OkResponse>({ ok: true });
  });

  app.get('/api/members', (c) => {
    const { orgId } = requireOrgPerm(c, 'settings');
    return c.json<ListMembersResponse>(listMembers(deps(c).store, orgId));
  });

  app.get('/api/audit', (c) => {
    const { orgId } = requireOrgPerm(c, 'settings');
    return c.json<ListAuditResponse>(listAudit(deps(c).store, orgId, pageQuery(c)));
  });
}
