/**
 * The projects table (the Projects page) and its data for users without the home permission.
 * Moved here from the old Overview, which no longer shows the table.
 */
import type { OrgHomeResponse, ProjectRow } from '@server/api-types';
import { api } from '@/api';
import { Badge } from '@/components/ui/badge';
import { type ColumnDef } from '@/components/DataTable';
import { fmtNum, fmtTime } from '@/lib/cn';
import { emptyCounts, LEVELS } from '../d-parts/format';
import { LevelCounts, ScanStatusBadge } from '../d-parts/ui';

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

