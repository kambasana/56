/**
 * Incident (Detail template, docs/UX.md §8 flow 3): "are we hit, where, who brought it in, who
 * owns it". Header with severity, title and how long it has been open; StatusTrack
 * Investigating › Fixing › Monitoring › Closed (persisted); "Re-check all projects" and
 * "Notify owners" only when the server can do them, else disabled with the honest reason.
 * Counters, "Where it is" production first, and a typed timeline from recorded events.
 * Data: GET /api/incidents/:id.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import type { IncidentDetail as Detail, IncidentStatus } from '@server/api-types-incidents';
import { incidentsApi } from '@/api-incidents';
import { useAuth } from '@/auth';
import { behindPath, incidentPath, packagePath, projectPath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { INCIDENT_STEPS, NotAllowedHint, ReachTag, SeverityBadge, StateBlock, StatusTrack } from '@/components/br';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EventTimeline } from '@/components/viz/Timeline';
import { useApi } from '@/lib/useApi';
import { fmtTime } from '@/lib/cn';
import { safeHref } from '@/lib/safe-href';
import { cn } from '@/lib/utils';
import { incidentTitle, STATUS_LABEL } from './Incidents';

const STATUSES: IncidentStatus[] = ['investigating', 'fixing', 'monitoring', 'closed'];

/** "2 h 10 min", "3 d 4 h", "12 min", "under a minute". */
export function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

function Tile({ label, value, note, tone }: { label: string; value: number; note: string; tone?: 'alert' }) {
  return (
    <div className="rounded-xl border px-4 py-3.5">
      <div className="text-text-secondary">{label}</div>
      <div className="text-[28px] leading-[34px] font-semibold">
        {value} <span className={cn('text-body font-medium', tone === 'alert' ? 'text-destructive' : 'text-muted-foreground')}>{note}</span>
      </div>
    </div>
  );
}

