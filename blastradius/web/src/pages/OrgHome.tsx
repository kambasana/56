/**
 * Overview (org home; stage 2 redesigns it on the Overview template): totals, the projects table (size tier, last scan, counts by level, trend, to
 * review) and the risky components shared across projects (from the org-wide exposure matrix).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ExposureMatrixResponse, OrgHomeResponse, Permission, ProjectRow } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { RiskBadge } from '@/components/Badge';
import { Badge } from '@/components/ui/badge';
import { FileText, FolderPlus } from 'lucide-react';
import { Button, ButtonLink } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { StatTile } from '@/components/StatTile';
import { useApi } from '@/lib/useApi';
import { fmtNum, fmtTime } from '@/lib/cn';
import { CreateProjectDialog } from './d-parts/CreateProjectDialog';
import { emptyCounts, LEVELS } from './d-parts/format';
import { LevelCounts, PageSkeleton, ScanStatusBadge, SectionCard } from './d-parts/ui';
import { AlertsCard, ExposureSearch } from './d-parts/IncidentPanel';

/** First project page the user may open, in nav order. */
const PROJECT_PAGES: { perm: Permission; path: string }[] = [
  { perm: 'findings', path: 'findings' },
  { perm: 'changes', path: 'changes' },
  { perm: 'exposure', path: 'exposure' },
  { perm: 'investigate', path: 'investigate' },
  { perm: 'scans', path: 'scans' },
];

export function projectLanding(can: (p: Permission, projectId?: string | null) => boolean, projectId: string): string | null {
  const hit = PROJECT_PAGES.find((p) => can(p.perm, projectId));
  return hit ? `/projects/${encodeURIComponent(projectId)}/${hit.path}` : null;
}

