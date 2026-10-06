/**
 * Scans: the project's scan history with live status, a "Run scan" button (manage_projects)
 * and a "New project" dialog (manage_projects at org scope). Running scans are polled.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { Scan } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { Badge } from '@/components/Badge';
import { Button, ButtonAnchor, ButtonLink } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { EmptyState, ErrorState, LoadingState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { SidePanel } from '@/components/SidePanel';
import { usePaged } from './e-parts/usePaged';
import { fmtNum, fmtTime } from '@/lib/cn';
import { emptyCounts, fmtDuration } from './d-parts/format';
import { CreateProjectDialog } from './d-parts/CreateProjectDialog';
import { LevelCounts, ScanStatusBadge, Section } from './d-parts/ui';

/** How often a queued or running scan is polled. */
export const SCAN_POLL_MS = 2000;

const COLUMNS: ColumnDef<Scan, any>[] = [
  { id: 'status', header: 'Status', accessorFn: (r) => r.status, cell: (c) => <ScanStatusBadge status={c.row.original.status} />, size: 110 },
  { id: 'createdAt', header: 'Requested', accessorFn: (r) => r.createdAt, cell: (c) => <span className="font-mono text-xs">{fmtTime(c.getValue<string>())}</span>, size: 160 },
  { id: 'duration', header: 'Duration', accessorFn: (r) => fmtDuration(r.startedAt, r.finishedAt), enableSorting: false, size: 90 },
  {
    id: 'target',
    header: 'Target',
    accessorFn: (r) => r.target,
    cell: (c) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-xs" title={c.row.original.target}>
          {c.row.original.target}
        </span>
        {c.row.original.commit && <span className="font-mono text-xs text-muted-foreground">{c.row.original.commit.slice(0, 12)}</span>}
      </span>
    ),
    meta: { className: 'max-w-[320px]' },
  },
  { id: 'components', header: 'Components', accessorFn: (r) => r.summary?.inventory.components ?? -1, cell: (c) => (c.row.original.summary ? fmtNum(c.row.original.summary.inventory.components) : '—'), meta: { align: 'right' }, size: 100 },
  { id: 'findings', header: 'Findings', accessorFn: (r) => r.summary?.findings ?? -1, cell: (c) => (c.row.original.summary ? fmtNum(c.row.original.summary.findings) : '—'), meta: { align: 'right' }, size: 80 },
  {
    id: 'counts',
    header: 'Crit · high · med · low',
    meta: { label: 'Counts by level' },
    accessorFn: (r) => (r.summary ? r.summary.counts.critical * 1e6 + r.summary.counts.high * 1e3 : -1),
    cell: (c) => (c.row.original.summary ? <LevelCounts counts={c.row.original.summary.counts} /> : <span className="text-muted-foreground">—</span>),
    sortDescFirst: true,
  },
  {
    id: 'note',
    header: 'Note',
    accessorFn: (r) => r.error ?? (r.offline ? 'offline' : ''),
    cell: (c) =>
      c.row.original.error ? (
        <span className="line-clamp-1 text-destructive" title={c.row.original.error}>
          {c.row.original.error}
        </span>
      ) : c.row.original.offline ? (
        <Badge variant="secondary">offline</Badge>
      ) : null,
    enableSorting: false,
  },
];

