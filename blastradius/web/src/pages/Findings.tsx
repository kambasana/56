/**
 * Findings (List template, docs/UX.md §3–4): every finding in the latest scan of every project the
 * viewer can see, or of one project at /projects/:id/findings. Scope bar → promoted filter chips
 * plus "All filters" → applied-filter row → one table → floating bulk bar, with a peek sheet for
 * quick triage. Grouping (By package / By project), filters, sort, paging and the open sheet all
 * live in the URL, so Back returns to the same view and scroll position.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import type { FindingStatus, ListOrgFindingsQuery, OrgFindingSort, UpdateFindingStatusRequest } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { projectCrumb } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import {
  AppliedFilters,
  BulkBar,
  FilterChips,
  needsPermissionText,
  PeekSheet,
  ReachTag,
  ScopeBar,
  SeverityBadge,
  StateBlock,
  appliedList,
  useFilters,
  useJK,
  usePeek,
  useScope,
  useUpdateParams,
  type FilterDef,
  type QuickFilter,
  type StateAction,
} from '@/components/br';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/useApi';
import { fmtNum } from '@/lib/cn';
import { cn } from '@/lib/utils';
import { HealthTable } from './d-parts/HealthTable';
import { StatusBadge } from './d-parts/ui';
import { FindingPeekBody } from './a-parts/FindingPeek';
import { commonOwner, commonStatus, findingHref, rowsFromFindings, rowsFromGroups, type ListRow } from './a-parts/rows';
import { AcceptRiskDialog, introducedText, relTime, STATUS_LABELS, TriageFields, useAssignees, useTriagePerms } from './a-parts/triage';
import { useScrollMemory } from './a-parts/useScrollMemory';

const PAGE = 50;

/** Filters (one URL param each; OR within, AND across). Module level: stable identity. */
const BASE_FILTERS: FilterDef[] = [
  {
    key: 'severity',
    label: 'Severity',
    options: [
      { value: 'critical', label: 'Critical' },
      { value: 'high', label: 'High' },
      { value: 'medium', label: 'Medium' },
      { value: 'low', label: 'Low' },
    ],
  },
  {
    key: 'reach',
    label: 'Reach',
    info: 'Production: a dependency path reaches a production asset. Dev and test: only dev, test or CI assets.',
    options: [
      { value: 'production', label: 'In production' },
      { value: 'dev', label: 'Dev and test only' },
    ],
  },
  {
    key: 'status',
    label: 'Status',
    options: [
      { value: 'new', label: 'Open' },
      { value: 'reviewed', label: 'Triaged' },
      { value: 'fixing', label: 'Fixing' },
      { value: 'resolved', label: 'Resolved' },
      { value: 'accepted_risk', label: 'Accepted risk' },
    ],
  },
  { key: 'new', label: 'First seen', options: [{ value: 'week', label: 'This week' }] },
];

const QUICK: QuickFilter[] = [
  { label: 'Critical', key: 'severity', value: 'critical' },
  { label: 'In production', key: 'reach', value: 'production' },
  { label: 'New this week', key: 'new', value: 'week' },
  { label: 'Unassigned', key: 'owner', value: 'none' },
];

const SORTS: readonly OrgFindingSort[] = ['-score', 'score', 'name', 'reach', '-firstSeen', 'firstSeen'];

type Group = 'package' | 'project';

