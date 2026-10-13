/**
 * Sidebar, from the redesign's Sidebar.dc.html (shadcn/ui sidebar, icon-collapsible):
 * org switcher, "Search or jump to ⌘K", one level of pages (Overview · Findings · Incidents ·
 * Projects · Alerts), Reports and Settings at the bottom, and the user block (role, theme,
 * sign out). Items come from buildNav(), filtered by the user's permissions with can().
 * The dev-mode "view as" switcher is not here: it is a dev-only control in the top bar
 * (DevViewAs).
 *
 * Render inside <SidebarProvider> (AppShell does).
 */
import { useEffect, type ComponentType } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { Bell, ChevronsUpDown, FileText, FolderKanban, LayoutDashboard, LogOut, Monitor, Moon, Search, Settings, ShieldAlert, Siren, Sun } from 'lucide-react';
import type { MeResponse } from '@server/api-types';
import { activeNavId, buildNav, type NavId, type NavItem } from '@/nav';
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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { scopeSearch } from './br/ScopeBar';
import { useCommandPalette } from './CommandPalette';

export interface NavProps {
  me: MeResponse;
  projectId: string | null;
  /** Switch the working org (POST /api/session/org). */
  onSwitchOrg?: (orgId: string) => void;
  onLogout?: () => void;
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
}

const ICONS: Record<NavId, ComponentType> = {
  overview: LayoutDashboard,
  findings: ShieldAlert,
  incidents: Siren,
  projects: FolderKanban,
  alerts: Bell,
  reports: FileText,
  settings: Settings,
};

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

/**
 * SidebarRail placement. Upstream centres the 16px rail on the sidebar edge, so half of it lies over
 * SidebarInset and swallows clicks on full-bleed table rows. Keep it to the sidebar's own 8px right
 * padding (no controls there, also in icon mode), with the hover line on the edge.
 */
const RAIL_INSIDE = 'w-2 translate-x-0 group-data-[side=left]:right-0 after:left-auto after:right-0';

/** Active item lifted onto --background with elev-1 (Sidebar.dc.html); others in text-secondary. */
const ITEM_CLASS =
  'h-7 text-text-secondary data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-foreground data-[active=true]:shadow-elev-1';

export function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function NavList({ items, active, label }: { items: NavItem[]; active: NavId | null; label?: string }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const [sp] = useSearchParams();
  const scope = scopeSearch(sp);
  if (items.length === 0) return null;
  return (
    <SidebarMenu aria-label={label} className="gap-0.5">
      {items.map((it) => {
        const Icon = ICONS[it.id];
        const isActive = active === it.id;
        return (
          <SidebarMenuItem key={it.id}>
            <SidebarMenuButton asChild isActive={isActive} tooltip={it.label} className={ITEM_CLASS}>
              <Link
                to={it.scoped ? `${it.to}${scope}` : it.to}
                aria-current={isActive ? 'page' : undefined}
                // The mobile nav is a Sheet over the page: close it once a page is chosen.
                onClick={() => isMobile && setOpenMobile(false)}
              >
                <Icon />
                <span>{it.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
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
              aria-label={`Organization: ${name}. Switch organization`}
              className="h-8 font-semibold data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-primary text-[11px] text-primary-foreground">
                {initials(name).slice(0, 1)}
              </span>
              <span className="truncate" data-testid="nav-org">
                {name}
              </span>
              <ChevronsUpDown className="ml-auto text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg" align="start" side={isMobile ? 'bottom' : 'right'} sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Organizations</DropdownMenuLabel>
            {/* One radio item per org: role=menuitemradio named exactly by the org, the current one checked. */}
            <DropdownMenuRadioGroup value={me.org?.id ?? ''} onValueChange={(id) => id !== me.org?.id && onSwitchOrg?.(id)} aria-label="Organizations">
              {me.orgs.map((o) => (
                <DropdownMenuRadioItem key={o.id} value={o.id} className="gap-2 p-2 pl-8" aria-label={o.name} disabled={o.id !== me.org?.id && !onSwitchOrg}>
                  <div aria-hidden="true" className="flex size-6 items-center justify-center rounded-md border text-xs font-medium">
                    {initials(o.name)}
                  </div>
                  <span className="truncate">{o.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function SearchButton() {
  const { setOpen } = useCommandPalette();
  const { isMobile, setOpenMobile } = useSidebar();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip="Search or jump to"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={() => {
            if (isMobile) setOpenMobile(false);
            setOpen(true);
          }}
          className="h-7 border border-input bg-background text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Search />
          <span>Search or jump to</span>
          <kbd aria-hidden="true" className="ml-auto rounded-[4px] border px-1 font-mono text-[11px] group-data-[collapsible=icon]:hidden">
            {mac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

const THEMES: { value: Theme; label: string; icon: ComponentType }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

function NavUser({ me, theme, onThemeChange, onLogout }: Pick<NavProps, 'me' | 'theme' | 'onThemeChange' | 'onLogout'>) {
  const { isMobile } = useSidebar();
  const roleLabel = me.roles.map((r) => r.name).join(', ') || 'no role';
  const name = me.user.name || me.user.email;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" data-testid="nav-user" className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <Avatar className="size-6 rounded-full border">
                <AvatarFallback className="rounded-full bg-secondary text-[11px] font-semibold">{initials(name)}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-caption text-muted-foreground" data-testid="nav-role">
                  <span className="sr-only">Role: </span>
                  {roleLabel}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg" side={isMobile ? 'bottom' : 'right'} align="end" sideOffset={4}>
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{name}</span>
                  <span className="truncate text-xs text-muted-foreground">{me.user.email}</span>
                </div>
              </div>
              <p className="px-1 pb-1 text-xs text-muted-foreground">Role: {roleLabel}</p>
            </DropdownMenuLabel>
            {onThemeChange && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={(v) => onThemeChange(v as Theme)}>
                  {THEMES.map((t) => (
                    <DropdownMenuRadioItem key={t.value} value={t.value} onSelect={(e) => e.preventDefault()}>
                      <t.icon />
                      {t.label}
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

export function Nav({ me, projectId, onSwitchOrg, onLogout, theme, onThemeChange }: NavProps) {
  const { pathname, key } = useLocation();
  const { setOpenMobile } = useSidebar();
  // Any navigation (nav link, project switch, org switch, back button) closes the mobile sheet.
  useEffect(() => setOpenMobile(false), [key, setOpenMobile]);
  const model = buildNav(me, projectId);
  const active = activeNavId(pathname);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3 px-3 pt-4">
        <OrgSwitcher me={me} onSwitchOrg={onSwitchOrg} />
        <SearchButton />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          <SidebarGroup className="px-3">
            <NavList items={model.main} active={active} />
          </SidebarGroup>
          <SidebarGroup className="mt-auto px-3">
            <NavList items={model.footer} active={active} />
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border px-3">
        <NavUser me={me} theme={theme} onThemeChange={onThemeChange} onLogout={onLogout} />
      </SidebarFooter>
      <SidebarRail className={RAIL_INSIDE} />
    </Sidebar>
  );
}
