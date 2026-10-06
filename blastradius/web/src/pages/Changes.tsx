/**
 * Changes: what moved between the project's two latest succeeded scans (GET /api/changes).
 * Type tabs with counts, a dense table, and a side panel with links to the finding.
 */
import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { ChangeRow, ChangeType } from '@server/api-types';
import { CHANGE_TYPES } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { Badge, RiskBadge } from '@/components/Badge';
import { ButtonLink } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { EmptyState, ErrorState, LoadingState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { SidePanel } from '@/components/SidePanel';
import { useApi } from '@/lib/useApi';
import { cn, fmtNum, fmtTime } from '@/lib/cn';
import { CHANGE_LABELS, factorLabel, LEVEL_RANK, purlLabel } from './d-parts/format';
import { findingHref } from './d-parts/FindingPanel';
import { Section } from './d-parts/ui';

const TYPE_TONE: Record<ChangeType, string> = {
  new_finding: 'border-destructive/40 text-destructive',
  risk_up: 'border-warning/40 text-warning',
  new_reason: 'border-warning/40 text-warning',
  risk_down: 'text-success border-success/40',
  resolved: 'text-success border-success/40',
};

function isChangeType(v: string | null): v is ChangeType {
  return v !== null && (CHANGE_TYPES as readonly string[]).includes(v);
}

function RiskEffect({ row }: { row: ChangeRow }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {row.from ? <RiskBadge level={row.from.level} score={row.from.score} /> : <span className="text-muted-foreground">—</span>}
      <span aria-hidden="true" className="text-muted-foreground">→</span>
      <span className="sr-only">to</span>
      {row.to ? <RiskBadge level={row.to.level} score={row.to.score} /> : <span className="text-muted-foreground">gone</span>}
    </span>
  );
}

const effectRank = (r: ChangeRow) => (r.to ? LEVEL_RANK[r.to.level] * 1000 + r.to.score : 0) - (r.from ? LEVEL_RANK[r.from.level] * 1000 + r.from.score : 0);

const COLUMNS: ColumnDef<ChangeRow, any>[] = [
  {
    id: 'type',
    header: 'Change',
    accessorFn: (r) => CHANGE_LABELS[r.type],
    cell: (c) => (
      <Badge variant="outline" className={TYPE_TONE[c.row.original.type]}>
        {CHANGE_LABELS[c.row.original.type]}
      </Badge>
    ),
    size: 120,
  },
  {
    id: 'subject',
    header: 'Subject',
    accessorFn: (r) => `${r.name}@${r.version}`,
    cell: (c) => <span className="font-mono font-medium">{c.getValue<string>()}</span>,
  },
  {
    id: 'what',
    header: 'What happened',
    accessorFn: (r) => `${r.detail} ${r.addedFactors.map(factorLabel).join(' ')}`,
    cell: (c) => (
      <span className="line-clamp-2 max-w-[420px] text-muted-foreground" title={c.row.original.detail}>
        {c.row.original.detail}
      </span>
    ),
    enableSorting: false,
  },
  {
    id: 'reach',
    header: 'Reach',
    accessorFn: (r) => r.reach.assets,
    cell: (c) => {
      const r = c.row.original.reach;
      return (
        <span>
          {fmtNum(r.assets)}
          {r.prodAssets > 0 && <span className="text-destructive"> · {fmtNum(r.prodAssets)}p</span>}
        </span>
      );
    },
    meta: { align: 'right' },
    size: 80,
    sortDescFirst: true,
  },
  { id: 'effect', header: 'Risk effect', accessorFn: effectRank, cell: (c) => <RiskEffect row={c.row.original} />, size: 190, sortDescFirst: true },
  { id: 'purl', header: 'Purl', accessorFn: (r) => r.purl },
];

