/**
 * Sidebar navigation, exactly the structure of Nav.dc.html: brand, org switcher, then the
 * Organization, Project · <name> (with a project switcher) and Knowledge groups, and a footer
 * with the role line, the dev role switcher, theme and sign out. Items come from buildNav(),
 * which filters by the user's page permissions with can().
 */
import type { ReactNode } from 'react';
import { useLocation, useNavigate, Link } from 'react-router';
import type { MeResponse, ProjectRef } from '@server/api-types';
import { activeNavId, buildNav, type NavItem } from '@/nav';
import { cn } from '@/lib/cn';
import type { ThemeChoice } from '@/lib/theme';

export interface NavProps {
  me: MeResponse;
  projectId: string | null;
  projects: ProjectRef[];
  onSwitchUser?: (userId: string) => void;
  onLogout?: () => void;
  theme?: ThemeChoice;
  onCycleTheme?: () => void;
}

const itemClass =
  'flex h-8 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm text-sidebar-foreground no-underline outline-none ' +
  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring ' +
  'data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground';

function Group({ label, items, active, children }: { label: ReactNode; items: NavItem[]; active: string | null; children?: ReactNode }) {
  if (items.length === 0) return null;
  return (
    <div className="relative flex w-full min-w-0 flex-col p-2">
      <div className="flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70">{label}</div>
      {children}
      <ul className="m-0 flex w-full min-w-0 list-none flex-col gap-1 p-0">
        {items.map((it) => (
          <li key={it.id} className="relative">
            {it.disabled ? (
              <span className={cn(itemClass, 'cursor-default opacity-50')} aria-disabled="true">
                <span>{it.label}</span>
              </span>
            ) : (
              <Link to={it.to} className={itemClass} data-active={active === it.id ? 'true' : 'false'} aria-current={active === it.id ? 'page' : undefined}>
                <span>{it.label}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Nav({ me, projectId, projects, onSwitchUser, onLogout, theme, onCycleTheme }: NavProps) {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const model = buildNav(me, projectId);
  const active = activeNavId(pathname, hash);
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId ?? '';
  const roleLabel = me.roles.map((r) => r.name).join(', ') || 'no role';

  const switchProject = (id: string) => {
    const m = /^\/projects\/[^/]+\/([a-z]+)/.exec(pathname);
    const sub = m?.[1] ?? model.project[0]?.to.split('/').pop() ?? 'findings';
    navigate(`/projects/${encodeURIComponent(id)}/${sub}`);
  };

  return (
    <nav aria-label="Main" className="flex h-full w-full flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex flex-col gap-2 p-2">
        <div className="flex items-center gap-2 px-2 pt-1">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <circle cx="10" cy="10" r="2" />
            <circle cx="10" cy="10" r="5.5" opacity="0.6" />
            <circle cx="10" cy="10" r="9" opacity="0.3" />
          </svg>
          <span className="font-semibold">Blastradius</span>
        </div>
        <div className="flex w-full flex-col items-start rounded-md border border-sidebar-border px-2 py-1.5" title={me.orgs.map((o) => o.name).join(', ')}>
          <span className="text-xs leading-4 text-muted-foreground">Organization</span>
          <span className="font-medium" data-testid="nav-org">
            {me.org?.name ?? 'No organization'}
            {me.orgs.length > 1 ? ' ▾' : ''}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 grow flex-col overflow-auto">
        <Group label="Organization" items={model.org} active={active} />
        {model.project.length > 0 && (
          <Group
            label={
              <>
                <span className="shrink-0">Project ·</span>
                {projects.length > 1 ? (
                  <>
                    <label htmlFor="nav-project" className="sr-only">
                      Switch project
                    </label>
                    <select
                      id="nav-project"
                      value={projectId ?? ''}
                      onChange={(e) => switchProject(e.target.value)}
                      className="min-w-0 grow cursor-pointer truncate rounded border-0 bg-transparent p-0 text-xs font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground"
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <span className="truncate">{projectName}</span>
                )}
              </>
            }
            items={model.project}
            active={active}
          />
        )}
        <Group label="Knowledge" items={model.knowledge} active={active} />
      </div>

      <div className="flex flex-col gap-2 border-t border-sidebar-border p-2">
        <div className="flex flex-col gap-0.5 px-2 text-xs leading-4 text-muted-foreground">
          <span>
            Signed in as <span className="text-foreground">{me.user.email}</span>
          </span>
          <span data-testid="nav-role">Role: {roleLabel} · pages shown per RBAC</span>
        </div>
        {me.devMode && me.devUsers && me.devUsers.length > 0 && onSwitchUser && (
          <div className="flex flex-col gap-1 px-2">
            <label htmlFor="dev-switch" className="text-xs leading-4 text-muted-foreground">
              Dev: view as
            </label>
            <select
              id="dev-switch"
              value={me.user.id}
              onChange={(e) => onSwitchUser(e.target.value)}
              className="h-7 cursor-pointer rounded-md border border-input bg-background px-1.5 text-xs"
            >
              {me.devUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email} ({u.roles.join(', ') || 'no role'})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-1 px-1">
          {onCycleTheme && (
            <button type="button" onClick={onCycleTheme} className="h-6 cursor-pointer rounded-md px-2 text-xs hover:bg-sidebar-accent" title="Switch theme">
              Theme: {theme ?? 'system'}
            </button>
          )}
          <span className="grow" />
          {onLogout && (
            <button type="button" onClick={onLogout} className="h-6 cursor-pointer rounded-md px-2 text-xs hover:bg-sidebar-accent">
              Sign out
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
