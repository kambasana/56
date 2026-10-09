/**
 * ⌘K command palette (shadcn Command + cmdk), available on every signed-in page.
 *
 * Groups: Packages · Projects · People and orgs · Settings and actions. A query shaped like
 * `name@version` or `name version` asks GET /api/search/exposure and shows the Verdict first
 * ("Yes, it is here: 3 projects, 1 in production" / "Not found in any of 42 projects"), linking
 * to the package page. People and orgs come from the Investigate search of the current project.
 *
 * Keyboard: ⌘K / Ctrl+K toggles, arrows move, Enter opens, Esc closes. Nothing is persisted.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Building2, FolderKanban, LogOut, Monitor, Moon, Package, Settings, Sun, User } from 'lucide-react';
import type { InvestigateSearchResponse } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { packagePath, projectHome, projectPath, settingsNav } from '@/nav';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useTheme } from './theme-provider';
import { VerdictContent, type VerdictData } from './br/Verdict';
import { parsePackageQuery, verdictFrom } from '@/lib/package-query';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Open state, shared by the sidebar button and the global shortcut
// ---------------------------------------------------------------------------

interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const PaletteContext = createContext<PaletteState>({ open: false, setOpen: () => {} });

export function useCommandPalette(): PaletteState {
  return useContext(PaletteContext);
}

/** Holds the open state and listens for ⌘K / Ctrl+K anywhere on the page. */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <PaletteContext.Provider value={value}>
      {children}
      <CommandPalette />
    </PaletteContext.Provider>
  );
}

const matches = (q: string, ...texts: string[]) => {
  const needle = q.trim().toLowerCase();
  return !needle || texts.some((t) => t.toLowerCase().includes(needle));
};

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

type Exposure = { key: string; state: 'loading' } | { key: string; state: 'done'; data: VerdictData } | { key: string; state: 'error'; message: string };

const ITEM = 'gap-2.5 rounded-lg px-2 py-1.5';
const HINT = 'ml-auto text-caption text-muted-foreground';

