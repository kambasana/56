/**
 * Scans: the project's scan history with live status, "Run scan" (manage_projects, confirmed in
 * an AlertDialog) and "New project" (manage_projects at org scope, a Dialog). While a scan is
 * queued or running the list is polled with `updatedSince`, so older pages stay loaded.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { CircleAlert, Download, FileSearch, FolderPlus, GitCompareArrows, History, Play } from 'lucide-react';
import type { Scan } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { Button, ButtonAnchor, ButtonLink } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { ErrorState } from '@/components/EmptyState';
import { projectCrumb } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { SidePanel } from '@/components/SidePanel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { fmtNum, fmtTime } from '@/lib/cn';
import { emptyCounts, fmtDuration } from './d-parts/format';
import { CreateProjectDialog } from './d-parts/CreateProjectDialog';
import { ClampedText, DetailList, LevelCounts, ScanStatusBadge, Section } from './d-parts/ui';
import { useScanList } from './d-parts/useScanList';

/** How often a queued or running scan is polled. */
export const SCAN_POLL_MS = 2000;

const COLUMNS: ColumnDef<Scan, any>[] = [
  { id: 'status', header: 'Status', accessorFn: (r) => r.status, cell: (c) => <ScanStatusBadge status={c.row.original.status} />, size: 110 },
  { id: 'createdAt', header: 'Requested', accessorFn: (r) => r.createdAt, cell: (c) => <span className="font-mono text-xs whitespace-nowrap">{fmtTime(c.getValue<string>())}</span>, size: 170 },
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
        <ClampedText lines={1} className="text-destructive" full={<span className="break-words text-destructive">{c.row.original.error}</span>}>
          {c.row.original.error}
        </ClampedText>
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
  const mono = (v: string) => <span className="font-mono text-xs">{v}</span>;
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
              <ButtonLink to={`/projects/${p}/findings`}>
                <FileSearch aria-hidden="true" />
                Findings
              </ButtonLink>
            )}
            {can('changes', scan.projectId) && (
              <ButtonLink to={`/projects/${p}/changes`}>
                <GitCompareArrows aria-hidden="true" />
                Changes
              </ButtonLink>
            )}
            {can('reports', scan.projectId) &&
              (['html', 'json', 'sarif'] as const).map((f) => (
                <ButtonAnchor key={f} variant="ghost" href={api.reportUrl(scan.id, f)} download>
                  <Download aria-hidden="true" />
                  {f.toUpperCase()}
                </ButtonAnchor>
              ))}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col divide-y">
        <Section title="Run">
          <DetailList
            items={[
              ['Target', <span className="break-all font-mono text-xs">{scan.target}</span>],
              ['Commit', mono(scan.commit ?? '—')],
              ['Started', mono(fmtTime(scan.startedAt))],
              ['Finished', mono(fmtTime(scan.finishedAt))],
              ['Duration', mono(fmtDuration(scan.startedAt, scan.finishedAt))],
              ['Mode', scan.offline ? 'Offline (recorded fixtures)' : 'Online'],
            ]}
          />
        </Section>
        {scan.error && (
          <Section title="Why it failed">
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription className="break-words">{scan.error}</AlertDescription>
            </Alert>
          </Section>
        )}
        {s && (
          <Section title="Summary">
            <DetailList
              items={[
                ['Assets', mono(fmtNum(s.inventory.assets))],
                [
                  'Components',
                  <span className="font-mono text-xs">
                    {fmtNum(s.inventory.components)} <span className="text-muted-foreground">({fmtNum(s.inventory.directComponents)} direct)</span>
                  </span>,
                ],
                ['Install scripts', mono(fmtNum(s.inventory.withInstallScripts))],
                [
                  'Findings',
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {mono(fmtNum(s.findings))}
                    <LevelCounts counts={s.counts ?? emptyCounts()} />
                  </span>,
                ],
                ['Outbound', mono(fmtNum(s.outbound))],
              ]}
            />
          </Section>
        )}
        {s && s.warnings.length > 0 && (
          <Section title={`Warnings (${s.warnings.length})`}>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs">
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
  const list = useScanList(id);
  const { refresh } = list;
  const [confirmRun, setConfirmRun] = useState(false);
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

  // Poll only what changed while something is queued or running.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refresh(), SCAN_POLL_MS);
    return () => clearInterval(t);
  }, [active, refresh]);

  const runScan = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const s = await api.runScan(id, {});
      toast.success('Scan queued', { description: `Scan ${s.id} for ${project?.name ?? 'this project'}. The list updates as it runs.` });
      setConfirmRun(false);
      await refresh();
    } catch (e) {
      setConfirmRun(false);
      setRunError(e instanceof Error ? e.message : 'Could not start the scan.');
    } finally {
      setRunning(false);
    }
  };

  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, projectCrumb(project), { label: 'Scans' }];
  const firstLoad = list.loading && list.items.length === 0;
  const failed = list.error && list.items.length === 0 && !list.loading;
  const meta = !firstLoad && !failed ? `${fmtNum(list.total)} scan${list.total === 1 ? '' : 's'}${active ? ' · 1 in progress' : ''}` : undefined;

  const body = failed ? (
    <ErrorState error={list.error} onRetry={list.reload} />
  ) : (
    <DataTable<Scan>
      label="Scans"
      data={list.items}
      loading={firstLoad}
      columns={COLUMNS}
      getRowId={(r) => r.id}
      filterPlaceholder="Filter scans…"
      initialSorting={[{ id: 'createdAt', desc: true }]}
      total={list.total}
      toolbar={
        list.hasMore ? (
          <Button variant="outline" onClick={list.loadMore} disabled={list.loadingMore}>
            {list.loadingMore ? <Spinner role={undefined} aria-label={undefined} aria-hidden="true" /> : <History aria-hidden="true" />}
            {list.loadingMore ? 'Loading…' : 'Load older scans'}
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
                <FolderPlus aria-hidden="true" />
                New project
              </Button>
            )}
            {canRun && (
              <Button onClick={() => setConfirmRun(true)} disabled={running || active}>
                {running || active ? <Spinner role={undefined} aria-label={undefined} aria-hidden="true" /> : <Play aria-hidden="true" />}
                {running ? 'Starting…' : active ? 'Scan in progress' : 'Run scan'}
              </Button>
            )}
          </>
        }
      >
        <Badge variant="outline" className="font-normal text-muted-foreground">
          Read-only: nothing from the target is installed or executed
        </Badge>
      </PageHeader>
      {runError && (
        <div className="border-b px-4 py-3">
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Could not start the scan</AlertTitle>
            <AlertDescription>{runError}</AlertDescription>
          </Alert>
        </div>
      )}
      {list.error && list.items.length > 0 && (
        <div className="border-b px-4 py-3">
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Could not refresh the scan list</AlertTitle>
            <AlertDescription>{list.error.message}</AlertDescription>
          </Alert>
        </div>
      )}
      {body}
      {canRun && (
        <AlertDialog open={confirmRun} onOpenChange={(o) => !running && setConfirmRun(o)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Run a scan of {project?.name ?? 'this project'}?</AlertDialogTitle>
              <AlertDialogDescription>
                Blastradius reads the target&apos;s manifests and lockfiles and scores every component. Nothing from the target is installed or executed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={running}
                onClick={(e) => {
                  // Keep the dialog open until the request settles.
                  e.preventDefault();
                  void runScan();
                }}
              >
                {running && <Spinner role={undefined} aria-label={undefined} aria-hidden="true" />}
                {running ? 'Starting…' : 'Run scan'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {canCreate && (
        <CreateProjectDialog
          open={creating}
          onOpenChange={setCreating}
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
