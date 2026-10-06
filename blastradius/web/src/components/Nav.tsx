/**
 * Sidebar navigation, the shadcn/ui sidebar-07 block (collapsible icon rail) with the
 * structure of Nav.dc.html: an org switcher in the header, then the Organization,
 * Project · <name> (with a project switcher) and Knowledge groups, and a user menu in the
 * footer (role, theme, dev "view as", sign out). Items come from buildNav(), which filters
 * by the user's page permissions with can().
 *
 * Render inside <SidebarProvider> (AppShell does).
 */
import type { ComponentType, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  BookOpen,
  Check,
  ChevronsUpDown,
  FileText,
  FolderKanban,
  GitCompareArrows,
  Grid3x3,
  House,
  LogOut,
  Monitor,
  Moon,
  Plug,
  ScanSearch,
  Settings,
  ShieldAlert,
  Sun,
  Waypoints,
} from 'lucide-react';
import type { MeResponse, ProjectRef } from '@server/api-types';
import { activeNavId, buildNav, type NavItem } from '@/nav';
import type { Theme } from '@/lib/theme';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';

export interface NavProps {
  me: MeResponse;
  projectId: string | null;
  projects: ProjectRef[];
  onSwitchUser?: (userId: string) => void;
  /** Switch the working org (POST /api/session/org). */
  onSwitchOrg?: (orgId: string) => void;
  onLogout?: () => void;
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
  /** @deprecated use onThemeChange; cycles system → light → dark. */
  onCycleTheme?: () => void;
}

const ICONS: Record<NavItem['id'], ComponentType> = {
  home: House,
  projects: FolderKanban,
  reports: FileText,
  integrations: Plug,
  settings: Settings,
  changes: GitCompareArrows,
  findings: ShieldAlert,
  exposure: Grid3x3,
  investigate: Waypoints,
  scans: ScanSearch,
  incidents: BookOpen,
} as Record<NavItem['id'], ComponentType>;