function StatusControl({ d, onChange, busy }: { d: Detail; onChange: (s: IncidentStatus) => void; busy: boolean }) {
  const { can } = useAuth();
  const allowed = can('review');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusTrack steps={INCIDENT_STEPS} current={STATUS_LABEL[d.status]} label="Incident status" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2.5 text-label" disabled={!allowed || busy} aria-describedby={allowed ? undefined : 'status-hint'}>
            Set status
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={d.status} onValueChange={(v) => onChange(v as IncidentStatus)}>
            {STATUSES.map((s) => (
              <DropdownMenuRadioItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {!allowed && <NotAllowedHint id="status-hint" permission="review" />}
    </div>
  );
}

function Body({ d, setData }: { d: Detail; setData: (d: Detail) => void }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState<'status' | 'notify' | 'recheck' | null>(null);
  const canRecheck = can('manage_projects') || can('manage_alert_rules');
  const canNotify = can('send_to_destinations') || can('manage_alert_rules');
  const recheckReason = !canRecheck ? 'Needs the Manage projects or Alert rules permission: ask an admin.' : d.actions.recheck.reason;
  const notifyReason = !canNotify ? 'Needs the Send to destinations or Alert rules permission: ask an admin.' : d.actions.notify.reason;
  const notifiedByMe = d.timeline.some((e) => e.kind === 'notified' && /notified the owners/.test(e.title));

  const run = async <T,>(kind: 'status' | 'notify' | 'recheck', fn: () => Promise<T>, ok: (r: T) => void) => {
    setBusy(kind);
    try {
      ok(await fn());
    } catch (e) {
      toast.error('That did not work', { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const setStatus = (s: IncidentStatus) => run('status', () => incidentsApi.setIncidentStatus(d.id, { status: s }), (r) => setData(r));
  const notify = () =>
    run('notify', () => incidentsApi.notifyOwners(d.id), (r) => {
      setData(r.detail);
      toast.success('Owners notified', { description: r.owners.join(', ') });
    });
  const recheck = () =>
    run('recheck', () => incidentsApi.recheck(), async (r) => {
      toast.success(`${r.projectsChecked} projects checked`, { description: `${r.created.length} new ${r.created.length === 1 ? 'alert' : 'alerts'}, in ${r.ms} ms` });
      setData(await incidentsApi.incident(d.id));
    });

  const openFor = fmtDuration((d.closedAt ? Date.parse(d.closedAt) : Date.now()) - Date.parse(d.openedAt));
  const still = d.hits.filter((h) => !h.fixed);
  const projectsAffected = new Set(d.hits.map((h) => h.projectId)).size;

  return (
    <>
      <div className="flex flex-col gap-2.5 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {d.level ? <SeverityBadge level={d.level} size="md" /> : <span className="text-label text-muted-foreground">Not rated</span>}
          <span className="text-text-secondary">{d.status === 'closed' ? `Closed after ${openFor}` : `Open for ${openFor}`}</span>
          <span className="grow" />
          <div className="flex flex-col items-end gap-1">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="h-7 px-3 text-label" onClick={recheck} disabled={!!recheckReason || busy !== null} aria-describedby={recheckReason ? 'recheck-hint' : undefined}>
                Re-check all projects
              </Button>
              <Button size="sm" className="h-7 px-3 text-label" onClick={notify} disabled={!!notifyReason || busy !== null} aria-describedby={notifyReason ? 'notify-hint' : undefined}>
                {notifiedByMe ? 'Notify owners again' : d.owners.length ? `Notify ${d.owners.length} ${d.owners.length === 1 ? 'owner' : 'owners'}` : 'Notify owners'}
              </Button>
            </div>
          </div>
        </div>
        {(recheckReason || notifyReason) && (
          <div className="flex flex-col gap-0.5 text-label text-text-secondary">
            {recheckReason && <span id="recheck-hint">Re-check: {recheckReason}</span>}
            {notifyReason && <span id="notify-hint">Notify: {notifyReason}</span>}
          </div>
        )}
        <StatusControl d={d} onChange={setStatus} busy={busy !== null} />
      </div>

      <div className="flex flex-col lg:flex-row">
        <div className="flex min-w-0 grow flex-col gap-4 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile label="Projects affected" value={projectsAffected} note={d.production ? `${d.production} in production` : 'none in production'} tone={d.production ? 'alert' : undefined} />
            <Tile label="Projects checked" value={d.checked.projects} note={d.checked.at ? `all, ${fmtTime(d.checked.at)}` : 'latest scans'} />
            <Tile label="Fixed" value={d.fixed} note={`of ${d.affected}`} />
          </div>

          <section aria-labelledby="where" className="overflow-hidden rounded-xl border">
            <h2 id="where" className="m-0 border-b px-4 py-3 text-heading font-semibold">
              Where it is
            </h2>
            <div className="overflow-x-auto">
              <table aria-labelledby="where" className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-muted text-label text-text-secondary">
                    <th scope="col" className="px-4 py-2 font-medium">Project</th>
                    <th scope="col" className="px-2 py-2 font-medium">Environment</th>
                    <th scope="col" className="px-2 py-2 font-medium">Package</th>
                    <th scope="col" className="px-2 py-2 font-medium">Brought in by</th>
                    <th scope="col" className="px-2 py-2 font-medium">Owner</th>
                    <th scope="col" className="px-2 py-2 font-medium">Fix</th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      <span className="sr-only">Finding</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.hits.map((h) => (
                    <tr key={h.alertId} className="border-t">
                      <td className="px-4 py-2.5 font-medium">{h.projectName}</td>
                      <td className="px-2 py-2.5">
                        <ReachTag reach={h.production ? 'production' : 'dev'} />
                      </td>
                      <td className="px-2 py-2.5 font-mono text-[12px]">
                        {h.name}@{h.version}
                      </td>
                      <td className="px-2 py-2.5 font-mono text-[12px] text-text-secondary">{h.fixed ? '–' : h.broughtInBy.length ? h.broughtInBy.join(', ') : h.direct ? 'direct dependency' : '–'}</td>
                      <td className="px-2 py-2.5 text-text-secondary">{h.owner ?? 'No owner set'}</td>
                      <td className="px-2 py-2.5">{h.fixed ? <span className="font-medium text-success">✓ Gone from the latest scan</span> : 'Still present'}</td>
                      <td className="px-4 py-2.5 text-right">
                        {h.findingId && can('findings', h.projectId) ? (
                          <Link to={`${projectPath(h.projectId, 'findings')}/${encodeURIComponent(h.findingId)}`}>Open finding in {h.projectName}</Link>
                        ) : (
                          <span className="text-caption text-muted-foreground">{h.fixed ? 'No finding: fixed' : 'No finding in the latest scan'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="m-0 text-caption text-muted-foreground">
            Checked against stored inventories of {d.checked.projects} {d.checked.projects === 1 ? 'project' : 'projects'}. No re-scan was needed.
            {still.length > 0 && ` ${still.length} still ${still.length === 1 ? 'has' : 'have'} it.`}
          </p>
          <section aria-labelledby="pkgs" className="flex flex-col gap-1.5">
            <h2 id="pkgs" className="m-0 text-heading font-semibold">
              Packages
            </h2>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {d.packages.map((p) => (
                <li key={p.purl} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-[12px] font-medium">{p.version ? `${p.name}@${p.version}` : p.name}</span>
                  <Link to={packagePath(p.name, p.version)}>How far it spreads</Link>
                  <Link to={behindPath(p.name)}>Who's behind it</Link>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside aria-labelledby="tl" className="flex w-full shrink-0 flex-col gap-3 border-t p-4 lg:w-[340px] lg:border-t-0 lg:border-l">
          <h2 id="tl" className="m-0 text-heading font-semibold">
            Timeline
          </h2>
          <EventTimeline events={d.timeline} />
          <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 border-t pt-3 text-label">
            <dt className="text-muted-foreground">Advisory</dt>
            <dd className="m-0 font-mono">
              {safeHref(`https://osv.dev/vulnerability/${encodeURIComponent(d.advisoryId)}`) ? (
                <a href={`https://osv.dev/vulnerability/${encodeURIComponent(d.advisoryId)}`} target="_blank" rel="noreferrer noopener">
                  {d.advisoryId}
                </a>
              ) : (
                d.advisoryId
              )}
            </dd>
            <dt className="text-muted-foreground">Published</dt>
            <dd className="m-0">{d.advisoryPublished ? fmtTime(d.advisoryPublished) : 'Not stated'}</dd>
            <dt className="text-muted-foreground">First seen here</dt>
            <dd className="m-0">{fmtTime(d.openedAt)}</dd>
          </dl>
        </aside>
      </div>
    </>
  );
}

export default function IncidentDetail() {
  const { me } = useAuth();
  const id = useParams().incidentId ?? '';
  const { data, error, loading, reload } = useApi((s) => incidentsApi.incident(id, s), [id]);
  const [override, setOverride] = useState<Detail | null>(null);
  const d = override && override.id === id ? override : data;
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Incidents', to: '/incidents' },
    { label: id, to: incidentPath(id) },
  ];
  const title = d ? (
    <>
      <span className="font-mono font-medium">{incidentTitle(d)}</span>
      <span className="font-normal"> · {d.summary ?? `${d.advisoryId}`}</span>
    </>
  ) : (
    <span className="font-mono">{id}</span>
  );
  return (
    <>
      <PageHeader crumbs={crumbs} title={title} meta={d ? d.advisoryId : undefined} />
      {loading && !d && (
        <div className="p-4">
          <StateBlock kind="loading" label="Loading the incident" rows={4} columns={5} />
        </div>
      )}
      {error && !d && (
        <div className="p-4">
          <StateBlock kind="error" title="Could not load this incident" cause={error.message} onRetry={reload} actions={[{ label: 'All incidents', to: '/incidents' }]} />
        </div>
      )}
      {d && <Body d={d} setData={setOverride} />}
    </>
  );
}
