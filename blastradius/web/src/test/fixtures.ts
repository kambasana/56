import type { MeResponse, Permission } from '@server/api-types';
import { ROLE_TEMPLATES, type BuiltinRoleId } from '@server/permissions';

/** A /api/me body for one of the built-in roles, using the real default templates. */
export function meFor(role: BuiltinRoleId, extra: Partial<MeResponse> = {}): MeResponse {
  const t = ROLE_TEMPLATES[role];
  return {
    user: { id: `u_${role}`, email: `${role}@local`, name: t.name },
    org: { id: 'org_1', name: 'acme-corp' },
    orgs: [{ id: 'org_1', name: 'acme-corp' }],
    roles: [{ id: t.id, name: t.name }],
    permissions: [...t.permissions] as Permission[],
    projectPermissions: {},
    devMode: false,
    ...extra,
  };
}