/** The Blastradius mark: three concentric rings. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true" className={className}>
      <circle cx="10" cy="10" r="2" />
      <circle cx="10" cy="10" r="5.5" opacity="0.6" />
      <circle cx="10" cy="10" r="9" opacity="0.3" />
    </svg>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function NavGroup({ label, items, active }: { label: ReactNode; items: NavItem[]; active: string | null }) {
  if (items.length === 0) return null;
  return (
    <SidebarGroup>
      {label}
      <SidebarMenu>
        {items.map((it) => {
          const Icon = ICONS[it.id] ?? FileText;
          const isActive = active === it.id;
          return (
            <SidebarMenuItem key={it.id}>
              {it.disabled ? (
                <SidebarMenuButton disabled aria-disabled="true" tooltip={it.label}>
                  <Icon />
                  <span>{it.label}</span>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton asChild isActive={isActive} tooltip={it.label}>
                  <Link to={it.to} aria-current={isActive ? 'page' : undefined}>
                    <Icon />
                    <span>{it.label}</span>
                  </Link>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function OrgSwitcher({ me, onSwitchOrg }: { me: MeResponse; onSwitchOrg?: (orgId: string) => void }) {
  const { isMobile } = useSidebar();
  const name = me.org?.name ?? 'No organization';
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={`Organization: ${name}. Switch organization`}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <BrandMark className="size-5" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium" data-testid="nav-org">
                  {name}
                </span>
                <span className="truncate text-xs text-sidebar-foreground/70">Blastradius</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">Organizations</DropdownMenuLabel>
            {me.orgs.map((o) => {
              const current = o.id === me.org?.id;
              return (
                <DropdownMenuItem key={o.id} className="gap-2 p-2" onSelect={() => !current && onSwitchOrg?.(o.id)} disabled={!current && !onSwitchOrg}>
                  <div className="flex size-6 items-center justify-center rounded-md border text-xs font-medium">{initials(o.name)}</div>
                  <span className="truncate">{o.name}</span>
                  {current && <Check className="ml-auto" aria-label="Current organization" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ProjectLabel({ projectId, projects, onSwitch }: { projectId: string | null; projects: ProjectRef[]; onSwitch: (id: string) => void }) {
  const { isMobile } = useSidebar();
  const name = projects.find((p) => p.id === projectId)?.name ?? projectId ?? '';
  if (projects.length <= 1) {
    return (
      <SidebarGroupLabel>
        <span className="shrink-0">Project ·</span>
        <span className="ml-1 truncate">{name}</span>
      </SidebarGroupLabel>
    );
  }
  return (
    <DropdownMenu>
      <SidebarGroupLabel asChild>
        <DropdownMenuTrigger aria-label="Switch project" className="w-full cursor-pointer gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
          <span className="shrink-0">Project ·</span>
          <span className="truncate" data-testid="nav-project">
            {name}
          </span>
          <ChevronsUpDown className="ml-auto" />
        </DropdownMenuTrigger>
      </SidebarGroupLabel>
      <DropdownMenuContent className="min-w-56 rounded-lg" align="start" side={isMobile ? 'bottom' : 'right'} sideOffset={4}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">Projects</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={projectId ?? ''} onValueChange={onSwitch}>
          {projects.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              {p.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const THEMES: { value: Theme; label: string; icon: ComponentType }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

function NavUser({ me, theme, onThemeChange, onCycleTheme, onSwitchUser, onLogout }: Pick<NavProps, 'me' | 'theme' | 'onThemeChange' | 'onCycleTheme' | 'onSwitchUser' | 'onLogout'>) {
  const { isMobile } = useSidebar();
  const roleLabel = me.roles.map((r) => r.name).join(', ') || 'no role';
  const name = me.user.name || me.user.email;
  const dev = me.devMode && me.devUsers && me.devUsers.length > 0 && onSwitchUser;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              data-testid="nav-user"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg">{initials(name)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs text-sidebar-foreground/70" data-testid="nav-role">
                  <span className="sr-only">Role: </span>
                  {roleLabel}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">{initials(name)}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{name}</span>
                  <span className="truncate text-xs text-muted-foreground">{me.user.email}</span>
                </div>
              </div>
              <p className="px-1 pb-1 text-xs text-muted-foreground">Role: {roleLabel} · pages shown per RBAC</p>
            </DropdownMenuLabel>
            {(onThemeChange || onCycleTheme) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={theme ?? 'system'}
                  onValueChange={(v) => {
                    if (onThemeChange) onThemeChange(v as Theme);
                    else onCycleTheme?.();
                  }}
                >
                  {THEMES.map((t) => (
                    <DropdownMenuRadioItem key={t.value} value={t.value} onSelect={(e) => e.preventDefault()}>
                      <t.icon />
                      {t.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            )}
            {dev && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Dev: view as</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={me.user.id} onValueChange={(id) => id !== me.user.id && onSwitchUser?.(id)} aria-label="Dev: view as">
                  {me.devUsers!.map((u) => (
                    <DropdownMenuRadioItem key={u.id} value={u.id}>
                      <span className="truncate">
                        {u.email} <span className="text-muted-foreground">({u.roles.join(', ') || 'no role'})</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            )}
            {onLogout && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogout}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function Nav({ me, projectId, projects, onSwitchUser, onSwitchOrg, onLogout, theme, onThemeChange, onCycleTheme }: NavProps) {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const model = buildNav(me, projectId);
  const active = activeNavId(pathname, hash);

  const switchProject = (id: string) => {
    const m = /^\/projects\/[^/]+\/([a-z]+)/.exec(pathname);
    const sub = m?.[1] ?? model.project[0]?.to.split('/').pop() ?? 'findings';
    navigate(`/projects/${encodeURIComponent(id)}/${sub}`);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <OrgSwitcher me={me} onSwitchOrg={onSwitchOrg} />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main" className="flex flex-col">
          <NavGroup label={<SidebarGroupLabel>Organization</SidebarGroupLabel>} items={model.org} active={active} />
          {model.project.length > 0 && (
            <NavGroup label={<ProjectLabel projectId={projectId} projects={projects} onSwitch={switchProject} />} items={model.project} active={active} />
          )}
          <NavGroup label={<SidebarGroupLabel>Knowledge</SidebarGroupLabel>} items={model.knowledge} active={active} />
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <NavUser me={me} theme={theme} onThemeChange={onThemeChange} onCycleTheme={onCycleTheme} onSwitchUser={onSwitchUser} onLogout={onLogout} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
