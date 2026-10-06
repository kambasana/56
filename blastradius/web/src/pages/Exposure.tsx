/**
 * Exposure matrix (canvas: Exposure.dc.html). Rows are this project's assets (or, org-wide,
 * projects); columns are risky components; each cell is shaded by exposure. Headers are sticky,
 * rows are virtualised, and the grid is keyboard navigable (arrow keys, Home/End, Enter).
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { ExposureMatrixResponse, RiskLevel } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { Button, ButtonLink } from '@/components/Button';
import { EmptyState, ErrorState, LoadingState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { RiskBadge, levelLabel } from '@/components/Badge';
import { cn, fmtNum } from '@/lib/cn';
import { useApi } from '@/lib/useApi';
import { useProject } from '@/project';
import { cellIndex, cellText, shade, sortRows, toCsv, type ExposureSort } from './e-parts/exposure';
import { Select, Tabs } from './e-parts/ui';

const LEVEL_DOT: Record<RiskLevel, string> = {
  critical: 'bg-destructive',
  high: 'bg-warning',
  medium: 'bg-muted-foreground',
  low: 'bg-border',
};

const ROW_H = 31;

type Scope = 'project' | 'org';

export default function Exposure() {
  const { me, can } = useAuth();
  const params = useParams();
  const { project, projectId: ctxProject } = useProject();
  const projectId = params.id ?? ctxProject ?? '';
  const [sp, setSp] = useSearchParams();
  const scope: Scope = sp.get('scope') === 'org' ? 'org' : 'project';
  const minLevel = (['critical', 'high', 'medium', 'low'] as const).find((l) => l === sp.get('minLevel')) ?? 'medium';
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
    <>
      <PageHeader
        crumbs={crumbs}
        title="Exposure matrix"
        meta={data ? `${fmtNum(data.rows.length)} ${data.axis === 'asset' ? 'assets' : 'projects'} × ${fmtNum(data.columns.length)} components` : undefined}
        actions={
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!data || data.rows.length === 0}>
            Export CSV
          </Button>
        }
      >
        <span className="text-[13px] text-muted-foreground">Sort rows</span>
        <Tabs
          variant="pill"
          idBase="exp-sort"
          label="Sort rows"
          value={sort}
          onChange={setSort}
          items={[
            { id: 'blast', label: 'Blast score' },
            { id: 'env', label: 'Environment' },
            { id: 'name', label: 'Name' },
          ]}
        />
      </PageHeader>
      <div className="flex flex-col gap-2.5 px-5 py-3">
        <p className="m-0 text-[13px] text-muted-foreground">
          Which {scope === 'org' ? 'projects' : 'assets'} each risky component reaches, and how exposed they are. Cell = scope × environment × criticality.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <Tabs
            variant="pill"
            idBase="exp-scope"
            label="Rows"
            value={scope}
            onChange={(v) => setParam('scope', v === 'org' ? 'org' : null)}
            items={[
              { id: 'project', label: `Assets in ${project?.name ?? 'project'}` },
              { id: 'org', label: 'All projects' },
            ]}
          />
          <Select label="Risk ≥" value={minLevel} onChange={(e) => setParam('minLevel', e.target.value === 'medium' ? null : e.target.value)}>
            {(['critical', 'high', 'medium', 'low'] as const).map((l) => (
              <option key={l} value={l}>
                {levelLabel(l)}
              </option>
            ))}
          </Select>
          <Select label="Columns" value={String(limit)} onChange={(e) => setParam('limit', e.target.value === '50' ? null : e.target.value)}>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </Select>
          <Legend />
        </div>
        {loading && !data ? (
          <LoadingState label="Loading exposure…" />
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
    </>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-3" aria-label="Exposure legend">
      <span>Exposure</span>
      <span className="inline-flex items-center gap-1">
        <span className="size-3.5 rounded-[3px] border" />
        none
      </span>
      {([18, 45, 85] as const).map((p, i) => (
        <span key={p} className="inline-flex items-center gap-1">
          <span className="size-3.5 rounded-[3px]" style={{ background: `color-mix(in oklch, var(--destructive) ${p}%, transparent)` }} />
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
        className="max-h-[640px] overflow-auto rounded-lg border"
      >
        <table role="grid" aria-label="Exposure matrix" aria-rowcount={order.length + 2} aria-colcount={totalCols} className="border-separate border-spacing-0 text-xs leading-4">
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col" className="sticky left-0 top-0 z-30 min-w-[220px] border-b border-r bg-muted px-3 py-2 text-left align-bottom font-medium">
                {data.axis === 'asset' ? 'Asset' : 'Project'}
              </th>
              {data.columns.map((c, ci) => (
                <th
                  key={c.findingId}
                  scope="col"
                  title={`${c.name}@${c.version} · ${levelLabel(c.level)} ${Math.round(c.score)}`}
                  className={cn('sticky top-0 z-20 h-[132px] w-11 border-b bg-muted px-0 pb-2 align-bottom font-medium', selected?.ci === ci && 'bg-accent')}
                >
                  <div className="mx-auto max-h-[116px] overflow-hidden text-ellipsis whitespace-nowrap font-mono [transform:rotate(180deg)] [writing-mode:vertical-rl]">{c.name}</div>
                  <div className={cn('mx-auto mt-1.5 size-2 rounded-[2px]', LEVEL_DOT[c.level])} aria-hidden="true" />
                  <span className="sr-only">
                    {levelLabel(c.level)} {Math.round(c.score)}
                  </span>
                </th>
              ))}
              <th scope="col" className="sticky top-0 z-20 min-w-[96px] border-b border-l bg-muted px-3 py-2 text-right align-bottom font-medium">
                Blast score
              </th>
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr aria-hidden="true">
                <td colSpan={totalCols} style={{ height: padTop, padding: 0, border: 0 }} />
              </tr>
            )}
            {rendered.map((pos) => {
              const ri = order[pos]!;
              const row = data.rows[ri]!;
              return (
                <tr key={row.key} aria-rowindex={pos + 2} data-index={pos} style={{ height: ROW_H }}>
                  <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-r bg-background px-3 py-1 text-left font-normal">
                    <span className="font-mono font-medium">{row.label}</span>
                    <span className="ml-1.5 text-muted-foreground">
                      {[row.environment, row.criticality !== null ? `crit ${row.criticality}` : null].filter(Boolean).join(' · ')}
                    </span>
                  </th>
                  {data.columns.map((col, ci) => {
                    const cell = idx.get(`${ri}:${ci}`);
                    const v = cell?.exposure ?? 0;
                    const pct = shade(v);
                    const isActive = active.r === pos && active.c === ci;
                    const isSel = selected?.ri === ri && selected.ci === ci;
                    return (
                      <td key={col.findingId} className="border-b p-0.5" role="gridcell" aria-selected={isSel}>
                        <button
                          type="button"
                          data-cell={`${pos}:${ci}`}
                          tabIndex={isActive ? 0 : -1}
                          aria-label={`${row.label} × ${col.name}: ${v ? `exposure ${v.toFixed(2)}, ${cell?.pathCount ?? 0} paths` : 'not reached'}`}
                          onFocus={() => setActive({ r: pos, c: ci })}
                          onClick={() => setSelected({ ri, ci })}
                          onKeyDown={(e) => onKey(e, { r: pos, c: ci })}
                          className={cn(
                            'block h-[26px] w-10 rounded-[4px] p-0 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            pct ? 'cursor-pointer' : 'cursor-default',
                            pct >= 85 ? 'text-white' : 'text-foreground',
                          )}
                          style={{
                            background: pct ? `color-mix(in oklch, var(--destructive) ${pct}%, transparent)` : 'transparent',
                            border: isSel ? '2px solid var(--foreground)' : pct ? '0' : '1px solid var(--border)',
                          }}
                        >
                          {cellText(v)}
                        </button>
                      </td>
                    );
                  })}
                  <td className="border-b border-l px-3 py-1 text-right font-mono font-medium tabular-nums">{row.blastScore.toFixed(2)}</td>
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true">
                <td colSpan={totalCols} style={{ height: padBottom, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr aria-rowindex={order.length + 2}>
              <th scope="row" className="sticky bottom-0 left-0 z-30 border-r border-t bg-muted px-3 py-1.5 text-left font-medium">
                {data.axis === 'asset' ? 'Assets reached' : 'Projects reached'}
              </th>
              {data.columns.map((c) => (
                <td key={c.findingId} className="sticky bottom-0 z-20 border-t bg-muted px-0.5 py-1.5 text-center font-mono">
                  {c.reach}
                </td>
              ))}
              <td className="sticky bottom-0 z-20 border-l border-t bg-muted" />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="m-0 text-xs text-muted-foreground">Arrow keys move between cells · Enter selects · Home/End jump within a row.</p>
      {sel?.row && sel.col && (
        <div role="status" aria-label="Selected cell" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3.5 py-2.5 text-[13px]">
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
        </div>
      )}
    </div>
  );
}
