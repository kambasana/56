/**
 * Navigation model (pure, tested), from the redesign's Sidebar.dc.html and docs/UX.md §2:
 *
 *   Main (one level): Overview · Findings · Incidents · Projects · Alerts
 *   Footer:           Reports · Settings
 *   Project sub-nav (on /projects/:id/*): Changes · Findings · Exposure matrix · Investigate · Scans
 *   Settings sub-nav (on /settings, /integrations): Members and roles · Sources
 *
 * Items are filtered with can() from the shared permission model, using the org-scope
 * permissions from /api/me plus the current project's project-scope permissions. Every item is
 * a real page: no anchors, duplicates or "coming soon" entries.
 */
import { WEB_ROUTES, type PagePermission } from '@server/permissions';
import type { MeResponse, ProjectRef } from '@server/api-types';
import { meCan } from './auth';

export type NavId = 'overview' | 'findings' | 'incidents' | 'projects' | 'alerts' | 'reports' | 'settings';

export interface NavItem {
  id: NavId;
  label: string;
  to: string;
  /** Pages whose scope (ScopeBar params) carries over when following this link. */
  scoped?: boolean;
}

export interface NavModel {
  main: NavItem[];
  footer: NavItem[];
}

export interface SubNavItem {
  id: string;
  label: string;
  to: string;
}

const enc = encodeURIComponent;

export function projectPath(projectId: string, sub: string): string {
  return `/projects/${enc(projectId)}/${sub}`;
}

/** A project's home: redirects to the first project page the viewer may open. */
export function projectHome(projectId: string): string {
  return `/projects/${enc(projectId)}`;
}

/** Breadcrumb for the current project (every crumb is a link). */
export function projectCrumb(project: ProjectRef | null | undefined): { label: string; to: string } {
  return { label: project?.name ?? 'Project', to: project ? projectHome(project.id) : '/projects' };
}

/** The package verdict page (stage 2 builds the full Incident view on it). */
export function packagePath(name: string, version?: string | null): string {
  const q = new URLSearchParams({ name });
  if (version) q.set('version', version);
  return `/packages?${q}`;
}

/** One incident (an advisory that hit a project); `id` is the advisory id. */
export function incidentPath(id: string): string {
  return `/incidents/${enc(id)}`;
}

/** Who is behind a package (any version). */
export function behindPath(name: string): string {
  return `/packages/behind?${new URLSearchParams({ name })}`;
}

/** One publishing account ("npm", "qix"); github/gitlab for repository owners. */
export function accountPath(registry: string, name: string): string {
  return `/accounts/${enc(registry)}/${enc(name)}`;
}

/** The account page for an entity id from "Who's behind it" ("account:npm/qix", "org:github/chalk"), else null. */
export function accountPathForEntity(entityId: string): string | null {
  const m = /^(account|org):(npm|github|gitlab)\/(.+)$/.exec(entityId);
  if (!m || (m[1] === 'org' && m[2] === 'npm')) return null;
  return accountPath(m[2]!, m[3]!);
}

/** The org-wide exposure matrix, optionally scoped to some projects. */
export function exposurePath(projectIds: readonly string[] = []): string {
  return projectIds.length ? `/exposure?${new URLSearchParams({ projects: projectIds.join(',') })}` : '/exposure';
}

/** True when `me` holds `page` at org scope or in `projectId`. */
const has = (me: MeResponse | null, page: PagePermission, projectId: string | null) => meCan(me, page) || (projectId !== null && meCan(me, page, projectId));

