/**
 * RBAC permission model (PLAN §12), expressed as plain data plus pure functions.
 *
 * A role is a set of page and action permissions. People (or, later, SSO groups) get roles
 * through bindings at org scope or at one project's scope. A user's permissions in a scope are
 * the union of every role bound to them in that scope. Org admin always keeps every permission,
 * whatever its stored permission list says, so an org can never lock itself out.
 *
 * This module has no imports and no side effects, so the web app may import it too
 * (to filter navigation). The server is the only place permissions are enforced.
 */

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** Pages. Holding a page permission means you can see that page and read its data. */
export const PAGE_PERMISSIONS = [
  'home',
  'projects',
  'reports',
  'integrations',
  'settings',
  'changes',
  'findings',
  'exposure',
  'investigate',
  'scans',
] as const;
export type PagePermission = (typeof PAGE_PERMISSIONS)[number];

/** Actions. Each one is a write; reads are governed by page permissions only. */
export const ACTION_PERMISSIONS = [
  'review',
  'send_to_destinations',
  'build_reports',
  'accept_risk',
  'review_entity_links',
  'manage_projects',
  'manage_integrations',
  'manage_members',
] as const;
export type ActionPermission = (typeof ACTION_PERMISSIONS)[number];

/** Page and action names never collide, so one flat string union is enough. */
export type Permission = PagePermission | ActionPermission;

export const ALL_PERMISSIONS: readonly Permission[] = [...PAGE_PERMISSIONS, ...ACTION_PERMISSIONS];

export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  home: 'Home',
  projects: 'Projects',
  reports: 'Reports',
  integrations: 'Integrations',
  settings: 'Settings',
  changes: 'Changes',
  findings: 'Findings',
  exposure: 'Exposure matrix',
  investigate: 'Investigate',
  scans: 'Scans',
  review: 'Review changes and findings',
  send_to_destinations: 'Send to destinations',
  build_reports: 'Build and sign reports',
  accept_risk: 'Accept risk',
  review_entity_links: 'Review entity links',
  manage_projects: 'Manage projects, tiers and scans',
  manage_integrations: 'Manage integrations',
  manage_members: 'Manage members and roles',
};

export function isPagePermission(p: unknown): p is PagePermission {
  return typeof p === 'string' && (PAGE_PERMISSIONS as readonly string[]).includes(p);
}

export function isActionPermission(p: unknown): p is ActionPermission {
  return typeof p === 'string' && (ACTION_PERMISSIONS as readonly string[]).includes(p);
}

export function isPermission(p: unknown): p is Permission {
  return isPagePermission(p) || isActionPermission(p);
}

// ---------------------------------------------------------------------------
// Roles and default templates
// ---------------------------------------------------------------------------

/** Ids of the built-in roles. Custom roles get server-generated ids ("role_<random>"). */
export const BUILTIN_ROLE_IDS = ['org_admin', 'appsec', 'developer', 'auditor'] as const;
export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];
export const ORG_ADMIN_ROLE_ID: BuiltinRoleId = 'org_admin';

/** Minimal shape `can` needs. api-types `Role` satisfies it. */
export interface RoleLike {
  id: string;
  permissions: readonly Permission[];
}

