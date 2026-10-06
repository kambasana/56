/**
 * Findings: the core screen. A dense, virtualised table of every finding in the project's
 * latest succeeded scan, filtered by level, status and text (all kept in the URL), with a side
 * panel that shows reasons, paths to assets, who is behind it and evidence links.
 */
import { useCallback, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { FindingRow, FindingStatus, RiskLevel } from '@server/api-types';
import { FINDING_STATUSES } from '@server/api-types';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { RiskBadge } from '@/components/Badge';
import { ButtonLink } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileSearch, GitCompareArrows, TriangleAlert } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { fmtNum, fmtTime } from '@/lib/cn';
import { countByLevel, factorLabel, fmtDate, LEVEL_RANK, loadAllFindings, parseLevels, STATUS_LABELS } from './d-parts/format';
import { FindingPanel } from './d-parts/FindingPanel';
import { ClampedText, LevelFacet, StatusBadge } from './d-parts/ui';

const levelSort = (a: { original: FindingRow }, b: { original: FindingRow }) => LEVEL_RANK[a.original.level] - LEVEL_RANK[b.original.level] || a.original.score - b.original.score;

const FINDING_COLUMNS: ColumnDef<FindingRow, any>[] = [
  {
    id: 'level',
    header: 'Level',
    accessorFn: (r) => r.level,
    sortingFn: levelSort,
    cell: (c) => <RiskBadge level={c.row.original.level} />,
    size: 96,
    enableHiding: false,
  },
  { id: 'score', header: 'Risk', accessorFn: (r) => r.score, cell: (c) => Math.round(c.getValue<number>()), meta: { align: 'right' }, size: 64, sortDescFirst: true },
  { id: 'blast', header: 'Blast', accessorFn: (r) => r.blastScore, cell: (c) => fmtNum(Math.round(c.getValue<number>())), meta: { align: 'right' }, size: 72, sortDescFirst: true },
  {
    id: 'assets',
    header: 'Assets',
    accessorFn: (r) => r.reach.assets,
    cell: (c) => {
      const r = c.row.original.reach;
      return (
        <span title={`${r.prodAssets} in production · ${r.paths} paths`}>
          {fmtNum(r.assets)}
          {r.prodAssets > 0 && <span className="text-level-critical"> · {fmtNum(r.prodAssets)}p</span>}
        </span>
      );
    },
    meta: { align: 'right' },
    size: 80,
    sortDescFirst: true,
  },
  {
    id: 'component',
    header: 'Component',
    accessorFn: (r) => r.name,
    cell: (c) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono font-medium">{c.row.original.name}</span>
        <span className="text-xs text-muted-foreground">{c.row.original.ecosystem}</span>
      </span>
    ),
    meta: { className: 'max-w-[240px]' },
  },
  { id: 'version', header: 'Version', accessorFn: (r) => r.version, cell: (c) => <span className="font-mono">{c.getValue<string>()}</span>, size: 96 },
  {
    id: 'reason',
    header: 'Top reason',
    accessorFn: (r) => (r.mainReason ? `${factorLabel(r.mainReason.factor)}: ${r.mainReason.detail}` : ''),
    cell: (c) => {
      const m = c.row.original.mainReason;
      if (!m) return <span className="text-muted-foreground">—</span>;
      const more = c.row.original.factors.length - 1;
      return (
        <ClampedText
          lines={2}
          className="leading-snug"
          full={
            <span className="flex flex-col gap-1.5">
              <span className="font-medium">{factorLabel(m.factor)}</span>
              <span className="break-words text-muted-foreground">{m.detail}</span>
              {more > 0 && (
                <span className="flex flex-wrap gap-1 pt-1">
                  {c.row.original.factors
                    .filter((f) => f !== m.factor)
                    .map((f) => (
                      <Badge key={f} variant="secondary">
                        {factorLabel(f)}
                      </Badge>
                    ))}
                </span>
              )}
            </span>
          }
        >
          <span className="font-medium">{factorLabel(m.factor)}</span> <span className="text-muted-foreground">{m.detail}</span>
          {more > 0 && <span className="text-muted-foreground"> · +{more} more</span>}
        </ClampedText>
      );
    },
    enableSorting: false,
    size: 440,
    meta: { className: 'min-w-[320px]' },
  },
  { id: 'status', header: 'Status', accessorFn: (r) => STATUS_LABELS[r.status], cell: (c) => <StatusBadge status={c.row.original.status} />, size: 110 },
  { id: 'firstSeen', header: 'First seen', accessorFn: (r) => r.firstSeenAt, cell: (c) => <span className="font-mono text-xs">{fmtDate(c.getValue<string>())}</span>, size: 104 },
  // Hidden by default; kept so the text filter also matches the full purl.
  { id: 'purl', header: 'Purl', accessorFn: (r) => r.purl, cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
];

