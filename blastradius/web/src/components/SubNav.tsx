/**
 * Second-level links under the top bar, so pages outside the one-level sidebar stay reachable:
 * a project's pages (with a project switcher) on /projects/:id/*, and the Settings sections on
 * /settings and /integrations. Stage 2 replaces the project tabs with the Detail template.
 */
import { Link, useLocation, useNavigate } from 'react-router';
import { ChevronsUpDown } from 'lucide-react';
import type { ProjectRef } from '@server/api-types';
import { cn } from '@/lib/utils';
import type { SubNavItem } from '@/nav';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

function Links({ items, label }: { items: SubNavItem[]; label: string }) {
  const { pathname } = useLocation();
  return (
    <nav aria-label={label} className="min-w-0 overflow-x-auto">
      <ul className="m-0 flex list-none gap-1 p-0">
        {items.map((it) => {
          const on = pathname === it.to || pathname.startsWith(`${it.to}/`);
          return (
            <li key={it.id}>
              <Link
                to={it.to}
                data-slot="sub-nav-link"
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'inline-flex h-7 items-center rounded-lg px-2.5 text-label whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  on ? 'bg-selection-soft font-semibold text-selection' : 'text-text-secondary hover:bg-accent hover:text-foreground',
                )}
              >
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function ProjectSubNav({ items, project, projects }: { items: SubNavItem[]; project: ProjectRef | null; projects: ProjectRef[] }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (!project || items.length === 0) return null;
  const switchTo = (id: string) => {
    const sub = /^\/projects\/[^/]+\/([a-z]+)/.exec(pathname)?.[1] ?? 'findings';
    navigate(`/projects/${encodeURIComponent(id)}/${sub}`);
  };
  return (
    <div data-slot="project-sub-nav" className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5">
      {projects.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Switch project" className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-label font-semibold outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <span className="text-muted-foreground">Project</span>
            <span data-testid="nav-project">{project.name}</span>
            <ChevronsUpDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Projects</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={project.id} onValueChange={switchTo}>
              {projects.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id}>
                  {p.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="px-2 text-label font-semibold">
          <span className="text-muted-foreground">Project </span>
          <span data-testid="nav-project">{project.name}</span>
        </span>
      )}
      <Links items={items} label="Project" />
    </div>
  );
}

export function SettingsSubNav({ items }: { items: SubNavItem[] }) {
  if (items.length < 2) return null;
  return (
    <div data-slot="settings-sub-nav" className="flex items-center gap-2 border-b px-4 py-1.5">
      <Links items={items} label="Settings" />
    </div>
  );
}
