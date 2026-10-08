/**
 * Incidents: every advisory that hit a package your projects use, one row per package and
 * advisory, production first, each opening the package page ("are we hit?"). Built from the
 * stored alerts (GET /api/alerts). Stage 2 adds the Incident page with owners and status.
 */
import { useMemo } from 'react';
import { Link } from 'react-router';
import type { AlertItem } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { packagePath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { ReachTag, StateBlock } from '@/components/br';
import { useCommandPalette } from '@/components/CommandPalette';
import { useApi } from '@/lib/useApi';
import { fmtTime } from '@/lib/cn';

export interface IncidentRow {
  key: string;
  advisoryId: string;
  name: string;
  version: string | null;
  projects: string[];
  production: number;
  firstSeen: string;
}

/** "pkg:npm/%40scope/name@1.0.0" → { name: "@scope/name", version: "1.0.0" }. */
export function purlParts(purl: string): { name: string; version: string | null } {
  const body = decodeURIComponent(purl.replace(/^pkg:[^/]+\//, ''));
  const at = body.lastIndexOf('@');
  return at > 0 ? { name: body.slice(0, at), version: body.slice(at + 1) } : { name: body, version: null };
}

/** Alerts grouped per advisory and package, production first, then most projects. */
export function groupIncidents(alerts: readonly AlertItem[]): IncidentRow[] {
  const map = new Map<string, IncidentRow & { prodSet: Set<string> }>();
  for (const a of alerts) {
    const key = `${a.advisoryId} ${a.purl}`;
    const { name, version } = purlParts(a.purl);
    const row = map.get(key) ?? { key, advisoryId: a.advisoryId, name, version, projects: [], production: 0, firstSeen: a.createdAt, prodSet: new Set<string>() };
    if (!row.projects.includes(a.projectName)) row.projects.push(a.projectName);
    if (a.production) row.prodSet.add(a.projectId);
    row.production = row.prodSet.size;
    if (a.createdAt < row.firstSeen) row.firstSeen = a.createdAt;
    map.set(key, row);
  }
  return [...map.values()]
    .map(({ prodSet: _p, ...r }) => r)
    .sort((a, b) => b.production - a.production || b.projects.length - a.projects.length || a.name.localeCompare(b.name));
}

export default function Incidents() {
  const { me } = useAuth();
  const { setOpen } = useCommandPalette();
  const { data, error, loading, reload } = useApi((s) => api.alerts(s), []);
  const rows = useMemo(() => groupIncidents(data?.items ?? []), [data]);
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Incidents', to: '/incidents' },
  ];

  let body;
  if (loading && !data) body = <StateBlock kind="loading" label="Loading incidents" rows={4} columns={4} />;
  else if (error && !data) body = <StateBlock kind="error" title="Could not load incidents" cause={error.message} onRetry={reload} />;
  else if (rows.length === 0)
    body = (
      <StateBlock
        kind="all-clear"
        title="No incidents"
        description="No new advisory names a package your projects use. Each new advisory is checked against every project's latest scan."
        actions={[{ label: 'Is a package anywhere? (⌘K)', onClick: () => setOpen(true) }]}
      />
    );
  else
    body = (
      <div className="overflow-hidden rounded-xl border">
        <ul aria-label="Incidents" className="m-0 flex list-none flex-col divide-y p-0">
          {rows.map((r) => (
            <li key={r.key}>
              <Link to={packagePath(r.name, r.version)} data-slot="incident-row" className="flex flex-col gap-1 px-4 py-2.5 text-foreground no-underline hover:bg-accent hover:no-underline">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12px] font-medium">{r.version ? `${r.name}@${r.version}` : r.name}</span>
                  <span className="text-label text-text-secondary">{r.advisoryId}</span>
                  {r.production > 0 && <ReachTag reach="production" count={r.production} />}
                  <span className="ml-auto text-caption text-muted-foreground">first seen {fmtTime(r.firstSeen)}</span>
                </span>
                <span className="text-caption text-muted-foreground">
                  {r.projects.length} {r.projects.length === 1 ? 'project' : 'projects'}: {r.projects.join(', ')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <>
      <PageHeader crumbs={crumbs} title="Incidents" meta={data ? `${rows.length} open` : undefined} />
      <div className="flex max-w-5xl flex-col gap-4 p-4">{body}</div>
    </>
  );
}
