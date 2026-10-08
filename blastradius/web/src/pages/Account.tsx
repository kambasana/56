/**
 * Account (Detail template, docs/UX.md §3; /accounts/:registry/:name): one publishing account.
 * "If this account is taken over, what are we exposed to?" Header with the one primary action,
 * "Mark as compromised" (opens or updates an incident listing the exposure; needs Triage); then
 * stacked sections with an on-page index: Exposure (production first, who brings it in, owner),
 * Packages it can publish (with source and confidence of every link), and Recent publishes
 * (context only: the burst rule failed its noise gate, so there is no alert). The rail holds the
 * account's facts and how complete the registry data is.
 * Data: GET /api/accounts/:registry/:name, GET .../exposure, POST .../compromise.
 */
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { AccountDetail, AccountExposureResponse, AccountLinkSource } from '@server/api-types-accounts';
import { accountsApi } from '@/api-accounts';
import { useAuth } from '@/auth';
import { accountPath, behindPath, incidentPath, packagePath, projectPath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { INCIDENT_STEPS, NotAllowedHint, ReachTag, StateBlock, StatusTrack } from '@/components/br';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { pct } from '@/components/viz/Concentration';
import { useApi } from '@/lib/useApi';
import { fmtTime } from '@/lib/cn';
import { safeHref } from '@/lib/safe-href';
import { STATUS_LABEL } from './Incidents';

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

const DISCLAIMER = 'Public registry data with sources. Not a finding of wrongdoing.';

const RELATION_TEXT: Record<AccountLinkSource['relation'], string> = {
  maintainer: 'Maintainer',
  listed: 'Listed by the account',
  version_maintainer: 'Maintainer at that time',
  repo_owner: 'Owns the repository',
  publisher: 'Published this version',
};
const CONFIDENCE_TEXT = { high: 'High', medium: 'Medium', low: 'Low' } as const;

export function registryLabel(registry: string): string {
  return registry === 'npm' ? 'npm' : registry === 'github' ? 'GitHub' : registry === 'gitlab' ? 'GitLab' : registry;
}

function Links({ links }: { links: readonly AccountLinkSource[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {links.map((l) => {
        const href = safeHref(l.evidence);
        return (
          <li key={`${l.relation} ${l.source}`} className="text-label">
            {RELATION_TEXT[l.relation]} · {CONFIDENCE_TEXT[l.confidence]}{' '}
            <span className="text-text-secondary">
              (
              {href ? (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {l.source}
                </a>
              ) : (
                l.source
              )}
              )
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Tile({ label, value, note }: { label: string; value: string | number; note: string }) {
  return (
    <div className="rounded-xl border px-4 py-3.5">
      <div className="text-text-secondary">{label}</div>
      <div className="text-[28px] leading-[34px] font-semibold">
        {value} <span className="text-body font-medium text-text-secondary">{note}</span>
      </div>
    </div>
  );
}

/** "Mark as compromised": optional start of the window, then open or update the incident. */
function CompromiseDialog({ open, onOpenChange, d, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; d: AccountDetail; onDone: (incidentId: string | null) => void }) {
  const id = useId();
  const [since, setSince] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setSince(d.incident?.since ? d.incident.since.slice(0, 16) : '');
      setError(null);
    }
  }, [open, d.incident?.since]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await accountsApi.markCompromised(d.account.registry, d.account.name, since ? { since: new Date(`${since}:00Z`).toISOString() } : {});
      onOpenChange(false);
      if (r.incidentId) toast.success(r.created ? 'Incident opened' : 'Incident updated', { description: `${plural(r.exposure.counts.exposures, 'exposure')} in ${plural(r.exposure.counts.projects, 'project')}${r.added ? `, ${r.added} new` : ''}` });
      else toast.info('Nothing to open', { description: `No project you have uses a package ${d.account.name} can publish.` });
      onDone(r.incidentId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark the account.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{d.incident ? `Update the incident for ${d.account.name}` : `Mark ${d.account.name} as compromised`}</DialogTitle>
          <DialogDescription>
            Opens an incident listing every project that uses a package this account can publish. Nothing is re-scanned. Versions it published since the date you give are marked critical.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          aria-label="Mark as compromised"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-s`}>Published since (optional, UTC)</Label>
            <Input id={`${id}-s`} type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} className="w-60" aria-describedby={`${id}-sh`} />
            <span id={`${id}-sh`} className="text-label text-text-secondary">
              When you think the takeover began. Leave empty if you do not know.
            </span>
          </div>
          {error && (
            <p role="alert" className="text-label text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Working…' : d.incident ? 'Update incident' : 'Mark as compromised'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExposureTable({ x }: { x: AccountExposureResponse }) {
  const { can } = useAuth();
  if (x.exposures.length === 0)
    return (
      <StateBlock
        kind="all-clear"
        title="No project you can see uses a package it can publish"
        description={`Checked the latest scan of ${x.projectsSearched} ${x.projectsSearched === 1 ? 'project' : 'projects'}.`}
      />
    );
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Exposure" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-3 py-2 font-medium">Project</th>
            <th scope="col" className="px-2 py-2 font-medium">Environment</th>
            <th scope="col" className="px-2 py-2 font-medium">Package</th>
            <th scope="col" className="px-2 py-2 font-medium">Brought in by</th>
            <th scope="col" className="px-2 py-2 font-medium">Owner</th>
            <th scope="col" className="px-2 py-2 font-medium">How it is linked</th>
            <th scope="col" className="px-3 py-2 font-medium">
              <span className="sr-only">Finding</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {x.exposures.map((e) => (
            <tr key={`${e.projectId} ${e.purl}`} className="border-t align-top">
              <td className="px-3 py-2 font-medium">{e.projectName}</td>
              <td className="px-2 py-2">
                <ReachTag reach={e.production ? 'production' : 'dev'} />
              </td>
              <td className="px-2 py-2 font-mono text-[12px] whitespace-nowrap">
                <Link to={packagePath(e.name, e.version)}>
                  {e.name}@{e.version}
                </Link>
                {e.publishedBy && <span className="block font-sans text-caption text-text-secondary">published by {e.publishedBy.account}</span>}
              </td>
              <td className="px-2 py-2 font-mono text-[12px] text-text-secondary">{e.broughtInBy.length ? e.broughtInBy.join(', ') : e.direct ? 'direct dependency' : '–'}</td>
              <td className="px-2 py-2 text-text-secondary">{e.owner ?? 'No owner set'}</td>
              <td className="px-2 py-2">
                <Links links={e.links} />
              </td>
              <td className="px-3 py-2 text-right">
                {e.findingId && can('findings', e.projectId) ? (
                  <Link to={`${projectPath(e.projectId, 'findings')}/${encodeURIComponent(e.findingId)}`}>Open finding</Link>
                ) : (
                  <span className="text-caption text-muted-foreground">No finding</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Body({ d, x, xError, reload }: { d: AccountDetail; x: AccountExposureResponse | null; xError: Error | null; reload: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const allowed = can('review');
  const inUse = d.packages.filter((p) => p.projects > 0);
  const others = d.packages.filter((p) => p.projects === 0);
  const sections = [
    { id: 'exposure', label: 'Exposure' },
    { id: 'packages', label: 'Packages it can publish' },
    { id: 'publishes', label: 'Recent publishes' },
  ];
  return (
    <>
      <div className="flex flex-col gap-2.5 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {d.incident ? (
            <>
              <StatusTrack steps={INCIDENT_STEPS} current={STATUS_LABEL[d.incident.status]} label="Incident status" />
              <Link to={incidentPath(d.incident.id)}>Open the incident</Link>
            </>
          ) : (
            <span className="text-text-secondary">Not marked as compromised</span>
          )}
          <span className="grow" />
          <Button size="sm" className="h-7 px-3 text-label" onClick={() => setOpen(true)} disabled={!allowed} aria-describedby={allowed ? undefined : 'compromise-hint'}>
            {d.incident ? 'Update the incident' : 'Mark as compromised'}
          </Button>
        </div>
        {!allowed && <NotAllowedHint id="compromise-hint" permission="review" />}
      </div>
      <CompromiseDialog
        open={open}
        onOpenChange={setOpen}
        d={d}
        onDone={(id) => {
          if (id) navigate(incidentPath(id));
          else reload();
        }}
      />

      <div className="flex flex-col lg:flex-row">
        <div className="flex min-w-0 grow flex-col gap-4 p-4">
          <nav aria-label="On this page" className="flex flex-wrap gap-3 text-label">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.label}
              </a>
            ))}
          </nav>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile label="Packages it can publish" value={d.packages.length} note={`${inUse.length} in your projects`} />
            <Tile label="Projects exposed" value={x?.counts.projects ?? '…'} note={x ? `${x.counts.production} in production` : 'loading'} />
            <Tile label="Share of production dependencies" value={pct(d.concentration.share)} note={`${d.concentration.packages} of ${d.concentration.of}`} />
          </div>

          <section aria-labelledby="exposure" className="flex flex-col gap-2">
            <h2 id="exposure" className="m-0 text-heading font-semibold">
              Exposure
            </h2>
            <p className="m-0 text-text-secondary">If this account is taken over, every package it can publish is at risk. Production first.</p>
            {x ? (
              <ExposureTable x={x} />
            ) : xError ? (
              <StateBlock kind="error" title="Could not load the exposure" cause={xError.message} onRetry={reload} />
            ) : (
              <StateBlock kind="loading" label="Loading the exposure" rows={3} columns={6} />
            )}
          </section>

          <section aria-labelledby="packages" className="flex flex-col gap-2">
            <h2 id="packages" className="m-0 text-heading font-semibold">
              Packages it can publish
            </h2>
            {d.packages.length === 0 ? (
              <p className="m-0 text-text-secondary">The registry data fetched so far names no package for this account.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <table aria-label="Packages it can publish" className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-muted text-label text-text-secondary">
                      <th scope="col" className="px-3 py-2 font-medium">Package</th>
                      <th scope="col" className="px-2 py-2 font-medium">In your projects</th>
                      <th scope="col" className="px-3 py-2 font-medium">Source and confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...inUse, ...others.slice(0, 50)].map((p) => (
                      <tr key={p.name} className="border-t align-top">
                        <td className="px-3 py-2 font-mono text-[12px]">
                          {p.projects > 0 ? <Link to={behindPath(p.name)}>{p.name}</Link> : p.name}
                        </td>
                        <td className="px-2 py-2">
                          {p.projects > 0 ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                              {p.projects} {p.projects === 1 ? 'project' : 'projects'}
                              {p.production && <ReachTag reach="production" />}
                            </span>
                          ) : (
                            <span className="text-text-secondary">Not used</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Links links={p.links} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {others.length > 50 && <p className="m-0 text-caption text-text-secondary">And {others.length - 50} more packages no project of yours uses.</p>}
          </section>

          <section aria-labelledby="publishes" className="flex flex-col gap-2">
            <h2 id="publishes" className="m-0 text-heading font-semibold">
              Recent publishes
            </h2>
            <p className="m-0 text-text-secondary">
              Context only, never an alert: in testing, normal accounts publish bursts about twice a month, so bursts alone do not tell a takeover apart. Distinct packages published:{' '}
              {d.activity.last24h} in the last day, {d.activity.last7d} in the last week, {d.activity.last30d} in the last 30 days.
            </p>
            {d.recentPublishes.length === 0 ? (
              <p className="m-0 text-label text-text-secondary">No publish by this account in the registry data fetched so far.</p>
            ) : (
              <ol aria-label="Recent publishes" className="m-0 flex list-none flex-col gap-1 p-0">
                {d.recentPublishes.map((p) => (
                  <li key={`${p.name}@${p.version}`} className="flex flex-wrap items-baseline gap-x-3">
                    <span className="w-44 shrink-0 text-label text-text-secondary tabular-nums">{fmtTime(p.at)}</span>
                    <span className="font-mono text-[12px]">
                      {p.name}@{p.version}
                    </span>
                    {p.projects > 0 && <span className="text-label font-medium">locked in {p.projects} {p.projects === 1 ? 'project' : 'projects'}</span>}
                    {p.attribution === 'sole-maintainer' && <span className="text-caption text-text-secondary">deleted version; publisher inferred from the sole maintainer</span>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside aria-labelledby="facts" className="flex w-full shrink-0 flex-col gap-3 border-t p-4 lg:w-[320px] lg:border-t-0 lg:border-l">
          <h2 id="facts" className="m-0 text-heading font-semibold">
            Account
          </h2>
          <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-label">
            <dt className="text-muted-foreground">Registry</dt>
            <dd className="m-0">{registryLabel(d.account.registry)}</dd>
            <dt className="text-muted-foreground">Profile</dt>
            <dd className="m-0 break-all">
              {safeHref(d.account.profileUrl) ? (
                <a href={d.account.profileUrl} target="_blank" rel="noreferrer noopener">
                  {d.account.profileUrl.replace(/^https:\/\//, '')}
                </a>
              ) : (
                d.account.profileUrl
              )}
            </dd>
            <dt className="text-muted-foreground">Package list</dt>
            <dd className="m-0">
              {d.index.listing
                ? d.index.listing.status === 'ok'
                  ? `${d.index.listing.count} packages, fetched ${fmtTime(d.index.listing.fetchedAt)}`
                  : `Not available: ${d.index.listing.detail ?? 'unknown reason'}`
                : d.account.registry === 'npm'
                  ? 'Being fetched; reload in a moment'
                  : 'Not used for repository owners'}
            </dd>
            <dt className="text-muted-foreground">Registry data</dt>
            <dd className="m-0">
              {d.index.packagesIndexed} of your packages
              {d.index.packagesWithoutData > 0 ? `; ${d.index.packagesWithoutData} have none yet` : ''}
            </dd>
          </dl>
          <p className="m-0 mt-auto text-caption text-muted-foreground">{DISCLAIMER}</p>
        </aside>
      </div>
    </>
  );
}

export default function AccountPage() {
  const { me } = useAuth();
  const params = useParams();
  const registry = params.registry ?? '';
  const name = params.name ?? '';
  const detail = useApi((s) => accountsApi.account(registry, name, s), [registry, name]);
  const exposure = useApi((s) => accountsApi.exposure(registry, name, {}, s), [registry, name]);
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Incidents', to: '/incidents' },
    { label: `${registryLabel(registry)} · ${name}`, to: accountPath(registry, name) },
  ];
  const d = detail.data;
  const reload = () => {
    detail.reload();
    exposure.reload();
  };
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={
          <>
            {registryLabel(registry)} {registry === 'npm' ? 'account' : 'owner'} <span className="font-mono font-medium">{name}</span>
          </>
        }
        meta={d ? `can publish ${d.packages.length} ${d.packages.length === 1 ? 'package' : 'packages'}` : undefined}
      />
      {detail.loading && !d && (
        <div className="p-4">
          <StateBlock kind="loading" label={`Loading account ${name}`} rows={4} columns={5} />
        </div>
      )}
      {detail.error && !d && (
        <div className="p-4">
          <StateBlock kind="error" title={`Could not load account ${name}`} cause={detail.error.message} onRetry={detail.reload} actions={[{ label: 'Incidents', to: '/incidents' }]} />
        </div>
      )}
      {d && <Body d={d} x={exposure.data} xError={exposure.error} reload={reload} />}
    </>
  );
}
