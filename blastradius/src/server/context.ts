/**
 * Per-request context: the server dependencies, the signed-in session, and RBAC helpers.
 *
 * Checks always run in this order so cross-org data is never confirmed to exist:
 *   1. signed in (401) → 2. resource exists in the caller's org (404) → 3. permission (403).
 */
import type { AlertWatcher } from './watch.js';
import type { SourceService } from './sources/service.js';
import type { Context } from 'hono';
import type { MeResponse, Permission, User } from './api-types.js';
import { can, type PagePermission } from './permissions.js';
import { forbidden, notFound, unauthenticated, badRequest } from './errors.js';
import type { ScanJobs } from './jobs.js';
import {
  getOrg,
  getProject,
  isDevUser,
  listDevUsers,
  listOrgsForUser,
  rolesForUser,
  userAccess,
  type Store,
  type UserAccess,
} from './store/index.js';
import type { Project } from './api-types.js';
import type { ConcurrencyGate, RateLimiter } from './ratelimit.js';

export interface ServerConfig {
  devMode: boolean;
  /** Allowed roots for local scan targets (realpath-checked). */
  localRoots: string[];
  /** Server-wide offline mode (fixtures only, no network). */
  offline: boolean;
  fixturesDir?: string;
  /** Built SPA directory (web/dist); null disables static serving. */
  webDir: string | null;
  version: string;
  /** Cookie Secure flag: "auto" = when https (or X-Forwarded-Proto: https from a trusted proxy) or the host is not loopback. */
  secureCookies?: 'auto' | 'always' | 'never';
  /**
   * Socket addresses of trusted reverse proxies (default none). Only requests whose peer is in
   * this list have X-Forwarded-For / X-Forwarded-Proto honoured.
   */
  trustProxy?: string[];
}

export interface ServerDeps {
  store: Store;
  jobs: ScanJobs;
  config: ServerConfig;
  log: (m: string) => void;
  /** Sign-in attempts per client address + email (counted before the password is checked). */
  loginLimiter: RateLimiter;
  /** Sign-in attempts per client address (bounds password spraying across emails). */
  loginIpLimiter: RateLimiter;
  /** Concurrent password verifications (scrypt is CPU and memory heavy). */
  loginGate: ConcurrencyGate;
  scanLimiter: RateLimiter;
  /** Alerts from the knowledge pack after scans and on a timer, plus webhook notifications. */
  watcher: AlertWatcher;
  /** Connected code hosts (GitHub App): install, discovery, webhooks, fetch-only scans. */
  sources: SourceService;
}

export interface Session {
  token: string;
  user: User;
  /** Working org (null until the user belongs to one). */
  orgId: string | null;
}

export type AppEnv = {
  Variables: {
    deps: ServerDeps;
    session: Session | null;
    access: Map<string, UserAccess>;
  };
};

export type Ctx = Context<AppEnv>;

export function deps(c: Ctx): ServerDeps {
  return c.get('deps');
}

export function requireSession(c: Ctx): Session {
  const s = c.get('session');
  if (!s) throw unauthenticated();
  return s;
}

/** Working org for this request; 404 when the user has none. */
export function requireOrg(c: Ctx): { session: Session; orgId: string } {
  const session = requireSession(c);
  if (!session.orgId) throw notFound('No organisation yet: create one first');
  return { session, orgId: session.orgId };
}

/** Pick the session's org: the stored one if the user is still bound in it, else their first org. */
export function resolveOrgId(store: Store, userId: string, stored: string | null): string | null {
  const orgs = listOrgsForUser(store, userId);
  if (stored && orgs.some((o) => o.id === stored)) return stored;
  return orgs[0]?.id ?? null;
}

function access(c: Ctx, orgId: string, userId: string): UserAccess {
  const cache = c.get('access');
  const key = `${orgId}\u0000${userId}`;
  let a = cache.get(key);
  if (!a) {
    a = userAccess(deps(c).store, orgId, userId);
    cache.set(key, a);
  }
  return a;
}