/** "?…" of the current params without paging and peek (for links between list views). */
function listSearch(sp: URLSearchParams, drop: readonly string[] = []): string {
  const q = new URLSearchParams(sp);
  for (const k of ['peek', 'shown', ...drop]) q.delete(k);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Start of the "new this week" window, fixed for the life of the page so the query is stable. */
function useWeekAgo(): string {
  const [at] = useState(() => new Date(Math.floor((Date.now() - 7 * 86_400_000) / 60_000) * 60_000).toISOString());
  return at;
}

function SortHeader({ label, asc, desc, sort, onSort, className }: { label: string; asc: OrgFindingSort; desc: OrgFindingSort; sort: OrgFindingSort; onSort: (s: OrgFindingSort) => void; className?: string }) {
  const state = sort === desc ? 'descending' : sort === asc ? 'ascending' : 'none';
  return (
    <th scope="col" aria-sort={state} className={cn('px-2 py-2 text-left text-label font-medium text-text-secondary', className)}>
      <button type="button" className="inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={() => onSort(sort === desc ? asc : desc)}>
        {label}
        {state === 'descending' && <ArrowDown aria-hidden="true" className="size-3" />}
        {state === 'ascending' && <ArrowUp aria-hidden="true" className="size-3" />}
      </button>
    </th>
  );
}

function OwnerCell({ row }: { row: ListRow }) {
  const id = commonOwner(row);
  if (id === null) return <span className="text-muted-foreground">Mixed</span>;
  const owner = row.findings[0]!.owner;
  return owner ? <span>{owner.name}</span> : <span className="text-muted-foreground">—</span>;
}

function StatusCell({ row }: { row: ListRow }) {
  const s = commonStatus(row);
  if (s === null) return <span className="text-label text-muted-foreground">Mixed ({new Set(row.findings.map((f) => f.status)).size})</span>;
  return <StatusBadge status={s} />;
}

function ProjectsCell({ row }: { row: ListRow }) {
  if (row.kind === 'finding') {
    const f = row.primary;
    return (
      <span className="flex flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{f.projectName}</span>
          <ReachTag reach={f.production ? 'production' : 'dev'} count={f.production ? 1 : undefined} />
        </span>
        {row.projects > 1 && <span className="text-caption text-muted-foreground">in {row.projects} projects</span>}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span>
        {row.projects} {row.projects === 1 ? 'project' : 'projects'}
      </span>
      {row.prodProjects > 0 ? <ReachTag reach="production" count={row.prodProjects} /> : <span className="text-caption text-muted-foreground">dev only</span>}
    </span>
  );
}

const bulkBtn = 'h-7 rounded-lg bg-primary-foreground/15 px-2.5 text-label text-primary-foreground outline-none hover:bg-primary-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-60 inline-flex items-center gap-1';

export default function Findings() {
  const { id: routeProject } = useParams();
  const projectScoped = routeProject !== undefined;
  const { me, can } = useAuth();
  const { project, projects } = useProject();
  const [sp] = useSearchParams();
  const update = useUpdateParams();
  const [scope] = useScope();
  const people = useAssignees();
  const weekAgo = useWeekAgo();

  const filters = useMemo<FilterDef[]>(
    () => [...BASE_FILTERS, { key: 'owner', label: 'Owner', options: [{ value: 'none', label: 'Unassigned' }, ...people.map((p) => ({ value: p.id, label: p.name }))] }],
    [people],
  );
  const { values } = useFilters(filters);
  const group: Group = projectScoped ? 'project' : sp.get('group') === 'project' ? 'project' : 'package';
  const sortParam = sp.get('sort');
  const sort: OrgFindingSort = sortParam && (SORTS as readonly string[]).includes(sortParam) ? (sortParam as OrgFindingSort) : '-score';
  const shown = Math.min(500, Math.max(PAGE, Number(sp.get('shown')) || PAGE));
  const q = sp.get('q') ?? '';
  const view = projectScoped && sp.get('view') === 'health' ? 'health' : 'findings';

  // Reach chips narrow the scope's environment; a contradiction matches nothing.
  const reach = values.reach ?? [];
  const envFromReach = reach.length === 1 ? (reach[0] === 'production' ? 'prod' : 'dev') : null;
  const scopeEnv = scope.env === 'all' ? null : scope.env;
  const contradiction = envFromReach !== null && scopeEnv !== null && envFromReach !== scopeEnv;
  const env = envFromReach ?? scopeEnv ?? undefined;

  const base: ListOrgFindingsQuery = {
    projects: projectScoped ? routeProject : scope.projects.join(',') || undefined,
    env: env ?? undefined,
    level: values.severity?.join(','),
    status: values.status?.join(','),
    owner: values.owner?.join(','),
    since: values.new?.includes('week') ? weekAgo : undefined,
    q: q || undefined,
    sort,
  };
  const baseKey = JSON.stringify([group, base]);
  const { data, error, loading, reload } = useApi(
    (signal) =>
      contradiction
        ? Promise.resolve({ rows: [] as ListRow[], total: 0, scanned: -1 })
        : group === 'package'
          ? api.packageFindings({ ...base, limit: shown }, signal).then((r) => ({ rows: rowsFromGroups(r.items), total: r.total, scanned: r.scannedProjects }))
          : api.orgFindings({ ...base, limit: shown }, signal).then((r) => ({ rows: rowsFromFindings(r.items), total: r.total, scanned: r.scannedProjects })),
    [baseKey, shown, contradiction],
  );
  // Keep the loaded rows on screen while "Load more" fetches a longer page.
  const [kept, setKept] = useState<{ key: string; value: NonNullable<typeof data> } | null>(null);
  useEffect(() => {
    if (data) setKept({ key: baseKey, value: data });
  }, [data, baseKey]);
  const shownData = data ?? (kept && kept.key === baseKey ? kept.value : null);
  const rows = useMemo(() => shownData?.rows ?? [], [shownData]);

  const health = useApi((s) => (projectScoped ? api.projectHealth(routeProject, s) : Promise.resolve(null)), [routeProject, projectScoped]);

  // Selection (cleared whenever the list changes).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<string | undefined>(undefined);
  useEffect(() => {
    setSelected(new Set());
    setBulkStatus(undefined);
  }, [baseKey]);
  const selectedRows = rows.filter((r) => selected.has(r.key));
  const selectedFindings = selectedRows.flatMap((r) => r.findings);
  const selectedProjects = [...new Set(selectedFindings.map((f) => f.projectId))];
  const perms = useTriagePerms(selectedProjects);
  const [riskOpen, setRiskOpen] = useState(false);

  const peek = usePeek();
  const ids = useMemo(() => rows.map((r) => r.key), [rows]);
  useJK({ ids, current: peek.id, onMove: peek.open, enabled: peek.id !== null });
  const peekRow = rows.find((r) => r.key === peek.id) ?? null;

  useScrollMemory(!!shownData);

  const runBulk = async (change: UpdateFindingStatusRequest, done: string) => {
    try {
      const res = await api.bulkUpdateFindings({ ids: selectedFindings.map((f) => f.id), ...change });
      setBulkStatus(`${res.updated} ${done}`);
      reload();
    } catch (e) {
      setBulkStatus(e instanceof Error ? e.message : 'The change failed.');
      throw e;
    }
  };

  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.key));

  const onSort = useCallback((s: OrgFindingSort) => update({ sort: s === '-score' ? null : s, shown: null }), [update]);

  // ---- header ----
  const crumbs = projectScoped
    ? [{ label: me?.org?.name ?? 'Organization', to: '/' }, projectCrumb(project), { label: 'Findings' }]
    : [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: 'Findings' }];
  const unit = group === 'package' ? (shownData?.total === 1 ? 'package' : 'packages') : shownData?.total === 1 ? 'finding' : 'findings';
  const count = shownData ? `${fmtNum(shownData.total)} ${unit}${shownData.total > rows.length ? ` · showing ${fmtNum(rows.length)}` : ''}` : undefined;

  const groupToggle = !projectScoped && (
    <div role="group" aria-label="Group by" className="inline-flex rounded-lg bg-muted p-0.5">
      {(['package', 'project'] as const).map((g) => (
        <button
          key={g}
          type="button"
          aria-pressed={group === g}
          onClick={() => update({ group: g === 'package' ? null : g, shown: null, peek: null })}
          className={cn(
            'h-6 rounded-md px-2.5 text-label outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            group === g ? 'bg-background font-semibold text-foreground shadow-elev-1' : 'text-text-secondary hover:text-foreground',
          )}
        >
          {g === 'package' ? 'By package' : 'By project'}
        </button>
      ))}
    </div>
  );

  // ---- states inside the table frame ----
  const applied = appliedList(values, filters);
  const noResultActions: StateAction[] = [
    ...applied.slice(0, 3).map((a) => ({ label: `Remove "${a.text}"`, onClick: () => update({ [a.key]: (values[a.key] ?? []).filter((v) => v !== a.value), shown: null }) })),
    ...(q ? [{ label: `Clear the search "${q}"`, onClick: () => update({ q: null, shown: null }) }] : []),
    ...(projectScoped ? [{ label: 'Search all projects', to: `/findings${listSearch(sp, ['view'])}` }] : scope.projects.length > 0 ? [{ label: 'Search all projects', onClick: () => update({ projects: null, shown: null }) }] : []),
    ...(contradiction ? [{ label: 'Production and dev', onClick: () => update({ env: null }) }] : []),
  ];
  const filtered = applied.length > 0 || !!q || contradiction;

  let stateBlock: React.ReactNode = null;
  if (!shownData && loading) stateBlock = <StateBlock kind="loading" label="Loading findings" rows={6} columns={6} className="rounded-none border-0" />;
  else if (error && !shownData) stateBlock = <StateBlock kind="error" title="Could not load findings" cause={error.message} onRetry={reload} className="m-3" />;
  else if (shownData && shownData.scanned === 0)
    stateBlock = (
      <StateBlock
        kind="no-results"
        className="m-3"
        title="No completed scan yet"
        description="Findings appear after a project's first successful scan."
        actions={[projectScoped && can('scans', routeProject) ? { label: 'Go to Scans', to: `/projects/${encodeURIComponent(routeProject)}/scans` } : { label: 'Open Projects', to: '/projects' }]}
      />
    );
  else if (shownData && rows.length === 0 && filtered)
    stateBlock = <StateBlock kind="no-results" className="m-3" title={`No ${group === 'package' ? 'packages' : 'findings'} match these filters`} actions={noResultActions} />;
  else if (shownData && rows.length === 0)
    stateBlock = (
      <StateBlock
        kind="all-clear"
        className="m-3"
        title={projectScoped ? `No findings in ${project?.name ?? 'this project'}` : 'No findings'}
        description={`The latest scan of ${shownData.scanned === 1 ? '1 project' : `${shownData.scanned} projects`} found nothing above the reporting threshold.`}
      />
    );

  const table = (
    <div className="overflow-hidden rounded-xl border">
      <div className="overflow-x-auto">
        <table aria-label="Findings" className="w-full border-collapse text-body">
          <thead className="bg-muted">
            <tr>
              <th scope="col" className="w-9 px-3 py-2">
                <Checkbox aria-label="Select all shown" checked={allOn} disabled={rows.length === 0} onCheckedChange={(on) => setSelected(on === true ? new Set(rows.map((r) => r.key)) : new Set())} />
              </th>
              <SortHeader label="Severity" desc="-score" asc="score" sort={sort} onSort={onSort} className="w-28" />
              <SortHeader label="Package" desc="name" asc="name" sort={sort} onSort={onSort} />
              <SortHeader label="Projects" desc="reach" asc="reach" sort={sort} onSort={onSort} className="w-44" />
              <th scope="col" className="hidden px-2 py-2 text-left text-label font-medium text-text-secondary md:table-cell">
                Introduced by
              </th>
              <SortHeader label="First seen" desc="-firstSeen" asc="firstSeen" sort={sort} onSort={onSort} className="hidden w-28 md:table-cell" />
              <th scope="col" className="w-32 px-2 py-2 text-left text-label font-medium text-text-secondary">
                Status
              </th>
              <th scope="col" className="hidden w-36 px-3 py-2 text-left text-label font-medium text-text-secondary lg:table-cell">
                Owner
              </th>
            </tr>
          </thead>
          <tbody>
            {stateBlock ? (
              <tr>
                <td colSpan={8} className="p-0">
                  {stateBlock}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const on = selected.has(r.key);
                const open = peek.id === r.key;
                return (
                  <tr
                    key={r.key}
                    data-row-key={r.key}
                    aria-selected={on}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button,a,input,[role=checkbox]')) return;
                      peek.open(r.key);
                    }}
                    className={cn('cursor-pointer border-t align-top hover:bg-accent/60', open ? 'bg-selection-soft' : on ? 'bg-accent' : undefined)}
                  >
                    <td className="px-3 py-2.5">
                      <Checkbox aria-label={`Select ${r.name}@${r.version}${r.kind === 'finding' ? ` in ${r.primary.projectName}` : ''}`} checked={on} onCheckedChange={(v) => toggle(r.key, v === true)} />
                    </td>
                    <td className="px-2 py-2.5">
                      <SeverityBadge level={r.level} variant="plain" />
                    </td>
                    <td className="max-w-[420px] px-2 py-2">
                      <button type="button" onClick={() => peek.open(r.key)} className="flex max-w-full flex-col items-start rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                        <span className="font-mono text-[12px] font-medium text-foreground">
                          {r.name}@{r.version}
                        </span>
                        <span className="line-clamp-1 text-caption text-muted-foreground">{r.sub || '—'}</span>
                      </button>
                    </td>
                    <td className="px-2 py-2.5">
                      <ProjectsCell row={r} />
                    </td>
                    <td className="hidden px-2 py-2.5 font-mono text-[12px] text-text-secondary md:table-cell">{introducedText(r.introducedBy)}</td>
                    <td className="hidden px-2 py-2.5 text-text-secondary md:table-cell" title={r.firstSeenAt}>
                      {relTime(r.firstSeenAt)}
                    </td>
                    <td className="px-2 py-2.5">
                      <StatusCell row={r} />
                    </td>
                    <td className="hidden px-3 py-2.5 text-text-secondary lg:table-cell">
                      <OwnerCell row={r} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {shownData && rows.length > 0 && shownData.total > rows.length && (
        <div className="flex items-center justify-center border-t p-2">
          <button
            type="button"
            className="inline-flex h-7 items-center rounded-lg border border-input bg-background px-3 text-label hover:bg-accent disabled:opacity-60"
            disabled={loading}
            onClick={() => update({ shown: String(Math.min(500, shown + PAGE)) })}
          >
            {loading ? 'Loading…' : `Load ${Math.min(PAGE, shownData.total - rows.length)} more`}
          </button>
        </div>
      )}
    </div>
  );

  const listBody = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <ScopeBar projects={projects} showRange={false} showProjects={!projectScoped} />
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <FilterChips filters={filters} quick={QUICK} />
        <Input
          type="search"
          aria-label="Search findings by package or reason"
          placeholder="Search package or reason"
          defaultValue={q}
          key={q}
          onKeyDown={(e) => {
            if (e.key === 'Enter') update({ q: (e.target as HTMLInputElement).value.trim() || null, shown: null });
          }}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== q) update({ q: v || null, shown: null }, { replace: true });
          }}
          className="ml-auto h-7 w-56"
        />
      </div>
      <AppliedFilters filters={filters} count={count} className="min-h-6" />
      {table}
    </div>
  );

  // ---- bulk bar ----
  const noReview = selectedProjects.length > 0 && !perms.review ? needsPermissionText('review') : undefined;
  const noRisk = selectedProjects.length > 0 && !perms.acceptRisk ? needsPermissionText('accept_risk') : undefined;
  const bulkMenu = (label: string, items: { label: string; onSelect: () => void }[], heading: string) =>
    noReview ? (
      <button type="button" className={bulkBtn} disabled title={noReview}>
        {label}
        <span className="sr-only"> ({noReview})</span>
      </button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={bulkBtn}>
            {label}
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{heading}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {items.map((it) => (
            <DropdownMenuItem key={it.label} onSelect={it.onSelect}>
              {it.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  const statusItems = (['new', 'reviewed', 'fixing', 'resolved'] as FindingStatus[]).map((s) => ({
    label: STATUS_LABELS[s],
    onSelect: () => void runBulk({ status: s }, `set to ${STATUS_LABELS[s]}`).catch(() => {}),
  }));
  const assignItems = [
    { label: 'Unassigned', onSelect: () => void runBulk({ ownerId: null }, 'unassigned').catch(() => {}) },
    ...people.map((p) => ({ label: p.name, onSelect: () => void runBulk({ ownerId: p.id }, `assigned to ${p.name}`).catch(() => {}) })),
  ];

  const sheet = (
    <PeekSheet
      open={peek.id !== null}
      onClose={peek.close}
      title={
        peekRow ? (
          <>
            <SeverityBadge level={peekRow.level} />
            <span className="font-mono text-[15px] font-medium">
              {peekRow.name}@{peekRow.version}
            </span>
          </>
        ) : (
          'Finding'
        )
      }
      description={peekRow?.reason ?? (peekRow ? undefined : 'This row is not in the list shown. Close and pick another row.')}
      fullPageHref={peekRow ? findingHref(peekRow.primary) : undefined}
    >
      {peekRow && (
        <div className="flex flex-col gap-4">
          <FindingPeekBody row={peekRow} />
          <TriageFields
            key={peekRow.key}
            projectIds={[...new Set(peekRow.findings.map((f) => f.projectId))]}
            status={commonStatus(peekRow)}
            ownerId={commonOwner(peekRow)}
            count={peekRow.findings.length}
            onChange={async (change) => {
              if (peekRow.findings.length === 1) await api.updateFindingStatus(peekRow.primary.id, change);
              else await api.bulkUpdateFindings({ ids: peekRow.findings.map((f) => f.id), ...change });
              reload();
            }}
          />
        </div>
      )}
    </PeekSheet>
  );

  return (
    <>
      <PageHeader crumbs={crumbs} title="Findings">
        {groupToggle}
      </PageHeader>
      <div className="flex flex-col gap-3 p-4 pb-24">
        {projectScoped ? (
          <Tabs value={view} onValueChange={(v) => update({ view: v === 'health' ? 'health' : null, peek: null })} className="gap-3">
            <TabsList>
              <TabsTrigger value="findings">Findings{shownData ? ` (${fmtNum(shownData.total)})` : ''}</TabsTrigger>
              <TabsTrigger value="health" title="Maintenance signals only (no provenance, single maintainer, weak posture, unmaintained). Not counted as risk.">
                Maintenance{health.data ? ` (${fmtNum(health.data.items.length)})` : ''}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="findings">{listBody}</TabsContent>
            <TabsContent value="health">
              {health.error ? <StateBlock kind="error" title="Could not load maintenance signals" cause={health.error.message} onRetry={health.reload} /> : <HealthTable items={health.data?.items ?? []} loading={health.loading && !health.data} />}
            </TabsContent>
          </Tabs>
        ) : (
          listBody
        )}
      </div>
      {sheet}
      <BulkBar
        count={selectedRows.length}
        onClear={() => setSelected(new Set())}
        status={bulkStatus}
        actions={[
          bulkMenu('Set status', statusItems, `Set status of ${selectedFindings.length} ${selectedFindings.length === 1 ? 'finding' : 'findings'}`),
          bulkMenu('Assign', assignItems, 'Assign to'),
          { label: 'Accept risk…', onSelect: () => setRiskOpen(true), disabledReason: noRisk },
          { label: 'Create ticket', onSelect: () => {}, disabledReason: 'No ticket system is connected yet: tickets need a Jira or GitHub Issues connection.' },
        ]}
      />
      <AcceptRiskDialog open={riskOpen} onOpenChange={setRiskOpen} count={selectedFindings.length} onConfirm={(note, expiresAt) => runBulk({ status: 'accepted_risk', note, expiresAt }, 'accepted as risk')} />
    </>
  );
}