export function buildNav(me: MeResponse | null, projectId: string | null): NavModel {
  if (!me) return { main: [], footer: [] };
  const main: NavItem[] = [];
  if (meCan(me, 'home') || meCan(me, 'projects')) main.push({ id: 'overview', label: 'Overview', to: '/', scoped: true });
  if (has(me, 'findings', projectId)) main.push({ id: 'findings', label: 'Findings', to: '/findings', scoped: true });
  if (has(me, 'findings', projectId)) main.push({ id: 'incidents', label: 'Incidents', to: '/incidents', scoped: true });
  if (meCan(me, 'projects')) main.push({ id: 'projects', label: 'Projects', to: '/projects' });
  if (has(me, 'findings', projectId)) main.push({ id: 'alerts', label: 'Alerts', to: '/alerts' });
  const footer: NavItem[] = [];
  if (meCan(me, 'reports')) footer.push({ id: 'reports', label: 'Reports', to: '/reports' });
  const settings = settingsNav(me);
  if (settings[0]) footer.push({ id: 'settings', label: 'Settings', to: settings[0].to });
  return { main, footer };
}

const PROJECT_ITEMS: { id: PagePermission; label: string; sub: string }[] = [
  { id: 'changes', label: 'Changes', sub: 'changes' },
  { id: 'findings', label: 'Findings', sub: 'findings' },
  { id: 'exposure', label: 'Exposure matrix', sub: 'exposure' },
  { id: 'investigate', label: 'Investigate', sub: 'investigate' },
  { id: 'scans', label: 'Scans', sub: 'scans' },
];

/** Pages of one project the viewer may open (the project sub-nav). */
export function projectNav(me: MeResponse | null, projectId: string | null): SubNavItem[] {
  if (!me || !projectId) return [];
  return PROJECT_ITEMS.filter((it) => meCan(me, it.id, projectId)).map((it) => ({ id: it.sub, label: it.label, to: projectPath(projectId, it.sub) }));
}

/** First project page the viewer may open, or null. */
export function projectLandingPath(me: MeResponse | null, projectId: string): string | null {
  return projectNav(me, projectId).find((p) => p.id === 'findings')?.to ?? projectNav(me, projectId)[0]?.to ?? null;
}

/** Settings sections the viewer may open. */
export function settingsNav(me: MeResponse | null): SubNavItem[] {
  const out: SubNavItem[] = [];
  if (meCan(me, 'settings')) out.push({ id: 'members', label: 'Members and roles', to: '/settings' });
  if (meCan(me, 'integrations')) out.push({ id: 'sources', label: 'Sources', to: '/integrations' });
  return out;
}

/** Which sidebar item a pathname belongs to. */
export function activeNavId(pathname: string): NavId | null {
  if (pathname === '/' || pathname === '') return 'overview';
  const m = /^\/projects\/[^/]+\/([a-z]+)/.exec(pathname);
  if (m) return m[1] === 'findings' ? 'findings' : 'projects';
  if (/^\/projects(\/|$)/.test(pathname)) return 'projects';
  const top = pathname.split('/')[1];
  switch (top) {
    case 'findings':
      return 'findings';
    case 'incidents':
    case 'packages':
    case 'accounts':
      return 'incidents';
    case 'exposure':
      return 'overview';
    case 'alerts':
      return 'alerts';
    case 'reports':
      return 'reports';
    case 'settings':
    case 'integrations':
      return 'settings';
    default:
      return null;
  }
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
 * Where to land a user who opens `/`: Overview when allowed, else the first allowed route in
 * WEB_ROUTES order (a reports-only member lands on /reports). Project routes need a project id.
 */
export function landingPath(me: MeResponse | null, projectId: string | null): string | null {
  if (!me) return '/login';
  // Overview also serves the project list, so `projects` alone opens it too.
  if (meCan(me, 'home') || meCan(me, 'projects')) return '/';
  for (const r of WEB_ROUTES) {
    if (!r.page) continue;
    const isProject = r.path.startsWith('/projects/:id/');
    if (isProject) {
      if (r.path.includes(':fid')) continue;
      const pid = projectId ?? Object.keys(me.projectPermissions).find((id) => meCan(me, r.page!, id)) ?? null;
      if (pid && meCan(me, r.page, pid)) return r.path.replace(':id', enc(pid));
    } else if (!r.path.includes(':') && meCan(me, r.page)) {
      return r.path;
    }
  }
  return null;
}
