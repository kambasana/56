/**
 * Package reach (/packages?name=&version=, canvas screen 11): how far one package spreads across
 * every project the viewer can see, from stored inventories. Lifecycle strip (only the phases the
 * data knows) → Blast Sankey or its table → path tree (production lane first) → the selected path
 * as a chain in the right rail, with the shortest fix when the advisory names a fixed version.
 * The ⌘K Verdict links here. Data: GET /api/packages/reach.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PackageBehindResponse, PackageReachResponse, ReachPath } from '@server/api-types-incidents';
import { incidentsApi } from '@/api-incidents';
import { useAuth } from '@/auth';
import { accountPath, accountPathForEntity, behindPath, exposurePath, incidentPath, packagePath, projectPath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { ReachTag, SeverityBadge, StateBlock, useUpdateParams, VerdictContent, verdictSurface } from '@/components/br';
import { useCommandPalette } from '@/components/CommandPalette';
import { BlastSankey } from '@/components/viz/BlastSankey';
import { PathChain, PathTree, pathKey } from '@/components/viz/PathTree';
import { LifecycleStrip, type LifecyclePhase } from '@/components/viz/Timeline';
import { useViewParam, ViewToggle } from '@/components/viz/ViewToggle';
import { entityKind, entityLabel, KIND_LABEL, relationText, reviewText, type BehindLink } from '@/components/viz/entity';
import { safeHref } from '@/lib/safe-href';
import { useApi } from '@/lib/useApi';
import { fmtTime } from '@/lib/cn';
import { cn } from '@/lib/utils';
import { STATUS_LABEL } from './Incidents';
import { StabilityDetails } from './d-parts/Stability';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function lifecyclePhases(r: PackageReachResponse): LifecyclePhase[] {
  const out: LifecyclePhase[] = [];
  const { firstWarning, advisory, fixed } = r.lifecycle;
  if (firstWarning) out.push({ label: 'First warning', value: `${fmtTime(firstWarning)} · first flagged in a scan`, accent: 'warning' });
  if (advisory) out.push({ label: 'Advisory', value: `${fmtTime(advisory.at)} · ${advisory.id}`, accent: 'none' });
  if (fixed) out.push({ label: 'Fixed here', value: `${fixed.fixed} of ${plural(fixed.of, 'project')}`, accent: 'none' });
  return out;
}

/** The shortest fix for one path, only when an advisory names a fixed version. */
export function shortestFix(p: ReachPath, r: PackageReachResponse): string | null {
  const adv = r.advisories.find((a) => a.fixedIn);
  if (!adv?.fixedIn) return null;
  const pkg = p.nodes.at(-1)!.label;
  const name = pkg.replace(/@[^@/]*$/, '');
  if (p.nodes.length === 2) return `Upgrade ${name} to ${adv.fixedIn} or later in ${p.projectName} (${p.assetName}); ${adv.id} names ${adv.fixedIn} as the first fixed version.`;
  const via = p.nodes[1]!.label;
  return `Upgrade or replace ${via} so ${p.projectName} no longer resolves ${pkg}, or pin ${name} to ${adv.fixedIn} or later with an override; ${adv.id} names ${adv.fixedIn} as the first fixed version.`;
}

