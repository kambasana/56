/**
 * Overview (Overview template, docs/UX.md §3): an incident banner when an alert is active, four
 * clickable "Needs attention" tiles that open pre-filtered Findings, open findings by severity,
 * and the packages found in the most projects. All numbers come from the latest scans
 * (GET /api/overview); nothing here is estimated. The projects table lives on the Projects page.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { FolderPlus } from 'lucide-react';
import type { OverviewResponse } from '@server/api-types';
import { api, isApiError } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { projectPath } from '@/nav';
import { Button } from '@/components/Button';
import { PageHeader } from '@/components/PageHeader';
import { RANGE_LABEL, ScopeBar, SEVERITY_GLYPH, SEVERITY_LABEL, StateBlock, useScope, type Severity } from '@/components/br';
import { useApi } from '@/lib/useApi';
import { fmtNum } from '@/lib/cn';
import { cn } from '@/lib/utils';
import { CreateProjectDialog } from './d-parts/CreateProjectDialog';
import { incidentPath, reachPath } from './a-parts/links';
import { relTime } from './a-parts/triage';

export { homeFromProjects, PROJECT_COLUMNS } from './a-parts/projectsTable';

const OPEN = 'new,reviewed,fixing';
const INK: Record<Severity, string> = { critical: 'text-sev-critical', high: 'text-sev-high', medium: 'text-sev-medium', low: 'text-sev-low' };
const BAR: Record<Severity, string> = { critical: 'bg-sev-critical', high: 'bg-sev-high', medium: 'bg-sev-medium', low: 'bg-sev-low' };

/** /findings with the page's scope plus `filters` (comma lists, as the Findings page reads them). */
export function findingsLink(sp: URLSearchParams, filters: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const k of ['projects', 'env']) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  for (const [k, v] of Object.entries(filters)) q.set(k, v);
  return `/findings?${q}`;
}

function Tile({ to, label, value, sub }: { to: string; label: string; value: number; sub: string }) {
  return (
    <Link
      to={to}
      data-slot="attention-tile"
      className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3.5 text-foreground no-underline outline-none hover:bg-accent hover:no-underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="text-text-secondary">{label}</span>
      <span className="text-[28px] leading-[34px] font-semibold tracking-tight">{fmtNum(value)}</span>
      <span className="text-caption text-muted-foreground">{sub}</span>
    </Link>
  );
}

function IncidentBanner({ incident }: { incident: NonNullable<OverviewResponse['incident']> }) {
  const pkg = incident.version ? `${incident.name}@${incident.version}` : incident.name;
  return (
    <Link
      to={incidentPath(incident.advisoryId)}
      data-slot="incident-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-destructive bg-destructive-soft px-4 py-3 text-foreground no-underline outline-none hover:no-underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-destructive uppercase">Active incident</span>
      <span className="font-semibold">
        <span className="font-mono text-[12px]">{pkg}</span> is named in <span className="font-mono text-[12px]">{incident.advisoryId}</span>
      </span>
      <span className="text-text-secondary">
        {incident.projects} {incident.projects === 1 ? 'project' : 'projects'} affected · {incident.production} in production · detected {relTime(incident.detectedAt)}
      </span>
      <span className="ml-auto font-semibold text-destructive">Open incident →</span>
    </Link>
  );
}

