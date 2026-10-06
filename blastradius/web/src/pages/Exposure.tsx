/**
 * Exposure matrix (canvas: Exposure.dc.html). Rows are this project's assets (or, org-wide,
 * projects); columns are risky components; each cell is shaded by exposure. Built on the shadcn
 * Table: headers and the row-header column are sticky, rows are virtualised, every reached cell
 * has a Tooltip, and the grid is keyboard navigable (arrow keys, Home/End, PageUp/Down, Enter).
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { DownloadIcon } from 'lucide-react';
import type { ExposureMatrixResponse, RiskLevel } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { RiskBadge, levelLabel } from '@/components/Badge';
import { ButtonLink } from '@/components/Button';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtNum } from '@/lib/cn';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { useProject } from '@/project';
import { cellIndex, cellText, shade, sortRows, toCsv, type ExposureSort } from './e-parts/exposure';
import { LabeledSelect } from './e-parts/ui';

const LEVEL_DOT: Record<RiskLevel, string> = {
  critical: 'bg-level-critical',
  high: 'bg-level-high',
  medium: 'bg-level-medium',
  low: 'bg-level-low',
};

const ROW_H = 31;
const LEVELS = ['critical', 'high', 'medium', 'low'] as const;

type Scope = 'project' | 'org';

/**
 * Cell fill: the destructive token mixed with transparency, so it follows light and dark mode.
 * The strongest band is solid so its label keeps WCAG AA contrast in both themes
 * (paired with text-primary-foreground: near-white on red-600, near-black on red-400).
 */
function fill(pct: number): CSSProperties['background'] {
  if (!pct) return 'transparent';
  return pct >= 85 ? 'var(--destructive)' : `color-mix(in oklch, var(--destructive) ${pct}%, transparent)`;
}

