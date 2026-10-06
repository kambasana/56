import { useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { useTheme } from './theme-provider';
import { ShellHeaderContext } from './shell-header';
import { Nav } from './Nav';

/** The shadcn sidebar remembers open/collapsed in the "sidebar_state" cookie. */
function sidebarDefaultOpen(): boolean {
  try {
    return !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(document.cookie);
  } catch {
    return true;
  }
}

/**
 * App layout, the shadcn sidebar-07 block: SidebarProvider + Nav (icon-collapsible Sidebar)
 * + SidebarInset with a top bar (SidebarTrigger, then the page's breadcrumb and actions,
 * which PageHeader portals into the bar). Pages render into <Outlet />.
 */
export function AppShell() {
  const { me, switchUser, switchOrg, logout } = useAuth();
  const { projectId, projects } = useProject();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const header = useMemo(() => ({ slot }), [slot]);
  const [defaultOpen] = useState(sidebarDefaultOpen);
  if (!me) return null;
  const fail = (what: string) => (e: unknown) => toast.error(`${what} failed`, { description: e instanceof Error ? e.message : String(e) });
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Nav
        me={me}
        projectId={projectId}
        projects={projects}
        theme={theme}
        onThemeChange={setTheme}
        onSwitchUser={(id) => {
          switchUser(id).then(() => navigate('/'), fail('Switching user'));
        }}
        onSwitchOrg={(id) => {
          switchOrg(id).then((m) => {
            toast.success(`Switched to ${m.org?.name ?? 'organization'}`);
            navigate('/');
          }, fail('Switching organization'));
        }}
        onLogout={() => {
          void logout().then(() => navigate('/login'));
        }}
      />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex min-h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <div ref={setSlot} data-slot="shell-header" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 py-1.5" />
        </header>
        <ShellHeaderContext.Provider value={header}>
          <div className="flex min-w-0 flex-1 flex-col">
            <Outlet />
          </div>
        </ShellHeaderContext.Provider>
      </SidebarInset>
    </SidebarProvider>
  );
}
