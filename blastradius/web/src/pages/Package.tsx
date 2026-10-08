/**
 * Package reach (/packages?name=&version=, canvas screen 11): how far one package spreads across
 * every project the viewer can see, from stored inventories. Lifecycle strip (only the phases the
 * data knows) → Blast Sankey or its table → path tree (production lane first) → the selected path
 * as a chain in the right rail, with the shortest fix when the advisory names a fixed version.
 * The ⌘K Verdict links here. Data: GET /api/packages/reach.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PackageReachResponse, ReachPath } from '@server/api-types-incidents';
import { incidentsApi } from '@/api-incidents';
import { useAuth } from '@/auth';
import { behindPath, incidentPath, packagePath, projectPath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { ReachTag, SeverityBadge, StateBlock, useUpdateParams, VerdictContent, verdictSurface } from '@/components/br';
import { useCommandPalette } from '@/components/CommandPalette';
import { BlastSankey } from '@/components/viz/BlastSankey';
import { PathChain, PathTree, pathKey } from '@/components/viz/PathTree';
import { LifecycleStrip, type LifecyclePhase } from '@/components/viz/Timeline';
import { useViewParam, ViewToggle } from '@/components/viz/ViewToggle';
import { useApi } from '@/lib/useApi';
import { fmtTime } from '@/lib/cn';
import { cn } from '@/lib/utils';
import { STATUS_LABEL } from './Incidents';

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

function Reach({ r, pkg }: { r: PackageReachResponse; pkg: string }) {
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

  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Incidents', to: '/incidents' },
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
  else if (data) body = <Reach r={data} pkg={pkg} />;

  return (
    <>
      <PageHeader crumbs={crumbs} title={<span className="font-mono">{pkg || 'Package'}</span>} meta={version ? <Link to={packagePath(name)}>every version</Link> : undefined} />
      {body}
    </>
  );
}