function ChangePanel({ row, projectId, onClose }: { row: ChangeRow; projectId: string; onClose: () => void }) {
  const { can } = useAuth();
  return (
    <SidePanel
      label="Change details"
      onClose={onClose}
      eyebrow={
        <Badge variant="outline" className={TYPE_TONE[row.type]}>
          {CHANGE_LABELS[row.type]}
        </Badge>
      }
      title={`${row.name}@${row.version}`}
      actions={
        <>
          {row.findingId && can('findings', projectId) && (
            <ButtonLink size="xs" to={findingHref(projectId, row.findingId)}>
              Open finding
            </ButtonLink>
          )}
          {can('investigate', projectId) && (
            <ButtonLink size="xs" to={`/projects/${encodeURIComponent(projectId)}/investigate?node=${encodeURIComponent(row.purl)}`}>
              Investigate
            </ButtonLink>
          )}
        </>
      }
    >
      <div className="flex flex-col divide-y">
        <Section title="What happened">
          <p className="m-0">{row.detail}</p>
        </Section>
        <Section title="Risk effect">
          <RiskEffect row={row} />
        </Section>
        {row.addedFactors.length > 0 && (
          <Section title="New reasons">
            <div className="flex flex-wrap gap-1">
              {row.addedFactors.map((f) => (
                <Badge key={f} variant="secondary">
                  {factorLabel(f)}
                </Badge>
              ))}
            </div>
          </Section>
        )}
        <Section title="Reach">
          <p className="m-0">
            {fmtNum(row.reach.assets)} asset{row.reach.assets === 1 ? '' : 's'}, {fmtNum(row.reach.prodAssets)} in production
          </p>
        </Section>
        <Section title="Package">
          <p className="m-0 break-all font-mono text-xs">{purlLabel(row.purl)}</p>
        </Section>
      </div>
    </SidePanel>
  );
}

export default function Changes() {
  const { id = '' } = useParams();
  const { me, can } = useAuth();
  const { project } = useProject();
  const [params, setParams] = useSearchParams();
  const typeParam = params.get('type');
  const type = isChangeType(typeParam) ? typeParam : null;
  const { data, error, loading, reload } = useApi((s) => api.changes({ project: id }, s), [id]);
  const rows = useMemo(() => (data ? (type ? data.items.filter((r) => r.type === type) : data.items) : []), [data, type]);

  const setType = (t: ChangeType | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (t) n.set('type', t);
        else n.delete('type');
        return n;
      },
      { replace: true },
    );

  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: project?.name ?? 'Project' }, { label: 'Changes' }];
  const meta = data?.toScan
    ? data.fromScan
      ? `${fmtTime(data.fromScan.finishedAt ?? data.fromScan.createdAt)} → ${fmtTime(data.toScan.finishedAt ?? data.toScan.createdAt)}`
      : `first scan ${fmtTime(data.toScan.finishedAt ?? data.toScan.createdAt)}`
    : undefined;

  let body;
  if (loading && !data) body = <LoadingState label="Loading changes…" />;
  else if (error) body = <ErrorState error={error} onRetry={reload} />;
  else if (data && !data.toScan)
    body = (
      <EmptyState
        title="No completed scan yet"
        description="Changes compare the two latest successful scans of this project."
        action={can('scans', id) ? <ButtonLink to={`/projects/${encodeURIComponent(id)}/scans`}>Go to Scans</ButtonLink> : undefined}
      />
    );
  else if (data)
    body = (
      <>
        {!data.fromScan && (
          <p className="m-0 border-b bg-muted/40 px-5 py-2 text-xs text-muted-foreground">
            This project has one successful scan, so every finding shows as new. Run another scan to see what moved.
          </p>
        )}
        <DataTable<ChangeRow>
          label="Changes"
          data={rows}
          columns={COLUMNS}
          getRowId={(r) => r.id}
          filterPlaceholder="Filter changes…"
          initialSorting={[{ id: 'effect', desc: true }]}
          initialColumnVisibility={{ purl: false }}
          total={data.items.length}
          emptyTitle={data.items.length === 0 ? 'Nothing changed' : 'No changes of this type'}
          emptyDescription={data.items.length === 0 ? 'The two latest scans have the same findings at the same levels.' : undefined}
          toolbar={
            <div role="group" aria-label="Change type" className="flex flex-wrap items-center gap-1">
              {[null, ...CHANGE_TYPES].map((t) => {
                const on = t === type;
                const n = t ? data.counts[t] ?? 0 : data.items.length;
                return (
                  <button
                    key={t ?? 'all'}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setType(t)}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium',
                      on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {t ? CHANGE_LABELS[t] : 'All'}
                    <span className="font-mono tabular-nums opacity-80">{fmtNum(n)}</span>
                  </button>
                );
              })}
            </div>
          }
          renderPanel={(row, close) => <ChangePanel row={row} projectId={id} onClose={close} />}
        />
      </>
    );

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Changes"
        meta={meta}
        actions={can('findings', id) ? <ButtonLink to={`/projects/${encodeURIComponent(id)}/findings`}>Findings</ButtonLink> : undefined}
      >
        <span className="text-xs text-muted-foreground">What moved in your supply chain between the two latest scans.</span>
      </PageHeader>
      {body}
    </>
  );
}