function BySeverity({ data, sp, exposureTo }: { data: OverviewResponse; sp: URLSearchParams; exposureTo: string | null }) {
  const max = Math.max(1, ...data.bySeverity.map((b) => b.open));
  const range = data.since ? RANGE_LABEL[(sp.get('range') as keyof typeof RANGE_LABEL) ?? '30d'] ?? 'Last 30 days' : null;
  return (
    <section aria-labelledby="ov-sev" className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ov-sev" className="m-0 text-heading font-semibold">
          Open findings by severity
        </h2>
        <span className="text-caption text-muted-foreground">{range ?? 'All time'}</span>
      </div>
      <table className="w-full border-collapse" aria-label="Open findings by severity">
        <thead className="sr-only">
          <tr>
            <th scope="col">Severity</th>
            <th scope="col">Share</th>
            <th scope="col">Open</th>
            <th scope="col">New in range</th>
          </tr>
        </thead>
        <tbody>
          {data.bySeverity.map((b) => (
            <tr key={b.level}>
              <th scope="row" className={cn('w-24 py-1.5 pr-3 text-left font-semibold whitespace-nowrap', INK[b.level])}>
                <Link to={findingsLink(sp, { severity: b.level, status: OPEN })} className={cn('no-underline hover:underline', INK[b.level])}>
                  <span aria-hidden="true">{SEVERITY_GLYPH[b.level]} </span>
                  {SEVERITY_LABEL[b.level]}
                </Link>
              </th>
              <td className="w-full py-1.5">
                <span className="block h-2 overflow-hidden rounded bg-muted" title={`${b.open} open ${SEVERITY_LABEL[b.level].toLowerCase()}`}>
                  <span className={cn('block h-full rounded', BAR[b.level])} style={{ width: `${b.open === 0 ? 0 : Math.max(2, (b.open / max) * 100)}%` }} />
                </span>
              </td>
              <td className="py-1.5 pl-3 text-right font-mono text-[12px] tabular-nums">{fmtNum(b.open)}</td>
              <td className="py-1.5 pl-3 text-right text-caption whitespace-nowrap text-text-secondary">{b.newInRange === null ? '' : `+${fmtNum(b.newInRange)} new`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 text-caption text-muted-foreground">
        From the latest scan of {data.scannedProjects} of {data.projects} {data.projects === 1 ? 'project' : 'projects'}.{' '}
        {data.since ? '"New" counts open findings first seen in this range. Earlier daily counts are not stored, so no trend line is drawn.' : 'Earlier daily counts are not stored, so no trend line is drawn.'}
      </p>
      <span className="mt-auto flex flex-wrap gap-4 text-label">
        <Link to={findingsLink(sp, { status: OPEN })}>View all open findings</Link>
        {exposureTo && <Link to={exposureTo}>See where they sit (exposure matrix)</Link>}
      </span>
    </section>
  );
}

function TopPackages({ data }: { data: OverviewResponse }) {
  return (
    <section aria-labelledby="ov-top" className="flex flex-col overflow-hidden rounded-xl border">
      <h2 id="ov-top" className="m-0 px-4 pt-4 pb-2 text-heading font-semibold">
        Packages in the most projects
      </h2>
      {data.topPackages.length === 0 ? (
        <StateBlock kind="all-clear" className="m-3" title="No open findings" description={`Checked the latest scan of ${data.scannedProjects} ${data.scannedProjects === 1 ? 'project' : 'projects'}.`} />
      ) : (
        <ul aria-label="Packages in the most projects" className="m-0 flex list-none flex-col p-0">
          {data.topPackages.map((p) => (
            <li key={p.purl} className="border-t">
              <Link to={reachPath(p.name, p.version)} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 px-4 py-2 text-foreground no-underline hover:bg-accent hover:no-underline">
                <span className={cn('font-semibold', INK[p.level])} title={SEVERITY_LABEL[p.level]}>
                  <span aria-hidden="true">{SEVERITY_GLYPH[p.level]}</span>
                  <span className="sr-only">{SEVERITY_LABEL[p.level]}</span>
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-[12px]">
                    {p.name}@{p.version}
                  </span>
                  {p.reason && <span className="truncate text-caption text-muted-foreground">{p.reason}</span>}
                </span>
                <span className="text-right whitespace-nowrap text-text-secondary">
                  {p.projects} {p.projects === 1 ? 'project' : 'projects'} · {p.prodProjects > 0 ? `${p.prodProjects} prod` : 'dev only'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function OrgHome() {
  const { me, can } = useAuth();
  const { projects, projectId, reload: reloadProjects } = useProject();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const [scope] = useScope();
  const [creating, setCreating] = useState(false);
  const canCreate = can('manage_projects');
  const q = { projects: scope.projects.join(',') || undefined, env: scope.env === 'all' ? undefined : scope.env, range: scope.range };
  const { data, error, loading, reload } = useApi((s) => api.overview(q, s), [q.projects, q.env, q.range]);

  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: 'Overview', to: '/' }];
  const exposureTo = projectId && can('exposure', projectId) ? projectPath(projectId, 'exposure') : null;

  let body;
  if (loading && !data) body = <StateBlock kind="loading" label="Loading overview" rows={4} columns={4} />;
  else if (error && isApiError(error, 'forbidden'))
    body = (
      <div className="flex flex-col gap-3">
        <StateBlock kind="not-allowed" title="Findings are not part of your roles" permission="findings" />
        {can('projects') && <Link to="/projects">See all projects</Link>}
      </div>
    );
  else if (error || !data) body = <StateBlock kind="error" title="Could not load the overview" cause={error?.message ?? 'No data'} onRetry={reload} />;
  else if (data.projects === 0)
    body = (
      <StateBlock
        kind="no-results"
        title="No projects yet"
        description="Add a project and point it at a repository to run the first scan."
        actions={canCreate ? [{ label: 'New project', onClick: () => setCreating(true) }] : [{ label: 'See projects', to: '/projects' }]}
      />
    );
  else {
    const a = data.attention;
    const oldest = a.highUnassignedOldest ? `Oldest first seen ${relTime(a.highUnassignedOldest)}` : 'None waiting';
    const source = a.sourcesToCheck[0];
    const sourceTo = a.sourcesToCheck.length === 1 && source && can('scans', source.projectId) ? projectPath(source.projectId, 'scans') : '/projects';
    body = (
      <div className="flex flex-col gap-5">
        {data.incident && <IncidentBanner incident={data.incident} />}
        <section aria-labelledby="ov-attn" className="flex flex-col gap-2.5">
          <h2 id="ov-attn" className="m-0 text-heading font-semibold">
            Needs attention
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile to={findingsLink(sp, { severity: 'critical', status: OPEN })} label="Critical open" value={a.criticalOpen} sub={`${fmtNum(a.criticalOpenProd)} in production`} />
            <Tile to={findingsLink(sp, { severity: 'high', owner: 'none', status: OPEN })} label="High, nobody assigned" value={a.highUnassigned} sub={oldest} />
            <Tile to={findingsLink(sp, { new: 'week', status: OPEN })} label="New this week" value={a.newThisWeek} sub={`In ${a.newThisWeekProjects} ${a.newThisWeekProjects === 1 ? 'project' : 'projects'}`} />
            <Tile
              to={sourceTo}
              label="Sources to check"
              value={a.sourcesToCheck.length}
              sub={source ? `${source.projectName}: ${source.problem === 'failed' ? 'last scan failed' : 'never scanned'}` : 'Every project scanned'}
            />
          </div>
        </section>
        {data.scannedProjects === 0 ? (
          <StateBlock kind="no-results" title="No completed scan yet" description="The numbers appear after a project's first successful scan." actions={[{ label: 'See projects', to: '/projects' }]} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <BySeverity data={data} sp={sp} exposureTo={exposureTo} />
            <TopPackages data={data} />
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Overview"
        actions={
          canCreate && (
            <Button onClick={() => setCreating(true)}>
              <FolderPlus aria-hidden="true" />
              New project
            </Button>
          )
        }
      >
        {can('projects') && (
          <Link to="/projects" className="text-label">
            All projects ({fmtNum(projects.length)})
          </Link>
        )}
      </PageHeader>
      <div className="flex flex-col gap-4 p-4">
        <ScopeBar projects={projects} />
        {body}
      </div>
      {canCreate && (
        <CreateProjectDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(p) => {
            setCreating(false);
            reloadProjects();
            reload();
            if (can('scans', p.id)) navigate(projectPath(p.id, 'scans'));
          }}
        />
      )}
    </>
  );
}
