/**
 * Auth context: loads GET /api/me once, exposes the signed-in user, the org, and permission
 * checks built on can() from the shared permission model (../src/server/permissions.ts).
 *
 * The server is the only place permissions are enforced; the web app uses them to filter
 * navigation and to show a 403 state instead of a broken page.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { can as canWithRoles, type Permission, type RoleLike } from '@server/permissions';
import { api, isApiError, setUnauthenticatedHandler, type LoginRequest, type MeResponse } from './api';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

/**
 * The roles `can()` evaluates for `me` in an optional project scope. /api/me already returns
 * effective permissions, so each scope becomes one synthetic role and can() takes their union.
 */
export function scopeRoles(me: MeResponse | null, projectId?: string | null): RoleLike[] {
  if (!me) return [];
  const roles: RoleLike[] = [{ id: 'scope:org', permissions: me.permissions }];
  const extra = projectId ? me.projectPermissions[projectId] : undefined;
  if (extra && extra.length > 0) roles.push({ id: `scope:project:${projectId}`, permissions: extra });
  return roles;
}

/** Pure permission check for `me`, at org scope or in one project. */
export function meCan(me: MeResponse | null, permission: Permission, projectId?: string | null): boolean {
  return canWithRoles(scopeRoles(me, projectId), permission);
}

export interface AuthContextValue {
  status: AuthStatus;
  me: MeResponse | null;
  error: string | null;
  /** True when the user holds `permission` at org scope, or in `projectId` when given. */
  can: (permission: Permission, projectId?: string | null) => boolean;
  login: (body: LoginRequest) => Promise<MeResponse>;
  logout: () => Promise<void>;
  /** Dev mode role switcher (POST /api/dev/switch-user). */
  switchUser: (userId: string) => Promise<MeResponse>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, initialMe }: { children: ReactNode; initialMe?: MeResponse | null }) {
  const [me, setMe] = useState<MeResponse | null>(initialMe ?? null);
  const [status, setStatus] = useState<AuthStatus>(initialMe === undefined ? 'loading' : initialMe ? 'authenticated' : 'anonymous');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      setStatus('authenticated');
      setError(null);
    } catch (e) {
      setMe(null);
      if (isApiError(e, 'unauthenticated')) {
        setStatus('anonymous');
      } else {
        setStatus('error');
        setError(e instanceof Error ? e.message : 'Could not load the session.');
      }
    }
  }, []);

  useEffect(() => {
    if (initialMe === undefined) void refresh();
  }, [initialMe, refresh]);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setMe(null);
      setStatus('anonymous');
    });
    return () => setUnauthenticatedHandler(null);
  }, []);

  const login = useCallback(async (body: LoginRequest) => {
    const m = await api.login(body);
    setMe(m);
    setStatus('authenticated');
    setError(null);
    return m;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
      setStatus('anonymous');
    }
  }, []);

  const switchUser = useCallback(async (userId: string) => {
    const m = await api.devSwitchUser({ userId });
    setMe(m);
    setStatus('authenticated');
    return m;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      error,
      can: (permission, projectId) => meCan(me, permission, projectId),
      login,
      logout,
      switchUser,
      refresh,
    }),
    [status, me, error, login, logout, switchUser, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