export interface RoleTemplate {
  id: BuiltinRoleId;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

const PAGES_EXCEPT_SETTINGS = PAGE_PERMISSIONS.filter((p) => p !== 'settings');

/**
 * Default templates, exactly as PLAN §12. AppSec and Developer get every page except Settings
 * and no action permissions; customers add actions per role. Auditor gets Reports only.
 */
export const ROLE_TEMPLATES: Readonly<Record<BuiltinRoleId, RoleTemplate>> = {
  org_admin: {
    id: 'org_admin',
    name: 'Org admin',
    description: 'Every page and action. Cannot be reduced.',
    permissions: ALL_PERMISSIONS,
  },
  appsec: {
    id: 'appsec',
    name: 'AppSec',
    description: 'Every page except Settings. Actions are set by the customer.',
    permissions: PAGES_EXCEPT_SETTINGS,
  },
  developer: {
    id: 'developer',
    name: 'Developer',
    description: 'Every page except Settings. Actions are set by the customer.',
    permissions: PAGES_EXCEPT_SETTINGS,
  },
  auditor: {
    id: 'auditor',
    name: 'Auditor',
    description: 'Reports only.',
    permissions: ['reports'],
  },
};

export function isBuiltinRoleId(id: unknown): id is BuiltinRoleId {
  return typeof id === 'string' && (BUILTIN_ROLE_IDS as readonly string[]).includes(id);
}

/** Fresh, mutable copies of the default role permission lists (for seeding a new org). */
export function defaultRoles(): { id: BuiltinRoleId; name: string; description: string; permissions: Permission[] }[] {
  return BUILTIN_ROLE_IDS.map((id) => {
    const t = ROLE_TEMPLATES[id];
    return { id, name: t.name, description: t.description, permissions: [...t.permissions] };
  });
}

/**
 * Validate and canonicalise a permission list from a request: de-duplicated, in catalogue order.
 * Returns the unknown entries separately so the caller can reject the request (400).
 */
export function normalizePermissions(input: unknown): { permissions: Permission[]; invalid: string[] } {
  const invalid: string[] = [];
  const set = new Set<Permission>();
  if (!Array.isArray(input)) return { permissions: [], invalid: ['(not an array)'] };
  for (const p of input) {
    if (isPermission(p)) set.add(p);
    else invalid.push(String(p).slice(0, 64));
  }
  return { permissions: ALL_PERMISSIONS.filter((p) => set.has(p)), invalid };
}

/** The permission list to store for a role: Org admin is always forced to everything. */
export function storedPermissionsFor(roleId: string, requested: readonly Permission[]): Permission[] {
  if (roleId === ORG_ADMIN_ROLE_ID) return [...ALL_PERMISSIONS];
  const set = new Set(requested);
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Union of all permissions granted by `roles`. Org admin grants everything. */
export function effectivePermissions(roles: readonly RoleLike[]): Set<Permission> {
  if (roles.some((r) => r.id === ORG_ADMIN_ROLE_ID)) return new Set(ALL_PERMISSIONS);
  const out = new Set<Permission>();
  for (const r of roles) for (const p of r.permissions) if (isPermission(p)) out.add(p);
  return out;
}

/** True when the union of `userRoles` grants `permission`. Pure; no I/O. */
export function can(userRoles: readonly RoleLike[], permission: Permission): boolean {
  if (!isPermission(permission)) return false;
  for (const r of userRoles) {
    if (r.id === ORG_ADMIN_ROLE_ID) return true;
    if (r.permissions.includes(permission)) return true;
  }
  return false;
}

/** True when every listed permission is granted. */
export function canAll(userRoles: readonly RoleLike[], permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(userRoles, p));
}

/** Pages the user may see, in catalogue order (drives navigation). */
export function allowedPages(userRoles: readonly RoleLike[]): PagePermission[] {
  const eff = effectivePermissions(userRoles);
  return PAGE_PERMISSIONS.filter((p) => eff.has(p));
}

// ---------------------------------------------------------------------------
// Bindings and scope
// ---------------------------------------------------------------------------

export type BindingScope = { kind: 'org' } | { kind: 'project'; projectId: string };
export type BindingSubject = { kind: 'user'; userId: string } | { kind: 'group'; group: string };

/** Minimal binding shape. api-types `RoleBinding` satisfies it. */
export interface BindingLike {
  roleId: string;
  subject: BindingSubject;
  scope: BindingScope;
}

export interface Principal {
  userId: string;
  /** SSO groups (empty until SSO lands). */
  groups?: readonly string[];
}

function subjectMatches(s: BindingSubject, who: Principal): boolean {
  if (s.kind === 'user') return s.userId === who.userId;
  return (who.groups ?? []).includes(s.group);
}

/**
 * Roles that apply to `who`. With no `projectId`, only org-scope bindings count. With a
 * `projectId`, org-scope bindings plus that project's bindings count (union). Bindings whose
 * role id is unknown are ignored.
 */
export function rolesInScope<R extends RoleLike>(
  bindings: readonly BindingLike[],
  roles: readonly R[],
  who: Principal,
  projectId?: string,
): R[] {
  const byId = new Map(roles.map((r) => [r.id, r] as const));
  const out = new Map<string, R>();
  for (const b of bindings) {
    if (!subjectMatches(b.subject, who)) continue;
    const inScope = b.scope.kind === 'org' || (projectId !== undefined && b.scope.projectId === projectId);
    if (!inScope) continue;
    const role = byId.get(b.roleId);
    if (role) out.set(role.id, role);
  }
  return [...out.values()];
}

/**
 * Projects a principal can open at all: every project if an org-scope binding grants `permission`,
 * otherwise only projects whose own bindings (unioned with org ones) grant it.
 */
export function canInProject(
  bindings: readonly BindingLike[],
  roles: readonly RoleLike[],
  who: Principal,
  projectId: string,
  permission: Permission,
): boolean {
  return can(rolesInScope(bindings, roles, who, projectId), permission);
}

// ---------------------------------------------------------------------------
// Web routes -> page permission (shared with the web app's router and nav)
// ---------------------------------------------------------------------------

export interface WebRoute {
  path: string;
  page: PagePermission | null;
  label: string;
}

/** Route map from docs/WEB-API.md. `page: null` means no permission (login). */
export const WEB_ROUTES: readonly WebRoute[] = [
  { path: '/', page: 'home', label: 'Home' },
  { path: '/projects/:id/changes', page: 'changes', label: 'Changes' },
  { path: '/projects/:id/findings', page: 'findings', label: 'Findings' },
  { path: '/projects/:id/findings/:fid', page: 'findings', label: 'Finding' },
  { path: '/projects/:id/exposure', page: 'exposure', label: 'Exposure matrix' },
  { path: '/projects/:id/investigate', page: 'investigate', label: 'Investigate' },
  { path: '/projects/:id/scans', page: 'scans', label: 'Scans' },
  { path: '/reports', page: 'reports', label: 'Reports' },
  { path: '/integrations', page: 'integrations', label: 'Integrations' },
  { path: '/settings', page: 'settings', label: 'Settings' },
  { path: '/login', page: null, label: 'Sign in' },
];