export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const { me, can, logout } = useAuth();
  const { projects, projectId } = useProject();
  const { setTheme } = useTheme();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [exposure, setExposure] = useState<Exposure | null>(null);
  const [people, setPeople] = useState<InvestigateSearchResponse['items']>([]);
  const [selected, setSelected] = useState('');
  const pkg = parsePackageQuery(q);
  const pkgKey = pkg ? `${pkg.name}@${pkg.version}` : null;
  const canExposure = can('exposure');
  const canInvestigate = !!projectId && can('investigate', projectId);
  const term = q.trim();

  // Reset when closed: nothing from the session's searches is kept.
  useEffect(() => {
    if (!open) {
      setQ('');
      setExposure(null);
      setPeople([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !pkgKey || !pkg || !canExposure) {
      setExposure(null);
      return;
    }
    const ac = new AbortController();
    setExposure({ key: pkgKey, state: 'loading' });
    const t = setTimeout(() => {
      api
        .searchExposure(`${pkg.name}@${pkg.version}`, ac.signal)
        .then((res) => !ac.signal.aborted && setExposure({ key: pkgKey, state: 'done', data: verdictFrom(res) }))
        .catch((e: unknown) => !ac.signal.aborted && setExposure({ key: pkgKey, state: 'error', message: e instanceof Error ? e.message : String(e) }));
    }, 200);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
    // pkg is derived from pkgKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pkgKey, canExposure]);

  const peopleTerm = !pkg && term.length >= 2 ? term : '';
  useEffect(() => {
    if (!open || !peopleTerm || !canInvestigate || !projectId) {
      setPeople([]);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      api
        .investigateSearch(projectId, peopleTerm, ac.signal)
        .then((res) => !ac.signal.aborted && setPeople(res.items.filter((i) => i.kind === 'entity').slice(0, 5)))
        .catch(() => !ac.signal.aborted && setPeople([]));
    }, 200);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [open, peopleTerm, canInvestigate, projectId]);

  const go = useCallback(
    (to: string) => {
      setOpen(false);
      navigate(to);
    },
    [navigate, setOpen],
  );
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const projectItems = projects.filter((p) => matches(term, p.name)).slice(0, 8);
  const orgItems = (me?.orgs ?? []).filter((o) => matches(term, o.name, 'organization org'));
  const actions = [
    ...settingsNav(me).map((s) => ({
      id: s.id,
      label: s.label,
      hint: 'Settings',
      keywords: s.id === 'sources' ? 'settings sources connect github gitlab forgejo token repository' : 'settings members roles people invite permissions',
      run: () => go(s.to),
      icon: Settings,
    })),
    ...(can('integrations') ? [{ id: 'connect', label: 'Connect GitHub or GitLab', hint: 'Sources', keywords: 'connect github gitlab forgejo source repository', run: () => go('/integrations'), icon: Settings }] : []),
    ...(can('findings') || Object.keys(me?.projectPermissions ?? {}).length ? [{ id: 'alerts', label: 'Slack alerts', hint: 'Alerts', keywords: 'alerts slack notify rules', run: () => go('/alerts'), icon: Settings }] : []),
    ...(can('reports') ? [{ id: 'reports', label: 'Reports', hint: 'Audit record', keywords: 'reports sbom sarif audit download', run: () => go('/reports'), icon: Settings }] : []),
    { id: 'light', label: 'Theme: Light', hint: 'Appearance', keywords: 'theme light appearance', run: () => run(() => setTheme('light')), icon: Sun },
    { id: 'dark', label: 'Theme: Dark', hint: 'Appearance', keywords: 'theme dark appearance', run: () => run(() => setTheme('dark')), icon: Moon },
    { id: 'system', label: 'Theme: System', hint: 'Appearance', keywords: 'theme system appearance', run: () => run(() => setTheme('system')), icon: Monitor },
    { id: 'logout', label: 'Sign out', hint: me?.user.email ?? '', keywords: 'sign out log out logout', run: () => run(() => void logout().then(() => navigate('/login'))), icon: LogOut },
  ].filter((a) => matches(term, a.label, a.keywords));

  const verdict = exposure && exposure.key === pkgKey ? exposure : null;
  const verdictValue = verdict?.state === 'done' ? `verdict ${pkgKey}` : null;
  // The answer arrives after the other rows: select it so Enter opens it.
  useEffect(() => {
    if (verdictValue) setSelected(verdictValue);
  }, [verdictValue]);

  const packagesGroup =
    term && canExposure ? (
      <CommandGroup heading="Packages">
        {pkg ? (
          <>
            <CommandItem value={`pkg ${pkgKey}`} onSelect={() => go(packagePath(pkg.name, pkg.version))} className={ITEM}>
              <Package aria-hidden="true" />
              <span className="font-mono text-[12px]">{pkgKey}</span>
              <span className={HINT}>Where it is</span>
            </CommandItem>
            <CommandItem value={`pkg ${pkg.name}`} onSelect={() => go(packagePath(pkg.name))} className={ITEM}>
              <Package aria-hidden="true" />
              <span className="font-mono text-[12px]">{pkg.name} (all versions)</span>
              <span className={HINT}>Every project</span>
            </CommandItem>
          </>
        ) : /^@?[\w.\-/]+$/.test(term) ? (
          <CommandItem value={`pkg ${term}`} onSelect={() => go(packagePath(term))} className={ITEM}>
            <Package aria-hidden="true" />
            <span className="font-mono text-[12px]">{term} (all versions)</span>
            <span className={HINT}>Is it anywhere?</span>
          </CommandItem>
        ) : null}
      </CommandGroup>
    ) : null;

  const projectsGroup =
    projectItems.length > 0 ? (
      <CommandGroup heading="Projects">
        {projectItems.map((p) => (
          <CommandItem key={p.id} value={`project ${p.id}`} onSelect={() => go(projectHome(p.id))} className={ITEM}>
            <FolderKanban aria-hidden="true" />
            {p.name}
            <span className={HINT}>Project</span>
          </CommandItem>
        ))}
      </CommandGroup>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="top-24 translate-y-0 gap-0 overflow-hidden p-0 shadow-elev-2 sm:max-w-[640px]">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Search packages, projects, people and orgs, settings and actions</DialogDescription>
        <Command label="Search packages, projects, people, settings" shouldFilter={false} loop value={selected} onValueChange={setSelected} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-eyebrow [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase">
        <CommandInput value={q} onValueChange={setQ} placeholder="Search packages, projects, people, settings" className="font-mono text-[14px]" />
        <CommandList className="max-h-[min(60vh,480px)]">
          {pkg && canExposure && (
            <div className="p-2">
              {verdict?.state === 'done' ? (
                <CommandItem
                  value={verdictValue ?? ''}
                  onSelect={() => go(packagePath(pkg.name, pkg.version))}
                  className={cn(
                    'rounded-lg p-3 text-body text-foreground data-[selected=true]:text-foreground data-[selected=true]:ring-2 data-[selected=true]:ring-ring',
                    verdict.data.projects > 0 ? 'bg-sev-critical-soft data-[selected=true]:bg-sev-critical-soft' : 'bg-success-soft data-[selected=true]:bg-success-soft',
                  )}
                  data-testid="cmdk-verdict"
                >
                  <VerdictContent data={verdict.data} actionLabel={verdict.data.projects > 0 ? 'Open incident' : 'Open package'} />
                </CommandItem>
              ) : verdict?.state === 'error' ? (
                <div role="alert" className="rounded-lg bg-destructive-soft p-3 text-body">
                  <strong className="text-destructive">Could not check {pkgKey}</strong>
                  <code className="mt-1 block font-mono text-[12px]">{verdict.message}</code>
                </div>
              ) : (
                <div role="status" className="rounded-lg bg-muted p-3 text-body text-muted-foreground">
                  Checking every project for <span className="font-mono text-[12px]">{pkgKey}</span>…
                </div>
              )}
            </div>
          )}
          {pkg && !canExposure && (
            <p className="px-4 py-3 text-label text-text-secondary">Checking every project needs the Exposure matrix page: ask an admin.</p>
          )}

          {/* A package query lists packages first; for anything else the package lookup comes last. */}
          {pkg && packagesGroup}
          {projectsGroup}

          {(people.length > 0 || orgItems.length > 0) && (
            <CommandGroup heading="People and orgs">
              {people.map((p) => (
                <CommandItem key={p.id} value={`entity ${p.id}`} onSelect={() => go(`${projectPath(projectId!, 'investigate')}?node=${encodeURIComponent(p.id)}`)} className={ITEM}>
                  <User aria-hidden="true" />
                  {p.label}
                  <span className={HINT}>{p.meta}</span>
                </CommandItem>
              ))}
              {orgItems.map((o) => (
                <CommandItem key={o.id} value={`org ${o.id}`} onSelect={() => go('/')} className={ITEM} disabled={o.id !== me?.org?.id}>
                  <Building2 aria-hidden="true" />
                  {o.name}
                  <span className={HINT}>{o.id === me?.org?.id ? 'Your organization' : 'Switch in the org menu'}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {actions.length > 0 && (
            <CommandGroup heading="Settings and actions">
              {actions.map((a) => (
                <CommandItem key={a.id} value={`action ${a.id}`} onSelect={a.run} className={ITEM}>
                  <a.icon aria-hidden="true" />
                  {a.label}
                  <span className={HINT}>{a.hint}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {!pkg && packagesGroup}

          {!pkg && projectItems.length === 0 && people.length === 0 && orgItems.length === 0 && actions.length === 0 && !(term && canExposure) && (
            <p role="status" className="px-4 py-6 text-center text-body text-text-secondary">
              Nothing matches "{term}". Try a package with a version, such as <span className="font-mono text-[12px]">lodash@4.17.20</span>.
            </p>
          )}
        </CommandList>
        <footer className="flex flex-wrap gap-4 border-t px-4 py-2 text-caption text-muted-foreground">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>Type a package with a version to check every project</span>
        </footer>
      </Command>
      </DialogContent>
    </Dialog>
  );
}