/** Radix Select needs a non-empty value for "no filter". */
const ALL = 'all';

function isStatus(v: string | null): v is FindingStatus {
  return v !== null && (FINDING_STATUSES as readonly string[]).includes(v);
}

export default function Findings() {
  const { id = '' } = useParams();
  const { me, can } = useAuth();
  const { project } = useProject();
  const [params, setParams] = useSearchParams();
  const levels = parseLevels(params.get('level'));
  const statusParam = params.get('status');
  const status = isStatus(statusParam) ? statusParam : null;
  const q = params.get('q') ?? '';
  const selected = params.get('f');

  const { data, error, loading, reload } = useApi((s) => loadAllFindings(id, s), [id]);
  const [overrides, setOverrides] = useState<Record<string, FindingRow>>({});

  const all = useMemo(() => (data ? data.items.map((r) => overrides[r.id] ?? r) : []), [data, overrides]);
  const byStatus = useMemo(() => (status ? all.filter((r) => r.status === status) : all), [all, status]);
  const counts = useMemo(() => countByLevel(byStatus), [byStatus]);
  const rows = useMemo(() => (levels.length ? byStatus.filter((r) => levels.includes(r.level)) : byStatus), [byStatus, levels.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const onUpdated = useCallback((row: FindingRow) => setOverrides((o) => ({ ...o, [row.id]: row })), []);

  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: project?.name ?? 'Project' }, { label: 'Findings' }];
  const scanTime = data?.scan ? fmtTime(data.scan.finishedAt ?? data.scan.createdAt) : null;
  const meta = data ? `${fmtNum(data.total)} findings${scanTime ? ` · scan ${scanTime}` : ''}` : undefined;

  const table = (rowsIn: FindingRow[], busy: boolean) => (
    <DataTable<FindingRow>
      label="Findings"
      data={rowsIn}
      loading={busy}
      columns={FINDING_COLUMNS}
      getRowId={(r) => r.id}
      globalFilter={q}
      onGlobalFilterChange={(v) => update({ q: v })}
      filterPlaceholder="Filter by name, purl or reason…"
      initialSorting={[{ id: 'score', desc: true }]}
      initialColumnVisibility={{ purl: false }}
      selectedId={selected}
      onSelectedIdChange={(sel) => update({ f: sel })}
      total={all.length}
      emptyTitle={all.length === 0 ? 'No findings in this scan' : 'No findings match these filters'}
      emptyDescription={all.length === 0 ? 'Nothing in the inventory scored above the reporting threshold.' : 'Clear the level or status filter to see more.'}
      toolbar={
        <>
          <LevelFacet selected={levels} counts={counts} onChange={(next: RiskLevel[]) => update({ level: next.join(',') })} />
          <Select value={status ?? ALL} onValueChange={(v) => update({ status: v === ALL ? null : v })}>
            <SelectTrigger size="sm" aria-label="Filter by status" className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              <SelectSeparator />
              {FINDING_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {data?.capped && (
            <Badge variant="outline" className="border-warning/40 text-warning">
              <TriangleAlert aria-hidden="true" />
              Showing the first {fmtNum(data.items.length)} rows
            </Badge>
          )}
        </>
      }
      renderPanel={(row, close) => <FindingPanel row={row} onClose={close} onUpdated={onUpdated} />}
    />
  );

  let body;
  if (loading && !data) body = table([], true);
  else if (error) body = <ErrorState error={error} onRetry={reload} />;
  else if (data && !data.scan)
    body = (
      <EmptyState
        icon={<FileSearch />}
        title="No completed scan yet"
        description="Findings appear after the project's first successful scan."
        action={can('scans', id) ? <ButtonLink to={`/projects/${encodeURIComponent(id)}/scans`}>Go to Scans</ButtonLink> : undefined}
      />
    );
  else body = table(rows, false);

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Findings"
        meta={meta}
        actions={
          <>
            {can('changes', id) && (
              <ButtonLink to={`/projects/${encodeURIComponent(id)}/changes`}>
                <GitCompareArrows aria-hidden="true" />
                Changes
              </ButtonLink>
            )}
            {can('reports') && <ButtonLink to="/reports">Reports</ButtonLink>}
          </>
        }
      />
      {body}
    </>
  );
}