export default function Exposure() {
  const { me, can } = useAuth();
  const params = useParams();
  const { project, projectId: ctxProject } = useProject();
  const projectId = params.id ?? ctxProject ?? '';
  const [sp, setSp] = useSearchParams();
  const scope: Scope = sp.get('scope') === 'org' ? 'org' : 'project';
  const minLevel = LEVELS.find((l) => l === sp.get('minLevel')) ?? 'medium';
  const limit = Number(sp.get('limit')) === 100 || Number(sp.get('limit')) === 200 ? Number(sp.get('limit')) : 50;
  const [sort, setSort] = useState<ExposureSort>('blast');

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v === null) next.delete(k);
    else next.set(k, v);
    setSp(next, { replace: true });
  };

  const { data, error, loading, reload } = useApi(
    (s) => api.exposure({ ...(scope === 'project' ? { project: projectId } : {}), minLevel, limit }, s),
    [scope, projectId, minLevel, limit],
  );

  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: project?.name ?? 'Project', to: projectId ? `/projects/${encodeURIComponent(projectId)}/findings` : undefined },
    { label: 'Exposure matrix' },
  ];

  const order = useMemo(() => (data ? sortRows(data.rows, sort) : []), [data, sort]);

  const exportCsv = () => {
    if (!data) return;
    const blob = new Blob([toCsv(data, order)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `exposure-${scope === 'org' ? 'org' : (project?.name ?? projectId)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <TooltipProvider delayDuration={150}>
      <PageHeader
        crumbs={crumbs}
        title="Exposure matrix"
        meta={data ? `${fmtNum(data.rows.length)} ${data.axis === 'asset' ? 'assets' : 'projects'} × ${fmtNum(data.columns.length)} components` : undefined}
        actions={
          <Button type="button" variant="outline" size="sm" onClick={exportCsv} disabled={!data || data.rows.length === 0}>
            <DownloadIcon />
            Export CSV
          </Button>
        }
      >
        <span className="text-[13px] text-muted-foreground" id="exp-sort-label">
          Sort rows
        </span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-labelledby="exp-sort-label"
          value={sort}
          onValueChange={(v) => v && setSort(v as ExposureSort)}
        >
          <ToggleGroupItem value="blast">Blast score</ToggleGroupItem>
          <ToggleGroupItem value="env">Environment</ToggleGroupItem>
          <ToggleGroupItem value="name">Name</ToggleGroupItem>
        </ToggleGroup>
      </PageHeader>
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-[13px] text-muted-foreground">
          Which {scope === 'org' ? 'projects' : 'assets'} each risky component reaches, and how exposed they are. Cell = scope × environment × criticality.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Rows"
            value={scope}
            onValueChange={(v) => v && setParam('scope', v === 'org' ? 'org' : null)}
          >
            <ToggleGroupItem value="project">Assets in {project?.name ?? 'project'}</ToggleGroupItem>
            <ToggleGroupItem value="org">All projects</ToggleGroupItem>
          </ToggleGroup>
          <LabeledSelect
            label="Risk ≥"
            value={minLevel}
            onValueChange={(v) => setParam('minLevel', v === 'medium' ? null : v)}
            options={LEVELS.map((l) => ({ value: l, label: levelLabel(l) }))}
          />
          <LabeledSelect
            label="Columns"
            value={String(limit)}
            onValueChange={(v) => setParam('limit', v === '50' ? null : v)}
            options={['50', '100', '200'].map((v) => ({ value: v, label: v }))}
            className="min-w-[80px]"
          />
          <Legend />
        </div>
        {loading && !data ? (
          <MatrixSkeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data || data.rows.length === 0 || data.columns.length === 0 ? (
          <EmptyState
            title="Nothing exposed at this level"
            description={`No component at ${levelLabel(minLevel).toLowerCase()} risk or above reaches ${scope === 'org' ? 'a project' : 'an asset'} in the latest scan. Lower the level or run a scan.`}
          />
        ) : (
          <Matrix data={data} order={order} canFindings={(pid) => can('findings', pid)} canInvestigate={(pid) => can('investigate', pid)} loading={loading} />
        )}
      </div>
    </TooltipProvider>
  );
}

function MatrixSkeleton() {
  return (
    <div role="status" aria-label="Loading exposure…" className="flex flex-col gap-1.5 rounded-lg border p-3">
      <span className="sr-only">Loading exposure…</span>
      <Skeleton className="h-24 w-full" />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex gap-1.5">
          <Skeleton className="h-6 w-52" />
          {Array.from({ length: 10 }, (_, j) => (
            <Skeleton key={j} className="h-6 w-10" />
          ))}
        </div>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-3" aria-label="Exposure legend" role="group">
      <span>Exposure</span>
      <span className="inline-flex items-center gap-1">
        <span className="size-3.5 rounded-[3px] border" />
        none
      </span>
      {([18, 45, 85] as const).map((p, i) => (
        <span key={p} className="inline-flex items-center gap-1">
          <span className="size-3.5 rounded-[3px]" style={{ background: fill(p) }} />
          {['≤ .3', '≤ .6', '> .6'][i]}
        </span>
      ))}
    </span>
  );
}

/** Preselect the strongest cell so the detail bar is useful straight away. */
function strongestCell(data: ExposureMatrixResponse): { ri: number; ci: number } | null {
  let best: { ri: number; ci: number; v: number } | null = null;
  for (const c of data.cells) if (!best || c.exposure > best.v) best = { ri: c.row, ci: c.col, v: c.exposure };
  return best ? { ri: best.ri, ci: best.ci } : null;
}

interface Pos {
  /** Display index into `order`. */
  r: number;
  c: number;
}

export function Matrix({ data, order, canFindings, canInvestigate, loading }: {
  data: ExposureMatrixResponse;
  order: readonly number[];
  canFindings: (projectId: string) => boolean;
  canInvestigate: (projectId: string) => boolean;
  loading?: boolean;
}) {
  const idx = useMemo(() => cellIndex(data.cells), [data.cells]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Pos>({ r: 0, c: 0 });
  const [selected, setSelected] = useState<{ ri: number; ci: number } | null>(() => strongestCell(data));
  useEffect(() => setSelected(strongestCell(data)), [data]);

  useEffect(() => {
    setActive((a) => ({ r: Math.min(a.r, Math.max(0, order.length - 1)), c: Math.min(a.c, Math.max(0, data.columns.length - 1)) }));
  }, [order.length, data.columns.length]);

  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
    initialRect: { width: 1200, height: 640 },
  });
  const items = virtualizer.getVirtualItems();
  // jsdom (tests) has no layout: fall back to the first rows.
  const rendered = items.length > 0 ? items.map((v) => v.index) : order.slice(0, 40).map((_, i) => i);
  const padTop = items.length > 0 ? (items[0]?.start ?? 0) : 0;
  const padBottom = items.length > 0 ? virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0) : 0;

  const focusCell = useCallback(
    (p: Pos) => {
      setActive(p);
      virtualizer.scrollToIndex(p.r, { align: 'auto' });
      requestAnimationFrame(() => {
        scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${p.r}:${p.c}"]`)?.focus();
      });
    },
    [virtualizer],
  );

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, p: Pos) => {
    const lastR = order.length - 1;
    const lastC = data.columns.length - 1;
    let n: Pos | null = null;
    if (e.key === 'ArrowRight') n = { r: p.r, c: Math.min(lastC, p.c + 1) };
    else if (e.key === 'ArrowLeft') n = { r: p.r, c: Math.max(0, p.c - 1) };
    else if (e.key === 'ArrowDown') n = { r: Math.min(lastR, p.r + 1), c: p.c };
    else if (e.key === 'ArrowUp') n = { r: Math.max(0, p.r - 1), c: p.c };
    else if (e.key === 'Home') n = e.ctrlKey ? { r: 0, c: 0 } : { r: p.r, c: 0 };
    else if (e.key === 'End') n = e.ctrlKey ? { r: lastR, c: lastC } : { r: p.r, c: lastC };
    else if (e.key === 'PageDown') n = { r: Math.min(lastR, p.r + 15), c: p.c };
    else if (e.key === 'PageUp') n = { r: Math.max(0, p.r - 15), c: p.c };
    if (n) {
      e.preventDefault();
      focusCell(n);
    }
  };

  const sel = selected ? { row: data.rows[selected.ri], col: data.columns[selected.ci], cell: idx.get(`${selected.ri}:${selected.ci}`) } : null;
  const totalCols = data.columns.length + 2;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
        <span>
          {fmtNum(order.length)} {data.axis === 'asset' ? 'assets' : 'projects'} × {fmtNum(data.columns.length)} components
          {data.truncated ? ' · cut by limits, raise Columns or Risk to see more' : ''}
          {order.length > 20 ? ' · rows load as you scroll' : ''}
        </span>
        {loading && <span>· refreshing…</span>}
      </div>
      <div
        ref={scrollRef}
        data-testid="exposure-scroll"
        className="max-h-[640px] overflow-auto rounded-lg border bg-card [&>[data-slot=table-container]]:overflow-visible"
      >
        <Table
          role="grid"
          aria-label="Exposure matrix"
          aria-rowcount={order.length + 2}
          aria-colcount={totalCols}
          className="w-auto border-separate border-spacing-0 text-xs leading-4"
        >
          <TableHeader className="[&_tr]:border-0">
            <TableRow aria-rowindex={1} className="hover:bg-transparent">
              <TableHead scope="col" className="sticky top-0 left-0 z-30 h-auto min-w-[220px] border-r border-b bg-muted px-3 py-2 align-bottom text-xs">
                {data.axis === 'asset' ? 'Asset' : 'Project'}
              </TableHead>
              {data.columns.map((c, ci) => (
                <TableHead
                  key={c.findingId}
                  scope="col"
                  className={cn('sticky top-0 z-20 h-[132px] w-11 border-b bg-muted px-0 pb-2 align-bottom text-xs', selected?.ci === ci && 'bg-accent')}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex cursor-default flex-col items-center">
                        <div className="max-h-[116px] overflow-hidden font-mono text-ellipsis whitespace-nowrap [writing-mode:vertical-rl] [transform:rotate(180deg)]">{c.name}</div>
                        <div className={cn('mt-1.5 size-2 rounded-[2px]', LEVEL_DOT[c.level])} aria-hidden="true" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="font-mono">
                      {c.name}@{c.version} · {levelLabel(c.level)} {Math.round(c.score)} · reaches {c.reach}
                    </TooltipContent>
                  </Tooltip>
                  <span className="sr-only">
                    {levelLabel(c.level)} {Math.round(c.score)}
                  </span>
                </TableHead>
              ))}
              <TableHead scope="col" className="sticky top-0 z-20 h-auto min-w-[96px] border-b border-l bg-muted px-3 py-2 text-right align-bottom text-xs">
                Blast score
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {padTop > 0 && (
              <tr aria-hidden="true">
                <td colSpan={totalCols} style={{ height: padTop, padding: 0, border: 0 }} />
              </tr>
            )}
            {rendered.map((pos) => {
              const ri = order[pos]!;
              const row = data.rows[ri]!;
              const rowMeta = [row.environment, row.criticality !== null ? `crit ${row.criticality}` : null].filter(Boolean).join(' · ');
              return (
                <TableRow key={row.key} aria-rowindex={pos + 2} data-index={pos} style={{ height: ROW_H }} className="border-0">
                  <TableHead scope="row" className="sticky left-0 z-10 h-auto border-r border-b bg-card px-3 py-1 text-xs font-normal">
                    <span className="font-mono font-medium">{row.label}</span>
                    {rowMeta && <span className="ml-1.5 text-muted-foreground">{rowMeta}</span>}
                  </TableHead>
                  {data.columns.map((col, ci) => {
                    const cell = idx.get(`${ri}:${ci}`);
                    const v = cell?.exposure ?? 0;
                    const pct = shade(v);
                    const isActive = active.r === pos && active.c === ci;
                    const isSel = selected?.ri === ri && selected.ci === ci;
                    const button = (
                      <Button
                        type="button"
                        variant="ghost"
                        data-cell={`${pos}:${ci}`}
                        tabIndex={isActive ? 0 : -1}
                        aria-label={`${row.label} × ${col.name}: ${v ? `exposure ${v.toFixed(2)}, ${cell?.pathCount ?? 0} paths` : 'not reached'}`}
                        onFocus={() => setActive({ r: pos, c: ci })}
                        onClick={() => setSelected({ ri, ci })}
                        onKeyDown={(e) => onKey(e, { r: pos, c: ci })}
                        className={cn(
                          'block h-[26px] w-10 rounded-[4px] p-0 font-mono text-[11px] font-normal hover:bg-accent',
                          pct ? 'cursor-pointer' : 'cursor-default border',
                          pct >= 85 ? 'text-primary-foreground hover:text-primary-foreground' : 'text-foreground',
                          isSel && 'ring-2 ring-foreground',
                        )}
                        style={pct ? { background: fill(pct) } : undefined}
                      >
                        {cellText(v)}
                      </Button>
                    );
                    return (
                      <TableCell key={col.findingId} className="border-b p-0.5" role="gridcell" aria-selected={isSel}>
                        {cell ? (
                          <Tooltip>
                            <TooltipTrigger asChild>{button}</TooltipTrigger>
                            <TooltipContent className="font-mono">
                              {row.label} × {col.name}@{col.version}
                              <br />
                              exposure {v.toFixed(2)} · {cell.pathCount} path{cell.pathCount === 1 ? '' : 's'}
                              {rowMeta ? ` · ${rowMeta}` : ''}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          button
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className="border-b border-l px-3 py-1 text-right font-mono font-medium tabular-nums">{row.blastScore.toFixed(2)}</TableCell>
                </TableRow>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true">
                <td colSpan={totalCols} style={{ height: padBottom, padding: 0, border: 0 }} />
              </tr>
            )}
          </TableBody>
          <TableFooter className="border-0 bg-transparent">
            <TableRow aria-rowindex={order.length + 2} className="hover:bg-transparent">
              <TableHead scope="row" className="sticky bottom-0 left-0 z-30 h-auto border-t border-r bg-muted px-3 py-1.5 text-xs">
                {data.axis === 'asset' ? 'Assets reached' : 'Projects reached'}
              </TableHead>
              {data.columns.map((c) => (
                <TableCell key={c.findingId} className="sticky bottom-0 z-20 border-t bg-muted px-0.5 py-1.5 text-center font-mono">
                  {c.reach}
                </TableCell>
              ))}
              <TableCell className="sticky bottom-0 z-20 border-t border-l bg-muted" />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">Arrow keys move between cells · Enter selects · Home/End jump within a row · hover or focus a cell for details.</p>
      {sel?.row && sel.col && (
        <Card role="status" aria-label="Selected cell" className="flex-row flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-2.5 text-[13px] shadow-none">
          <span className="font-mono font-semibold">
            {sel.row.label} × {sel.col.name}@{sel.col.version}
          </span>
          <span>
            {sel.cell
              ? `exposure ${sel.cell.exposure.toFixed(2)} · ${sel.cell.pathCount} path${sel.cell.pathCount === 1 ? '' : 's'}${sel.row.environment ? ` · ${sel.row.environment}` : ''}${sel.row.criticality !== null ? ` · criticality ${sel.row.criticality}` : ''}`
              : 'not reached'}
          </span>
          <RiskBadge level={sel.col.level} score={sel.col.score} />
          <span className="grow" />
          {canFindings(sel.col.projectId) && (
            <ButtonLink size="xs" to={`/projects/${encodeURIComponent(sel.col.projectId)}/findings/${encodeURIComponent(sel.col.findingId)}`}>
              Open finding
            </ButtonLink>
          )}
          {canInvestigate(sel.col.projectId) && (
            <ButtonLink size="xs" variant="ghost" to={`/projects/${encodeURIComponent(sel.col.projectId)}/investigate?finding=${encodeURIComponent(sel.col.findingId)}`}>
              Investigate
            </ButtonLink>
          )}
        </Card>
      )}
    </div>
  );
}