/** Critical + high per scan, oldest first. Plain inline SVG, labelled for screen readers. */
function Trend({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="text-xs text-muted-foreground">—</span>;
  const w = 72;
  const h = 18;
  const max = Math.max(1, ...points);
  const step = w / (points.length - 1);
  const d = points.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Critical plus high over ${points.length} scans: ${points.join(', ')}`} className="text-muted-foreground">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Columns of the projects table (Overview and the Projects page). */
export const PROJECT_COLUMNS: ColumnDef<ProjectRow, any>[] = [
  {
    id: 'name',
    header: 'Project',
    accessorFn: (r) => r.name,
    cell: (c) => (
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{c.row.original.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground" title={c.row.original.target}>
          {c.row.original.target}
        </span>
      </span>
    ),
    meta: { className: 'max-w-[300px]' },
    enableHiding: false,
  },
  { id: 'tier', header: 'Tier', accessorFn: (r) => r.tier, cell: (c) => <Badge variant="outline">{c.getValue<string>()}</Badge>, size: 100 },
  { id: 'assets', header: 'Assets', accessorFn: (r) => r.assets, cell: (c) => fmtNum(c.getValue<number>()), meta: { align: 'right' }, size: 72, sortDescFirst: true },
  { id: 'components', header: 'Components', accessorFn: (r) => r.components, cell: (c) => fmtNum(c.getValue<number>()), meta: { align: 'right' }, size: 100, sortDescFirst: true },
  {
    id: 'counts',
    header: 'Crit · high · med · low',
    meta: { label: 'Counts by level' },
    accessorFn: (r) => r.counts.critical * 1e6 + r.counts.high * 1e3 + r.counts.medium,
    cell: (c) => <LevelCounts counts={c.row.original.counts} />,
    sortDescFirst: true,
  },
  { id: 'trend', header: 'Critical + high', accessorFn: (r) => r.trend.at(-1) ?? 0, cell: (c) => <Trend points={c.row.original.trend} />, enableSorting: false, size: 100 },
  { id: 'toReview', header: 'To review', accessorFn: (r) => r.toReview, cell: (c) => fmtNum(c.getValue<number>()), meta: { align: 'right' }, size: 84, sortDescFirst: true },
  {
    id: 'lastScan',
    header: 'Last scan',
    accessorFn: (r) => r.lastScan?.createdAt ?? '',
    cell: (c) => {
      const s = c.row.original.lastScan;
      if (!s) return <span className="text-muted-foreground">never</span>;
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <ScanStatusBadge status={s.status} />
          <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">{fmtTime(s.finishedAt ?? s.createdAt)}</span>
        </span>
      );
    },
    size: 220,
  },
  { id: 'owner', header: 'Owner', accessorFn: (r) => r.owner ?? '', cell: (c) => c.getValue<string>() || <span className="text-muted-foreground">—</span> },
];

interface SharedComponent {
  purl: string;
  name: string;
  version: string;
  level: ExposureMatrixResponse['columns'][number]['level'];
  score: number;
  projects: string[];
  findingId: string;
  projectId: string;
}

/** Components from the org-wide exposure matrix, most widely shared first. */
export function sharedComponents(m: ExposureMatrixResponse, limit = 10): SharedComponent[] {
  const projectsByCol = new Map<number, string[]>();
  for (const cell of m.cells) {
    const row = m.rows[cell.row];
    if (!row) continue;
    const list = projectsByCol.get(cell.col) ?? [];
    list.push(row.label);
    projectsByCol.set(cell.col, list);
  }
  return m.columns
    .map((c, i) => ({ purl: c.purl, name: c.name, version: c.version, level: c.level, score: c.score, projects: projectsByCol.get(i) ?? [], findingId: c.findingId, projectId: c.projectId }))
    .sort((a, b) => b.projects.length - a.projects.length || b.score - a.score || a.purl.localeCompare(b.purl))
    .slice(0, limit);
}

function SharedRisky() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi((s) => api.exposure({ minLevel: 'high', limit: 100 }, s), []);
  const items = useMemo(() => (data ? sharedComponents(data) : []), [data]);
  return (
    <SectionCard id="shared" title="Shared risky components" description="Critical and high components, most widely shared across projects first" flush>
      {loading && !data && <PageSkeleton label="Loading shared components…" rows={4} />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && items.length === 0 && <EmptyState title="Nothing critical or high" description="No project's latest scan has a critical or high finding." />}
      {items.length > 0 && (
        <ul className="flex flex-col divide-y" aria-label="Shared risky components">
          {items.map((c) => (
            <li key={c.purl} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
              <RiskBadge level={c.level} score={c.score} />
              <span className="min-w-0 truncate font-mono font-medium">
                {c.name}@{c.version}
              </span>
              <span className="grow" />
              <Badge variant="secondary" title={c.projects.join(', ')}>
                {c.projects.length} project{c.projects.length === 1 ? '' : 's'}
              </Badge>
              {can('investigate', c.projectId) ? (
                <ButtonLink size="xs" variant="ghost" to={`/projects/${encodeURIComponent(c.projectId)}/investigate?node=${encodeURIComponent(c.purl)}`}>
                  Investigate
                </ButtonLink>
              ) : can('findings', c.projectId) ? (
                <ButtonLink size="xs" variant="ghost" to={`/projects/${encodeURIComponent(c.projectId)}/findings/${encodeURIComponent(c.findingId)}`}>
                  Open
                </ButtonLink>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data?.truncated && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Limited to the top {data.columns.length} components.</p>}
    </SectionCard>
  );
}

/** For a user with "projects" but not "home": build the same shape from GET /api/projects. */
export async function homeFromProjects(signal: AbortSignal): Promise<OrgHomeResponse> {
  const items: ProjectRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 40; i++) {
    const page = await api.projects({ limit: 500, ...(cursor ? { cursor } : {}) }, signal);
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const counts = emptyCounts();
  let assets = 0;
  let components = 0;
  let toReview = 0;
  for (const p of items) {
    for (const l of LEVELS) counts[l] += p.counts[l] ?? 0;
    assets += p.assets;
    components += p.components;
    toReview += p.toReview;
  }
  const recentScans = items
    .flatMap((p) => (p.lastScan ? [p.lastScan] : []))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { org: { id: '', name: '', slug: '', createdAt: '' }, totals: { projects: items.length, assets, components, counts, toReview }, projects: items, recentScans };
}

export default function OrgHome() {
  const { me, can } = useAuth();
  const { reload: reloadProjects } = useProject();
  const navigate = useNavigate();
  const canHome = can('home');
  const { data, error, loading, reload } = useApi((s) => (canHome ? api.home(s) : homeFromProjects(s)), [canHome]);
  const [creating, setCreating] = useState(false);
  const canCreate = can('manage_projects');
  const names = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p.name])), [data]);

  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: 'Overview', to: '/' }];
  const t = data?.totals;
  const meta = t ? `${fmtNum(t.projects)} projects · ${fmtNum(t.assets)} assets · ${fmtNum(t.components)} components` : undefined;

  const openCreate = () => setCreating(true);

  let body;
  if (loading && !data) body = <PageSkeleton label="Loading organization…" tiles={5} rows={6} />;
  else if (error && !data) body = <ErrorState error={error} onRetry={reload} />;
  else if (data && t)
    body = (
      <div className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <StatTile label="Projects" value={fmtNum(t.projects)} hint={`${fmtNum(t.assets)} assets`} />
          <StatTile label="Critical" value={fmtNum(t.counts.critical)} tone={t.counts.critical ? 'critical' : 'muted'} hint="Latest scans" />
          <StatTile label="High" value={fmtNum(t.counts.high)} tone={t.counts.high ? 'high' : 'muted'} hint="Latest scans" />
          <StatTile label="Medium · low" value={`${fmtNum(t.counts.medium)} · ${fmtNum(t.counts.low)}`} tone="muted" hint="Latest scans" />
          <StatTile label="To review" value={fmtNum(t.toReview)} hint="New findings in the latest scans" />
        </div>
        {(can('exposure') || can('findings')) && (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {can('exposure') && <ExposureSearch />}
            <AlertsCard />
          </div>
        )}
        <SectionCard
          id="projects"
          title="Projects"
          description="Each project has its own targets, size tier and scans"
          flush
        >
          {data.projects.length === 0 ? (
            <EmptyState
              icon={<FolderPlus />}
              title="No projects yet"
              description="Create a project and point it at a repository to run the first scan."
              action={canCreate ? <Button onClick={openCreate}>New project</Button> : undefined}
            />
          ) : (
            <DataTable<ProjectRow>
              label="Projects"
              data={data.projects}
              columns={PROJECT_COLUMNS}
              getRowId={(r) => r.id}
              filterPlaceholder="Filter projects…"
              initialSorting={[{ id: 'counts', desc: true }]}
              onRowClick={(row) => {
                const to = projectLanding(can, row.id);
                if (to) navigate(to);
              }}
            />
          )}
        </SectionCard>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {can('exposure') && <SharedRisky />}
          <SectionCard id="recent" title="Recent scans" description="Latest scan of each project" flush>
            {data.recentScans.length === 0 ? (
              <EmptyState title="No scans yet" />
            ) : (
              <ul className="flex flex-col divide-y" aria-label="Recent scans">
                {data.recentScans.slice(0, 10).map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                    <ScanStatusBadge status={s.status} />
                    <span className="font-medium">{names.get(s.projectId) ?? s.projectId}</span>
                    <span className="grow" />
                    <span className="font-mono text-xs text-muted-foreground">{fmtTime(s.finishedAt ?? s.createdAt)}</span>
                    {can('scans', s.projectId) && (
                      <ButtonLink size="xs" variant="ghost" to={`/projects/${encodeURIComponent(s.projectId)}/scans`}>
                        Scans
                      </ButtonLink>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    );

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Overview"
        meta={meta}
        actions={
          <>
            {can('reports') && (
              <ButtonLink to="/reports" variant="ghost">
                <FileText aria-hidden="true" />
                Reports
              </ButtonLink>
            )}
            {canCreate && (
              <Button onClick={openCreate}>
                <FolderPlus aria-hidden="true" />
                New project
              </Button>
            )}
          </>
        }
      />
      {body}
      {canCreate && (
        <CreateProjectDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(p) => {
            setCreating(false);
            reloadProjects();
            reload();
            if (can('scans', p.id)) navigate(`/projects/${encodeURIComponent(p.id)}/scans`);
          }}
        />
      )}
    </>
  );
}