function ReachTable({ r }: { r: PackageReachResponse }) {
  const { can } = useAuth();
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Projects" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-3 py-2 font-medium">Project</th>
            <th scope="col" className="px-2 py-2 font-medium">Where</th>
            <th scope="col" className="px-2 py-2 font-medium">Brought in by</th>
            <th scope="col" className="px-2 py-2 font-medium">Versions</th>
            <th scope="col" className="px-2 py-2 font-medium">Paths</th>
            <th scope="col" className="px-2 py-2 font-medium">Assets</th>
            <th scope="col" className="px-3 py-2 font-medium">
              <span className="sr-only">Finding</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {r.projects.map((p) => (
            <tr key={p.projectId} className="border-t">
              <td className="px-3 py-2 font-mono text-[12px]">{p.projectName}</td>
              <td className="px-2 py-2">
                <ReachTag reach={p.production ? 'production' : 'dev'} />
              </td>
              <td className="px-2 py-2 font-mono text-[12px]">{p.via.map((v) => (v === '(direct)' ? 'direct dependency' : v)).join(', ') || '–'}</td>
              <td className="px-2 py-2 font-mono text-[12px]">{p.versions.join(', ')}</td>
              <td className="px-2 py-2">{p.paths}</td>
              <td className="px-2 py-2">{p.assets}</td>
              <td className="px-3 py-2 text-right">
                {p.findingId && can('findings', p.projectId) ? <Link to={`${projectPath(p.projectId, 'findings')}/${encodeURIComponent(p.findingId)}`}>Open finding</Link> : <span className="text-caption text-muted-foreground">{p.reachText}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceLink({ url }: { url: string | undefined }) {
  const href = url ? safeHref(url) : null;
  if (!url) return null;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className="break-all text-caption">
      {url.replace(/^https:\/\//, '')}
    </a>
  ) : (
    <span className="font-mono text-caption">{url}</span>
  );
}

function LinkRows({ links, empty }: { links: readonly BehindLink[]; empty: string }) {
  if (links.length === 0) return <p className="m-0 text-caption text-muted-foreground">{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {links.map((l) => {
        const to = accountPathForEntity(l.entityId);
        return (
          <li key={`${l.relation} ${l.entityId}`} className="flex flex-col">
            <span>
              {relationText(l.relation)}{' '}
              {to ? (
                <Link to={to} className="underline">
                  {entityLabel(l.entityId)}
                </Link>
              ) : (
                <span className="font-medium">{entityLabel(l.entityId)}</span>
              )}
              {entityKind(l.entityId) !== 'owner' && <span className="text-caption text-muted-foreground"> ({KIND_LABEL[entityKind(l.entityId)].toLowerCase()})</span>}
            </span>
            <span className="text-caption text-text-secondary">{reviewText(l)}</span>
            <SourceLink url={l.evidence[0]} />
          </li>
        );
      })}
    </ul>
  );
}

/** Who is behind the package: publish rights, publisher of each locked version, owner and funding pages, with sources and review state. */
export function BehindSummary({ b, version }: { b: PackageBehindResponse; version: string | null }) {
  const versions = version ? b.lockedVersions.filter((v) => v.version === version) : b.lockedVersions;
  const owners = b.links.filter((l) => l.relation === 'owns');
  const funding = b.links.filter((l) => l.relation === 'receives_funding_at');
  const machine = b.review.machineDerived;
  return (
    <div className="grid grid-cols-1 gap-4 rounded-xl border p-4 md:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-label font-semibold">Can publish now</h3>
        {b.publishRights === null && b.pending ? (
          <p className="m-0 text-caption text-muted-foreground" role="status">
            Indexing: the account index is still fetching registry data for it. This updates on its own.
          </p>
        ) : b.publishRights === null ? (
          <p className="m-0 text-caption text-muted-foreground">No registry data for it yet; the account index fetches it after the next scan.</p>
        ) : b.publishRights.length === 0 ? (
          <p className="m-0 text-caption text-muted-foreground">The registry lists no maintainers.</p>
        ) : (
          <ul aria-label="Publish rights" className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0">
            {b.publishRights.map((a) => (
              <li key={a.account}>
                <Link to={accountPath('npm', a.account)}>npm · {a.account}</Link>
              </li>
            ))}
          </ul>
        )}
        {b.publishRights && b.publishRights.length > 0 && (
          <span className="text-caption text-text-secondary">
            {b.publishRights[0]!.source} · <SourceLink url={b.publishRights[0]!.evidence} />
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-label font-semibold">Who published {version ? 'this version' : 'the versions you lock'}</h3>
        {versions.length === 0 ? (
          <p className="m-0 text-caption text-muted-foreground">No project you can see locks {version ? 'this version' : 'it'}.</p>
        ) : (
          <ul aria-label="Locked versions" className="m-0 flex list-none flex-col gap-1 p-0">
            {versions.slice(0, 8).map((v) => (
              <li key={v.version} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[12px]">{v.version}</span>
                {v.publisher ? (
                  <span>
                    by{' '}
                    <Link to={accountPath('npm', v.publisher.account)} className="underline">
                      {v.publisher.account}
                    </Link>
                    <span className="text-caption text-text-secondary">
                      {v.publisher.attribution === 'sole-maintainer' ? ' (deleted version; sole maintainer before it)' : ' (npm _npmUser)'}
                      {v.publisher.at ? ` · ${fmtTime(v.publisher.at)}` : ''}
                    </span>
                  </span>
                ) : (
                  <span className="text-caption text-muted-foreground">{b.pending ? 'publisher: indexing…' : 'publisher not known'}</span>
                )}
                {v.production && <ReachTag reach="production" />}
                {v.knownBad.map((k) => (
                  <span key={k.id} className="rounded-[6px] bg-destructive px-1.5 text-label font-medium text-destructive-foreground">
                    Known bad: {k.id}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-label font-semibold">Repository owner</h3>
        <LinkRows links={owners} empty="No repository owner recorded." />
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-label font-semibold">Funding pages it names</h3>
        <LinkRows links={funding} empty="None named in its funding field or FUNDING.yml." />
      </div>
      <p className="m-0 text-caption text-muted-foreground md:col-span-2">
        {machine} {machine === 1 ? 'link is' : 'links are'} machine-derived from public registry and repository records; {b.review.reviewed} reviewed by a person. Not a finding of wrongdoing.{' '}
        <Link to={behindPath(b.name)} className="underline">
          Every link, with sources
        </Link>
      </p>
    </div>
  );
}

function Reach({ r, pkg, behind }: { r: PackageReachResponse; pkg: string; behind: { data: PackageBehindResponse | null; error: Error | null } }) {
  const [sp] = useSearchParams();
  const update = useUpdateParams();
  const [view, setView] = useViewParam(['graph', 'table'] as const, 'graph');
  const focusProject = sp.get('project');
  const paths = useMemo(() => (focusProject ? r.paths.filter((p) => p.projectId === focusProject) : r.paths), [r.paths, focusProject]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = paths.find((p) => pathKey(p) === picked) ?? paths[0] ?? null;
  const prodProjects = r.projects.filter((p) => p.production).length;
  const vias = new Set(r.flows.map((f) => f.via)).size;
  const openIncident = r.advisories.find((a) => a.status !== 'closed') ?? r.advisories[0];
  const fix = selected ? shortestFix(selected, r) : null;
  const focusName = r.projects.find((p) => p.projectId === focusProject)?.projectName;
  const summary = `${pkg} reaches ${plural(r.projects.length, 'project')} through ${plural(vias, 'introducer')}; ${prodProjects} in production.`;

  return (
    <>
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {r.level ? <SeverityBadge level={r.level} size="md" /> : <span className="text-label text-muted-foreground">Not rated by any finding or advisory</span>}
          <span className="text-text-secondary">
            Reaches <strong className="text-foreground">{plural(r.projects.length, 'project')}</strong>, <strong className="text-foreground">{prodProjects} in production</strong>, through {plural(vias, 'introducer')} · {r.projectsSearched} searched
          </span>
          <span className="grow" />
          <Link to={behindPath(r.query.name)} className="text-label">
            Who's behind {r.query.name}
          </Link>
          {openIncident && (
            <Link to={incidentPath(openIncident.id)} className="inline-flex h-7 items-center rounded-lg bg-primary px-3 text-label font-medium text-primary-foreground no-underline hover:no-underline">
              Open incident
            </Link>
          )}
        </div>
        {r.advisories.length > 0 && (
          <p className="m-0 text-label text-text-secondary">
            {r.advisories.map((a) => `${a.id} (${STATUS_LABEL[a.status]}${a.fixedIn ? `, fixed in ${a.fixedIn}` : ''})`).join(' · ')}
          </p>
        )}
        <LifecycleStrip phases={lifecyclePhases(r)} />
      </div>

      <div className="flex flex-col xl:flex-row">
        <div className="flex min-w-0 grow flex-col gap-5 p-4">
          <section aria-labelledby="h-blast" className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <h2 id="h-blast" className="m-0 text-heading font-semibold">
                Blast radius
              </h2>
              <ViewToggle value={view} onChange={setView} options={[{ value: 'graph', label: 'Graph' }, { value: 'table', label: 'Table' }]} />
            </div>
            {view === 'graph' ? (
              <div className="rounded-xl border p-4">
                <BlastSankey pkg={{ label: r.query.name, level: r.level }} flows={r.flows} selected={focusProject} onPickProject={(id) => update({ project: id === focusProject ? null : id })} summary={summary} />
              </div>
            ) : (
              <ReachTable r={r} />
            )}
          </section>

          <section aria-labelledby="h-behind" className="flex flex-col gap-2.5">
            <h2 id="h-behind" className="m-0 text-heading font-semibold">
              Who is behind it
            </h2>
            {behind.data ? (
              <BehindSummary b={behind.data} version={r.query.version} />
            ) : behind.error ? (
              <p className="m-0 text-caption text-muted-foreground">Could not load who is behind it: {behind.error.message}</p>
            ) : (
              <StateBlock kind="loading" label={`Loading who is behind ${r.query.name}`} rows={2} columns={2} />
            )}
          </section>

          <section aria-labelledby="h-stability" className="flex flex-col gap-2.5">
            <h2 id="h-stability" className="m-0 text-heading font-semibold">
              Stability
            </h2>
            {r.stability ? (
              <div className="flex flex-col gap-2 rounded-xl border p-4">
                <StabilityDetails entry={r.stability.entry} disclaimer={r.stability.disclaimer} />
                <p className="m-0 text-caption text-muted-foreground">
                  From the scan of {r.stability.projectName} on {fmtTime(r.stability.asOf)}.
                </p>
              </div>
            ) : (
              <p className="m-0 text-caption text-muted-foreground">No stability label yet: the newest scans that use this package were made before labels existed.</p>
            )}
          </section>

          <section aria-labelledby="h-paths" className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="h-paths" className="m-0 text-heading font-semibold">
                How it gets in
              </h2>
              {focusName && (
                <button type="button" onClick={() => update({ project: null })} className="inline-flex h-6 items-center gap-1 rounded-lg border border-selection bg-selection-soft px-2 text-label text-selection">
                  Only {focusName} <span aria-hidden="true">×</span>
                  <span className="sr-only">: show every project</span>
                </button>
              )}
            </div>
            {paths.length ? (
              <PathTree paths={paths} total={focusProject ? undefined : r.totalPaths} level={r.level} selected={selected ? pathKey(selected) : null} onSelect={setPicked} />
            ) : (
              <p className="m-0 text-caption text-muted-foreground">In the lockfile, but no dependency path reaches it.</p>
            )}
          </section>
        </div>

        <aside aria-labelledby="h-sel" className="flex w-full shrink-0 flex-col gap-3 border-t p-4 xl:w-[300px] xl:border-t-0 xl:border-l">
          <h2 id="h-sel" className="m-0 text-heading font-semibold">
            Selected path
          </h2>
          {selected ? (
            <>
              <span className="text-text-secondary">
                {selected.projectName} · {selected.production ? 'Production' : 'Dev and test'}
              </span>
              <PathChain path={selected} level={r.level} />
              {fix && (
                <div className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2.5">
                  <span className="font-semibold">Shortest fix</span>
                  <span className="text-text-secondary">{fix}</span>
                </div>
              )}
            </>
          ) : (
            <p className="m-0 text-caption text-muted-foreground">Choose a path to see it as a chain.</p>
          )}
        </aside>
      </div>
    </>
  );
}

export default function PackagePage() {
  const { me } = useAuth();
  const [sp] = useSearchParams();
  const { setOpen } = useCommandPalette();
  const name = sp.get('name')?.trim() ?? '';
  const version = sp.get('version')?.trim() || null;
  const pkg = version ? `${name}@${version}` : name;
  const { data, error, loading, reload } = useApi((s) => (name ? incidentsApi.reach({ name, version }, s) : Promise.resolve(null)), [name, version]);
  const behind = useApi((s) => (name ? incidentsApi.behind(name, s) : Promise.resolve(null)), [name]);
  // Tier 0.5: while the account index is still running, ask again until the registry data is in.
  const behindPending = behind.data?.pending === true;
  const reloadBehind = behind.reload;
  useEffect(() => {
    if (!behindPending) return;
    const t = setTimeout(reloadBehind, 5000);
    return () => clearTimeout(t);
  }, [behindPending, reloadBehind, behind.data]);

  // A package is reached from the org-wide Exposure view (and ⌘K), not from an incident.
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Exposure', to: exposurePath() },
    ...(version ? [{ label: name, to: packagePath(name) }] : []),
    { label: pkg || 'Package', to: packagePath(name || '', version) },
  ];

  let body;
  if (!name)
    body = (
      <div className="p-4">
        <StateBlock kind="no-results" title="No package given" description="Search for a package with a version to check every project." actions={[{ label: 'Search (⌘K)', onClick: () => setOpen(true) }]} />
      </div>
    );
  else if (loading && !data)
    body = (
      <div className="p-4">
        <StateBlock kind="loading" label={`Checking every project for ${pkg}`} rows={3} columns={3} />
      </div>
    );
  else if (error && !data)
    body = (
      <div className="p-4">
        <StateBlock kind="error" title={`Could not check ${pkg}`} cause={error.message} onRetry={reload} />
      </div>
    );
  else if (data && data.projects.length === 0)
    body = (
      <div className="flex flex-col gap-3 p-4">
        <section aria-label="Verdict" className={cn('rounded-xl p-4', verdictSurface(false))}>
          <VerdictContent data={{ pkg, projects: 0, production: 0, searched: data.projectsSearched }} />
        </section>
        {version && (
          <p className="m-0 text-label text-text-secondary">
            Other versions: <Link to={packagePath(name)}>{name} in every project</Link>.
          </p>
        )}
      </div>
    );
  else if (data) body = <Reach r={data} pkg={pkg} behind={{ data: behind.data, error: behind.error }} />;

  return (
    <>
      <PageHeader crumbs={crumbs} title={<span className="font-mono">{pkg || 'Package'}</span>} meta={version ? <Link to={packagePath(name)}>every version</Link> : undefined} />
      {body}
    </>
  );
}
