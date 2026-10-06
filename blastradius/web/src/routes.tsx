/**
 * Route registration, kept apart from page bodies so screen agents only edit src/pages/*.
 * Every route from docs/WEB-API.md (WEB_ROUTES in ../src/server/permissions.ts) is here,
 * with the page permission it needs. Pages are lazy-loaded (Cytoscape stays out of the
 * main bundle).
 */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { WEB_ROUTES, type PagePermission } from '@server/permissions';
import { useAuth } from './auth';
import { useProject } from './project';
import { landingPath } from './nav';
import { AppShell } from './components/AppShell';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from './components/EmptyState';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';

type Page = LazyExoticComponent<ComponentType>;

/** Screen components by route path. */
export const PAGES: Record<string, Page> = {
  '/': lazy(() => import('./pages/OrgHome')),
  '/projects/:id/changes': lazy(() => import('./pages/Changes')),
  '/projects/:id/findings': lazy(() => import('./pages/Findings')),
  '/projects/:id/findings/:fid': lazy(() => import('./pages/FindingDetail')),
  '/projects/:id/exposure': lazy(() => import('./pages/Exposure')),
  '/projects/:id/investigate': lazy(() => import('./pages/Investigate')),
  '/projects/:id/scans': lazy(() => import('./pages/Scans')),
  '/reports': lazy(() => import('./pages/Reports')),
  '/integrations': lazy(() => import('./pages/Integrations')),
  '/settings': lazy(() => import('./pages/Settings')),
};

/** Signed-in gate: no session → /login?next=<path>. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState error={new Error(error ?? 'Could not load the session.')} onRetry={() => void refresh()} />;
  if (status === 'anonymous') {
    const next = location.pathname + location.search;
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/**
 * Page permission gate. `/` accepts home or projects and otherwise redirects to the first
 * allowed route (an Auditor lands on /reports). Other routes render a 403 state.
 */
export function RequirePage({ page, path, children }: { page: PagePermission; path: string; children: ReactNode }) {
  const { me, can } = useAuth();
  const { projectId } = useProject();
  const params = useParams();
  const scope = params.id ?? null;
  if (path === '/') {
    if (can('home') || can('projects')) return <>{children}</>;
    const to = landingPath(me, projectId);
    if (to && to !== '/') return <Navigate to={to} replace />;
    return <EmptyState title="No pages available" description="Your roles do not include any page. Ask an org admin to bind a role to you." />;
  }
  if (!can(page, scope)) return <ForbiddenState page={page} />;
  return <>{children}</>;
}

function NotFound() {
  return <EmptyState title="Page not found" description="This address does not match any page." />;
}

export function AppRoutes() {
  const shellRoutes = WEB_ROUTES.filter((r) => r.page !== null);
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        {shellRoutes.map((r) => {
          const Page = PAGES[r.path];
          if (!Page || !r.page) return null;
          return (
            <Route
              key={r.path}
              path={r.path}
              element={
                <RequirePage page={r.page} path={r.path}>
                  <Suspense fallback={<LoadingState />}>
                    <Page />
                  </Suspense>
                </RequirePage>
              }
            />
          );
        })}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
