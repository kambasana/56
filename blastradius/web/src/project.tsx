/**
 * Current-project context. The project comes from the URL (/projects/:id/...) and is
 * remembered, so org pages still show the "Project" nav group for the last one opened.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import type { ProjectRef } from '@server/api-types';
import { api } from './api';
import { useAuth } from './auth';
import { projectIdFromPath } from './nav';

const KEY = 'blastradius.project';

function readLast(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function writeLast(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export interface ProjectContextValue {
  /** Project in the URL, else the last one opened, else the first listed. */
  projectId: string | null;
  /** True when the URL names the project (a project-scoped page). */
  inProjectRoute: boolean;
  project: ProjectRef | null;
  projects: ProjectRef[];
  loading: boolean;
  /** Re-fetch the list (after creating or renaming a project). */
  reload: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children, initialProjects }: { children: ReactNode; initialProjects?: ProjectRef[] }) {
  const { me } = useAuth();
  const { pathname } = useLocation();
  const routeId = projectIdFromPath(pathname);
  const [projects, setProjects] = useState<ProjectRef[]>(initialProjects ?? []);
  const [loading, setLoading] = useState(initialProjects === undefined);
  const [tick, setTick] = useState(0);
  const [last, setLast] = useState<string | null>(readLast);

  useEffect(() => {
    if (initialProjects !== undefined || !me) return;
    const ac = new AbortController();
    setLoading(true);
    const fallback = Object.keys(me.projectPermissions).map((id) => ({ id, name: id }));
    api
      .projects({ limit: 500 }, ac.signal)
      .then((page) => {
        if (!ac.signal.aborted) setProjects(page.items.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => {
        if (!ac.signal.aborted) setProjects(fallback);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [me, initialProjects, tick]);

  useEffect(() => {
    if (routeId) {
      writeLast(routeId);
      setLast(routeId);
    }
  }, [routeId]);

  const value = useMemo<ProjectContextValue>(() => {
    const known = (id: string | null) => (id && projects.some((p) => p.id === id) ? id : null);
    const projectId = routeId ?? known(last) ?? projects[0]?.id ?? null;
    const project = projects.find((p) => p.id === projectId) ?? (projectId ? { id: projectId, name: projectId } : null);
    return { projectId, inProjectRoute: routeId !== null, project, projects, loading, reload: () => setTick((t) => t + 1) };
  }, [routeId, last, projects, loading]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used inside <ProjectProvider>');
  return ctx;
}
