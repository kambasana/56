import { Outlet, useNavigate } from 'react-router';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { useTheme } from '@/lib/theme';
import { Nav } from './Nav';

/** Sidebar (232px, like the canvas) + main column. Pages render into <Outlet />. */
export function AppShell() {
  const { me, switchUser, logout } = useAuth();
  const { projectId, projects } = useProject();
  const { choice, cycle } = useTheme();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <div className="flex h-full min-h-screen bg-background text-foreground max-md:flex-col">
      <div className="w-[232px] shrink-0 max-md:w-full md:sticky md:top-0 md:h-screen">
        <Nav
          me={me}
          projectId={projectId}
          projects={projects}
          theme={choice}
          onCycleTheme={cycle}
          onSwitchUser={(id) => {
            void switchUser(id).then(() => navigate('/'));
          }}
          onLogout={() => {
            void logout().then(() => navigate('/login'));
          }}
        />
      </div>
      <main className="flex min-w-0 grow flex-col">
        <Outlet />
      </main>
    </div>
  );
}