/** Org-scope permission check (403). */
export function requireOrgPerm(c: Ctx, ...anyOf: Permission[]): { session: Session; orgId: string; access: UserAccess } {
  const { session, orgId } = requireOrg(c);
  const a = access(c, orgId, session.user.id);
  if (!anyOf.some((p) => a.permissions.includes(p))) throw forbidden(`Missing permission: ${anyOf.join(' or ')}`);
  return { session, orgId, access: a };
}

/**
 * Project ids where the caller holds any of `perms`: null = every project (org-scope grant).
 * 403 when they hold it nowhere.
 */
export function visibleProjects(c: Ctx, ...perms: Permission[]): { session: Session; orgId: string; projectIds: string[] | null } {
  const { session, orgId } = requireOrg(c);
  const a = access(c, orgId, session.user.id);
  if (perms.some((p) => a.permissions.includes(p))) return { session, orgId, projectIds: null };
  const ids = Object.entries(a.projectPermissions)
    .filter(([, list]) => perms.some((p) => list.includes(p)))
    .map(([id]) => id);
  if (ids.length === 0) throw forbidden(`Missing permission: ${perms.join(' or ')}`);
  return { session, orgId, projectIds: ids };
}

/**
 * Projects the caller holds any permission in: null = every project (some org-scope permission),
 * else the projects with a project-scope grant. Never throws for a member without permissions.
 */
export function memberProjects(c: Ctx): { orgId: string; projectIds: string[] | null } {
  const { session, orgId } = requireOrg(c);
  const a = access(c, orgId, session.user.id);
  if (a.permissions.length > 0) return { orgId, projectIds: null };
  return { orgId, projectIds: Object.entries(a.projectPermissions).filter(([, list]) => list.length > 0).map(([id]) => id) };
}

/** Project-scoped check: 404 when the project is not in the caller's org, then 403. */
export function requireProjectPerm(c: Ctx, projectId: string | undefined, ...anyOf: Permission[]): { session: Session; orgId: string; project: Project } {
  const { session, orgId } = requireOrg(c);
  if (!projectId) throw badRequest('project is required', ['project']);
  const project = getProject(deps(c).store, orgId, projectId);
  if (!project) throw notFound('Project not found');
  const roles = rolesForUser(deps(c).store, orgId, session.user.id, projectId);
  if (!anyOf.some((p) => can(roles, p))) throw forbidden(`Missing permission: ${anyOf.join(' or ')}`);
  return { session, orgId, project };
}

/** True when the caller holds `perm` in the project (no throw). */
export function hasProjectPerm(c: Ctx, orgId: string, userId: string, projectId: string, perm: Permission): boolean {
  return can(rolesForUser(deps(c).store, orgId, userId, projectId), perm);
}

export function buildMe(c: Ctx, session: Session): MeResponse {
  const { store, config } = deps(c);
  const orgs = listOrgsForUser(store, session.user.id).map((o) => ({ id: o.id, name: o.name }));
  const org = session.orgId ? getOrg(store, session.orgId) : null;
  const a = org ? access(c, org.id, session.user.id) : null;
  const me: MeResponse = {
    user: session.user,
    org: org ? { id: org.id, name: org.name } : null,
    orgs,
    roles: a ? a.roles.map((r) => ({ id: r.id, name: r.name })) : [],
    permissions: a ? a.permissions : [],
    projectPermissions: a ? a.projectPermissions : {},
    devMode: config.devMode,
  };
  if (config.devMode) {
    me.devUsers = listDevUsers(store).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      roles: org ? rolesForUser(store, org.id, u.id).map((r) => r.name) : [],
    }));
  }
  return me;
}

export function isSwitchableDevUser(store: Store, userId: string): boolean {
  return isDevUser(store, userId);
}

export type { PagePermission };
