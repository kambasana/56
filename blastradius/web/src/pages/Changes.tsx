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
import { RiskBadge } from '@/components/Badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowRight, FileSearch, GitCompareArrows, Info, Network } from 'lucide-react';
import { ButtonLink } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { SidePanel } from '@/components/SidePanel';
import { useApi } from '@/lib/useApi';
import { fmtNum, fmtTime } from '@/lib/cn';
import { CHANGE_LABELS, factorLabel, LEVEL_RANK, purlLabel } from './d-parts/format';
import { findingHref } from './d-parts/FindingPanel';
import { ClampedText, DetailList, Section } from './d-parts/ui';

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
      <ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
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
      <ClampedText lines={2} className="text-muted-foreground" full={<span className="break-words">{c.row.original.detail}</span>}>
        {c.row.original.detail}
      </ClampedText>
    ),
    enableSorting: false,
    size: 420,
    meta: { className: 'min-w-[280px]' },
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
          {r.prodAssets > 0 && <span className="text-level-critical"> · {fmtNum(r.prodAssets)}p</span>}
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
            <ButtonLink to={findingHref(projectId, row.findingId)}>
              <FileSearch aria-hidden="true" />
              Open finding
            </ButtonLink>
          )}
          {can('investigate', projectId) && (
            <ButtonLink to={`/projects/${encodeURIComponent(projectId)}/investigate?node=${encodeURIComponent(row.purl)}`}>
              <Network aria-hidden="true" />
              Investigate
            </ButtonLink>
          )}
        </>
      }
    >
      <div className="flex flex-col divide-y">
        <Section title="What happened">
          <p className="break-words">{row.detail}</p>
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
        <Section title="Details">
          <DetailList
            items={[
              ['Reach', `${fmtNum(row.reach.assets)} asset${row.reach.assets === 1 ? '' : 's'}, ${fmtNum(row.reach.prodAssets)} in production`],
              ['Package', <span className="break-all font-mono text-xs">{purlLabel(row.purl)}</span>],
              ['Purl', <span className="break-all font-mono text-xs text-muted-foreground">{row.purl}</span>],
            ]}
          />
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

  const typeTabs = data ? (
    <Tabs value={type ?? 'all'} onValueChange={(v) => setType(isChangeType(v) ? v : null)}>
      <TabsList aria-label="Change type" className="h-8">
        {[null, ...CHANGE_TYPES].map((t) => (
          <TabsTrigger key={t ?? 'all'} value={t ?? 'all'} className="gap-1.5 px-2 text-xs">
            {t ? CHANGE_LABELS[t] : 'All'}
            <span className="font-mono tabular-nums text-muted-foreground">{fmtNum(t ? (data.counts[t] ?? 0) : data.items.length)}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  ) : null;

  let body;
  if (loading && !data)
    body = <DataTable<ChangeRow> label="Changes" data={[]} loading columns={COLUMNS} initialColumnVisibility={{ purl: false }} />;
  else if (error) body = <ErrorState error={error} onRetry={reload} />;
  else if (data && !data.toScan)
    body = (
      <EmptyState
        icon={<GitCompareArrows />}
        title="No completed scan yet"
        description="Changes compare the two latest successful scans of this project."
        action={can('scans', id) ? <ButtonLink to={`/projects/${encodeURIComponent(id)}/scans`}>Go to Scans</ButtonLink> : undefined}
      />
    );
  else if (data)
    body = (
      <>
        {!data.fromScan && (
          <div className="border-b px-4 py-3">
            <Alert>
              <Info aria-hidden="true" />
              <AlertDescription>This project has one successful scan, so every finding shows as new. Run another scan to see what moved.</AlertDescription>
            </Alert>
          </div>
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
          toolbar={typeTabs}
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
        actions={
          can('findings', id) ? (
            <ButtonLink to={`/projects/${encodeURIComponent(id)}/findings`}>
              <FileSearch aria-hidden="true" />
              Findings
            </ButtonLink>
          ) : undefined
        }
      >
        <span className="text-xs text-muted-foreground">What moved in your supply chain between the two latest scans.</span>
      </PageHeader>
      {body}
    </>
  );
}
