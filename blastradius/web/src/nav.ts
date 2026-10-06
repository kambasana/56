/**
 * Navigation model (pure, tested): which sidebar items a user sees, from Nav.dc.html.
 *
 *   Organization: Home, Projects, Reports, Integrations, Settings
 *   Project · <name>: Changes, Findings, Exposure matrix, Investigate, Scans
 *   Knowledge: Incident KB
 *
 * Items are filtered with can() from the shared permission model, using the org-scope
 * permissions from /api/me plus the current project's project-scope permissions.
 */
import { WEB_ROUTES, type PagePermission } from '@server/permissions';
import type { MeResponse } from '@server/api-types';
import { meCan } from './auth';

export interface NavItem {
  id: PagePermission | 'incidents';
  label: string;
  to: string;
  /** Not built yet in 4a; rendered disabled. */
  disabled?: boolean;
}

export interface NavModel {
  org: NavItem[];
  project: NavItem[];
  knowledge: NavItem[];
}

const ORG_ITEMS: { id: PagePermission; label: string; to: string }[] = [
  { id: 'home', label: 'Home', to: '/' },
  { id: 'projects', label: 'Projects', to: '/#projects' },
  { id: 'reports', label: 'Reports', to: '/reports' },
  { id: 'integrations', label: 'Integrations', to: '/integrations' },
  { id: 'settings', label: 'Settings', to: '/settings' },
];

const PROJECT_ITEMS: { id: PagePermission; label: string; sub: string }[] = [
  { id: 'changes', label: 'Changes', sub: 'changes' },
  { id: 'findings', label: 'Findings', sub: 'findings' },
  { id: 'exposure', label: 'Exposure matrix', sub: 'exposure' },
  { id: 'investigate', label: 'Investigate', sub: 'investigate' },
  { id: 'scans', label: 'Scans', sub: 'scans' },
];

export function projectPath(projectId: string, sub: string): string {
  return `/projects/${encodeURIComponent(projectId)}/${sub}`;
}

export function buildNav(me: MeResponse | null, projectId: string | null): NavModel {
  const org = ORG_ITEMS.filter((it) => meCan(me, it.id)).map((it) => ({ ...it }));
  const project = projectId
    ? PROJECT_ITEMS.filter((it) => meCan(me, it.id, projectId)).map((it) => ({ id: it.id, label: it.label, to: projectPath(projectId, it.sub) }))
    : [];
  // The incident knowledge base is part of Investigate; its own screen comes after 4a.
  const knowledge: NavItem[] = meCan(me, 'investigate', projectId)
    ? [{ id: 'incidents', label: 'Incident KB', to: projectId ? projectPath(projectId, 'investigate') : '/', disabled: !projectId }]
    : [];
  return { org, project, knowledge };
}

/** Which nav item a pathname belongs to. */
export function activeNavId(pathname: string, hash = ''): NavItem['id'] | null {
  if (pathname === '/' || pathname === '') return hash === '#projects' ? 'projects' : 'home';
  const m = /^\/projects\/[^/]+\/([a-z]+)/.exec(pathname);
  if (m) return (PROJECT_ITEMS.find((p) => p.sub === m[1])?.id ?? null) as NavItem['id'] | null;
  const top = pathname.split('/')[1];
  return (ORG_ITEMS.find((o) => o.to === `/${top}`)?.id ?? null) as NavItem['id'] | null;
}

/** The project id in a /projects/:id/... path, or null. */
export function projectIdFromPath(pathname: string): string | null {
  const m = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * Where to land a user who opens `/`: home when allowed, else the first allowed route in
 * WEB_ROUTES order (an Auditor lands on /reports). Project routes need a project id.
 */
export function landingPath(me: MeResponse | null, projectId: string | null): string | null {
  if (!me) return '/login';
  // Org home also serves the project list, so `projects` alone opens it too.
  if (meCan(me, 'home') || meCan(me, 'projects')) return '/';
  for (const r of WEB_ROUTES) {
    if (!r.page) continue;
    const isProject = r.path.startsWith('/projects/');
    if (isProject) {
      if (r.path.includes(':fid')) continue;
      const pid = projectId ?? Object.keys(me.projectPermissions).find((id) => meCan(me, r.page!, id)) ?? null;
      if (pid && meCan(me, r.page, pid)) return r.path.replace(':id', encodeURIComponent(pid));
    } else if (meCan(me, r.page)) {
      return r.path;
    }
  }
  return null;
}
