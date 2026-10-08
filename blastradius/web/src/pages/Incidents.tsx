/**
 * Incidents (List template, docs/UX.md §3): one row per advisory that hit at least one project,
 * open first, production first. Scope bar → filter chips → applied filters → table; a row opens
 * the Incident page (/incidents/:id). Data: GET /api/incidents.
 */
import { useMemo } from 'react';
import { Link } from 'react-router';
import type { IncidentRow, IncidentStatus } from '@server/api-types-incidents';
import { incidentsApi } from '@/api-incidents';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { incidentPath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { AppliedFilters, applyFilters, FilterChips, ReachTag, ScopeBar, SeverityBadge, StateBlock, useFilters, useScope, type FilterDef, type QuickFilter } from '@/components/br';
import { useCommandPalette } from '@/components/CommandPalette';
import { useApi } from '@/lib/useApi';
import { fmtTime } from '@/lib/cn';
import { cn } from '@/lib/utils';

export const STATUS_LABEL: Record<IncidentStatus, string> = { investigating: 'Investigating', fixing: 'Fixing', monitoring: 'Monitoring', closed: 'Closed' };

const FILTERS: FilterDef[] = [
  { key: 'status', label: 'Status', options: (Object.keys(STATUS_LABEL) as IncidentStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })) },
  {
    key: 'severity',
    label: 'Severity',
    options: [
      { value: 'critical', label: 'Critical' },
      { value: 'high', label: 'High' },
      { value: 'medium', label: 'Medium' },
      { value: 'low', label: 'Low' },
      { value: 'unknown', label: 'Not rated' },
    ],
  },
  { key: 'reach', label: 'Reach', options: [{ value: 'production', label: 'In production' }, { value: 'dev', label: 'Dev and test only' }], info: 'Production: a production part of a project uses it through runtime dependencies.' },
  { key: 'fix', label: 'Fix', options: [{ value: 'open', label: 'Still present somewhere' }, { value: 'fixed', label: 'Fixed everywhere' }] },
];
const QUICK: QuickFilter[] = [
  { label: 'Critical', key: 'severity', value: 'critical' },
  { label: 'In production', key: 'reach', value: 'production' },
  { label: 'Still present', key: 'fix', value: 'open' },
  { label: 'Closed', key: 'status', value: 'closed' },
];

export function incidentTitle(r: Pick<IncidentRow, 'packages' | 'advisoryId'>): string {
  const first = r.packages[0];
  if (!first) return r.advisoryId;
  const name = first.version ? `${first.name}@${first.version}` : first.name;
  return r.packages.length > 1 ? `${name} and ${r.packages.length - 1} more` : name;
}

/** Filter value(s) of a row for a key (see FILTERS). */
export function incidentFacet(r: IncidentRow, key: string): string | null {
  switch (key) {
    case 'status':
      return r.status;
    case 'severity':
      return r.level ?? 'unknown';
    case 'reach':
      return r.production > 0 ? 'production' : 'dev';
    case 'fix':
      return r.fixed >= r.affected ? 'fixed' : 'open';
    default:
      return null;
  }
}

export default function Incidents() {
  const { me } = useAuth();
  const { projects } = useProject();
  const { setOpen } = useCommandPalette();
  const [scope, setScope] = useScope();
  const filters = useFilters(FILTERS);
  const { data, error, loading, reload } = useApi((s) => incidentsApi.incidents(s), []);
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Incidents', to: '/incidents' },
  ];

  const scoped = useMemo(() => {
    let rows = data?.items ?? [];
    if (scope.projects.length) {
      const names = new Set(projects.filter((p) => scope.projects.includes(p.id)).map((p) => p.name));
      rows = rows.filter((r) => r.projects.some((n) => names.has(n)));
    }
    if (scope.env === 'prod') rows = rows.filter((r) => r.production > 0);
    if (scope.env === 'dev') rows = rows.filter((r) => r.production < r.affected);
    return rows;
  }, [data, scope.projects, scope.env, projects]);
  const rows = useMemo(() => applyFilters(scoped, filters.values, incidentFacet), [scoped, filters.values]);
  const open = (data?.items ?? []).filter((r) => r.status !== 'closed').length;

  let body;
  if (loading && !data) body = <StateBlock kind="loading" label="Loading incidents" rows={4} columns={6} />;
  else if (error && !data) body = <StateBlock kind="error" title="Could not load incidents" cause={error.message} onRetry={reload} />;
  else if ((data?.items.length ?? 0) === 0)
    body = (
      <StateBlock
        kind="all-clear"
        title="No incidents"
        description="No advisory names a package your projects use. Each new advisory is checked against every project's latest scan."
        actions={[{ label: 'Is a package anywhere? (⌘K)', onClick: () => setOpen(true) }]}
      />
    );
  else if (rows.length === 0)
    body = (
      <StateBlock
        kind="no-results"
        title="No incident matches these filters"
        actions={[
          ...(filters.count ? [{ label: 'Clear all filters', onClick: filters.clearAll }] : []),
          ...(scope.projects.length || scope.env !== 'all' ? [{ label: 'Search all projects', onClick: () => setScope({ projects: [], env: 'all' }) }] : []),
        ]}
      />
    );
  else
    body = (
      <table aria-label="Incidents" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-4 py-2 font-medium">Severity</th>
            <th scope="col" className="px-2 py-2 font-medium">Incident</th>
            <th scope="col" className="px-2 py-2 font-medium">Projects</th>
            <th scope="col" className="px-2 py-2 font-medium">Status</th>
            <th scope="col" className="px-2 py-2 font-medium">Fixed</th>
            <th scope="col" className="px-4 py-2 font-medium">Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-slot="incident-row" className={cn('border-t hover:bg-accent', r.status === 'closed' && 'text-text-secondary')}>
              <td className="px-4 py-2.5 align-top">{r.level ? <SeverityBadge level={r.level} variant="plain" /> : <span className="text-label text-muted-foreground">Not rated</span>}</td>
              <td className="px-2 py-2.5 align-top">
                <Link to={incidentPath(r.id)} className="flex flex-col text-foreground">
                  <span className="font-mono text-[12px] font-medium">{incidentTitle(r)}</span>
                  <span className="text-caption text-muted-foreground">
                    {r.advisoryId}
                    {r.summary ? ` · ${r.summary}` : ''}
                  </span>
                </Link>
              </td>
              <td className="px-2 py-2.5 align-top">
                <span className="flex flex-wrap items-center gap-1.5">
                  {r.affected} {r.affected === 1 ? 'project' : 'projects'}
                  {r.production > 0 && <ReachTag reach="production" count={r.production} />}
                </span>
                <span className="block max-w-64 truncate text-caption text-muted-foreground" title={r.projects.join(', ')}>
                  {r.projects.join(', ')}
                </span>
              </td>
              <td className="px-2 py-2.5 align-top text-label">{STATUS_LABEL[r.status]}</td>
              <td className="px-2 py-2.5 align-top text-label">
                {r.fixed} of {r.affected}
              </td>
              <td className="px-4 py-2.5 align-top text-caption text-muted-foreground">{fmtTime(r.openedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <>
      <PageHeader crumbs={crumbs} title="Incidents" meta={data ? `${open} open` : undefined} />
      <div className="flex max-w-6xl flex-col gap-3 p-4">
        <ScopeBar projects={projects} showRange={false} />
        <FilterChips filters={FILTERS} quick={QUICK} />
        <AppliedFilters filters={FILTERS} count={data ? `${rows.length} of ${data.items.length} incidents` : undefined} />
        <div className="overflow-x-auto rounded-xl border">{body}</div>
      </div>
    </>
  );
}