function ScanPanel({ scan, onClose }: { scan: Scan; onClose: () => void }) {
  const { can } = useAuth();
  const s = scan.summary;
  const p = encodeURIComponent(scan.projectId);
  return (
    <SidePanel
      label="Scan details"
      onClose={onClose}
      eyebrow={
        <>
          <ScanStatusBadge status={scan.status} />
          <span>requested {fmtTime(scan.createdAt)}</span>
        </>
      }
      title={`Scan ${scan.id}`}
      actions={
        scan.status === 'succeeded' ? (
          <>
            {can('findings', scan.projectId) && (
              <ButtonLink size="xs" to={`/projects/${p}/findings`}>
                Findings
              </ButtonLink>
            )}
            {can('changes', scan.projectId) && (
              <ButtonLink size="xs" to={`/projects/${p}/changes`}>
                Changes
              </ButtonLink>
            )}
            {can('reports', scan.projectId) && (
              <>
                <ButtonAnchor size="xs" href={api.reportUrl(scan.id, 'html')} download>
                  HTML
                </ButtonAnchor>
                <ButtonAnchor size="xs" href={api.reportUrl(scan.id, 'json')} download>
                  JSON
                </ButtonAnchor>
                <ButtonAnchor size="xs" href={api.reportUrl(scan.id, 'sarif')} download>
                  SARIF
                </ButtonAnchor>
              </>
            )}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col divide-y">
        <Section title="Run">
          <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Target</dt>
            <dd className="m-0 break-all font-mono text-xs">{scan.target}</dd>
            <dt className="text-muted-foreground">Commit</dt>
            <dd className="m-0 font-mono text-xs">{scan.commit ?? '—'}</dd>
            <dt className="text-muted-foreground">Started</dt>
            <dd className="m-0 font-mono text-xs">{fmtTime(scan.startedAt)}</dd>
            <dt className="text-muted-foreground">Finished</dt>
            <dd className="m-0 font-mono text-xs">{fmtTime(scan.finishedAt)}</dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="m-0 font-mono text-xs">{fmtDuration(scan.startedAt, scan.finishedAt)}</dd>
            <dt className="text-muted-foreground">Mode</dt>
            <dd className="m-0">{scan.offline ? 'Offline (recorded fixtures)' : 'Online'}</dd>
          </dl>
        </Section>
        {scan.error && (
          <Section title="Why it failed">
            <p role="alert" className="m-0 text-destructive">
              {scan.error}
            </p>
          </Section>
        )}
        {s && (
          <Section title="Summary">
            <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Assets</dt>
              <dd className="m-0 font-mono">{fmtNum(s.inventory.assets)}</dd>
              <dt className="text-muted-foreground">Components</dt>
              <dd className="m-0 font-mono">
                {fmtNum(s.inventory.components)} <span className="text-muted-foreground">({fmtNum(s.inventory.directComponents)} direct)</span>
              </dd>
              <dt className="text-muted-foreground">Install scripts</dt>
              <dd className="m-0 font-mono">{fmtNum(s.inventory.withInstallScripts)}</dd>
              <dt className="text-muted-foreground">Findings</dt>
              <dd className="m-0">
                <span className="font-mono">{fmtNum(s.findings)}</span> · <LevelCounts counts={s.counts ?? emptyCounts()} />
              </dd>
              <dt className="text-muted-foreground">Outbound</dt>
              <dd className="m-0 font-mono">{fmtNum(s.outbound)}</dd>
            </dl>
          </Section>
        )}
        {s && s.warnings.length > 0 && (
          <Section title={`Warnings (${s.warnings.length})`}>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-xs">
              {s.warnings.slice(0, 50).map((w, i) => (
                <li key={i} className="break-words">
                  {w}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </SidePanel>
  );
}

export default function Scans() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const { project, reload: reloadProjects } = useProject();
  // Paged: older scans beyond the first 200 load on demand instead of silently missing.
  const list = usePaged((cursor, s) => api.scans(id, { limit: 200, ...(cursor ? { cursor } : {}) }, s), [id]);
  const { reload } = list;
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canRun = can('manage_projects', id);
  const canCreate = can('manage_projects');
  const active = list.items.some((s) => s.status === 'queued' || s.status === 'running');
  const wasActive = useRef(false);

  // When a scan finishes, refresh the project context too (last scan and counts in nav/home).
  useEffect(() => {
    if (wasActive.current && !active) reloadProjects();
    wasActive.current = active;
  }, [active, reloadProjects]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(reload, SCAN_POLL_MS);
    return () => clearInterval(t);
  }, [active, reload]);

  const runScan = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await api.runScan(id, {});
      reload();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Could not start the scan.');
    } finally {
      setRunning(false);
    }
  };

  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: project?.name ?? 'Project' }, { label: 'Scans' }];
  const loaded = !(list.loading && list.items.length === 0) && !(list.error && list.items.length === 0);
  const meta = loaded ? `${fmtNum(list.total)} scan${list.total === 1 ? '' : 's'}${active ? ' · 1 in progress' : ''}` : undefined;

  let body;
  if (list.loading && list.items.length === 0) body = <LoadingState label="Loading scans…" />;
  else if (list.error && list.items.length === 0) body = <ErrorState error={list.error} onRetry={reload} />;
  else
    body = (
      <DataTable<Scan>
        label="Scans"
        data={list.items}
        columns={COLUMNS}
        getRowId={(r) => r.id}
        filterPlaceholder="Filter scans…"
        initialSorting={[{ id: 'createdAt', desc: true }]}
        total={list.total}
        toolbar={
          list.hasMore ? (
            <Button size="xs" variant="outline" onClick={list.loadMore} disabled={list.loading}>
              {list.loading ? 'Loading…' : 'Load older scans'}
            </Button>
          ) : undefined
        }
        emptyTitle="No scans yet"
        emptyDescription={canRun ? 'Run the first scan to see findings for this project.' : 'Ask someone with "Manage projects" to run the first scan.'}
        renderPanel={(row, close) => <ScanPanel scan={row} onClose={close} />}
      />
    );

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Scans"
        meta={meta}
        actions={
          <>
            {canCreate && (
              <Button variant="outline" onClick={() => setCreating(true)}>
                New project
              </Button>
            )}
            {canRun && (
              <Button onClick={() => void runScan()} disabled={running || active}>
                {running ? 'Starting…' : active ? 'Scan in progress' : 'Run scan'}
              </Button>
            )}
          </>
        }
      >
        <span className="text-xs text-muted-foreground">Read-only: nothing from the target is installed or executed.</span>
      </PageHeader>
      {runError && (
        <p role="alert" className="m-0 border-b bg-destructive/5 px-5 py-2 text-xs text-destructive">
          {runError}
        </p>
      )}
      {body}
      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            reloadProjects();
            navigate(`/projects/${encodeURIComponent(p.id)}/scans`);
          }}
        />
      )}
    </>
  );
}
