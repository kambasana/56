/**
 * Who's behind it (/packages/behind?name=, canvas screen 12): the documented links from a package
 * to its accounts, organisations and funders, top-down. Opens one hop deep behind a focus bar;
 * "+N" expands a node. Unreviewed low-confidence links are hidden until asked for. Every link has
 * its confidence in words and its sources; the rail shows the selected node's sources. The Table
 * view is the accessible equivalent. Data: GET /api/packages/behind.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { PackageBehindResponse } from '@server/api-types-incidents';
import { incidentsApi } from '@/api-incidents';
import { useAuth } from '@/auth';
import { behindPath, packagePath } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { StateBlock, useUpdateParams } from '@/components/br';
import { EntityChain } from '@/components/viz/EntityChain';
import { confidenceWord, entityKind, entityLabel, isUnreviewed, KIND_LABEL, layoutChain, relationText, type BehindLink } from '@/components/viz/entity';
import { useViewParam, ViewToggle } from '@/components/viz/ViewToggle';
import { useApi } from '@/lib/useApi';
import { safeHref } from '@/lib/safe-href';
import { cn } from '@/lib/utils';

const DISCLAIMER = 'Public links with sources. Not a finding of wrongdoing.';

/** The package's own node id in the links ("pkg:npm/event-stream"). */
export function rootIdFor(name: string, links: readonly BehindLink[]): string {
  const own = links.find((l) => l.from.startsWith('pkg:') && entityLabel(l.from) === name);
  return own?.from ?? `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}`;
}

function Sources({ urls }: { urls: readonly string[] }) {
  if (urls.length === 0) return <span className="text-caption text-muted-foreground">No source recorded</span>;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {urls.map((u) => {
        const href = safeHref(u);
        return (
          <li key={u} className="break-all text-label">
            {href ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {u.replace(/^https:\/\//, '')}
              </a>
            ) : (
              <span className="font-mono">{u}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Legend() {
  return (
    <div aria-label="Legend" role="note" className="flex flex-wrap gap-x-4 gap-y-0.5 border-t bg-background px-3 py-2 text-caption text-text-secondary">
      <span>⬭ package</span>
      <span>━ High confidence</span>
      <span>○ account</span>
      <span>╍ Medium</span>
      <span>□ organisation</span>
      <span>┈ Low</span>
      <span>◇ funder</span>
      <span>+N hidden links</span>
    </div>
  );
}

function LinkTable({ links }: { links: readonly BehindLink[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Links" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-3 py-2 font-medium">From</th>
            <th scope="col" className="px-2 py-2 font-medium">Link</th>
            <th scope="col" className="px-2 py-2 font-medium">To</th>
            <th scope="col" className="px-2 py-2 font-medium">Confidence</th>
            <th scope="col" className="px-3 py-2 font-medium">Sources</th>
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={`${l.from} ${l.entityId} ${l.relation}`} className="border-t align-top">
              <td className="px-3 py-2">{entityLabel(l.from)}</td>
              <td className="px-2 py-2">{relationText(l.relation)}</td>
              <td className="px-2 py-2">
                {entityLabel(l.entityId)} <span className="text-caption text-muted-foreground">({KIND_LABEL[entityKind(l.entityId)].toLowerCase()})</span>
              </td>
              <td className="px-2 py-2">
                {confidenceWord(l.confidence)} · {l.method === 'deterministic' ? 'deterministic' : 'probable'}
                {isUnreviewed(l) ? ' · Unreviewed' : l.reviewed ? ' · reviewed' : ''}
              </td>
              <td className="px-3 py-2">
                <Sources urls={l.evidence} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Rail({ data, id, rootId }: { data: PackageBehindResponse; id: string; rootId: string }) {
  const link = data.links.find((l) => l.entityId === id);
  const kind = entityKind(id);
  const also = data.alsoLinked[id] ?? [];
  if (id === rootId)
    return (
      <>
        <h2 className="m-0 text-heading font-semibold">{entityLabel(id)}</h2>
        <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5">
          <dt className="text-muted-foreground">Type</dt>
          <dd className="m-0">Package</dd>
          <dt className="text-muted-foreground">Used in</dt>
          <dd className="m-0">{data.usedIn} {data.usedIn === 1 ? 'project' : 'projects'}</dd>
          <dt className="text-muted-foreground">Direct links</dt>
          <dd className="m-0">{data.links.filter((l) => l.from === rootId).length}</dd>
          {data.incidents.length > 0 && (
            <>
              <dt className="text-muted-foreground">Incidents</dt>
              <dd className="m-0 font-mono text-[12px]">{data.incidents.join(', ')}</dd>
            </>
          )}
        </dl>
        <Link to={packagePath(data.name)}>How far {data.name} spreads</Link>
      </>
    );
  return (
    <>
      <h2 className="m-0 text-heading font-semibold">{entityLabel(id)}</h2>
      <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5">
        <dt className="text-muted-foreground">Type</dt>
        <dd className="m-0">{KIND_LABEL[kind]}</dd>
        {link && (
          <>
            <dt className="text-muted-foreground">Link</dt>
            <dd className="m-0">
              {relationText(link.relation)} ({entityLabel(link.from)})
            </dd>
            <dt className="text-muted-foreground">Confidence</dt>
            <dd className="m-0">
              {confidenceWord(link.confidence)} · {link.method === 'deterministic' ? 'deterministic' : 'probable'}
              {isUnreviewed(link) ? ' · Unreviewed: never affects a score' : link.reviewed ? ' · reviewed' : ''}
            </dd>
          </>
        )}
        {also.length > 0 && (
          <>
            <dt className="text-muted-foreground">Packages you use</dt>
            <dd className="m-0 font-mono text-[12px]">{[data.name, ...also].join(', ')}</dd>
          </>
        )}
      </dl>
      {link && (
        <div className="flex flex-col gap-1">
          <span className="text-label font-medium">Sources</span>
          <Sources urls={link.evidence} />
        </div>
      )}
    </>
  );
}

function Behind({ data }: { data: PackageBehindResponse }) {
  const [sp] = useSearchParams();
  const update = useUpdateParams();
  const [view, setView] = useViewParam(['graph', 'table'] as const, 'graph');
  const showUnreviewed = sp.get('unreviewed') === '1';
  const rootId = rootIdFor(data.name, data.links);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootId]));
  const [selected, setSelected] = useState<string>(rootId);
  const layout = useMemo(() => layoutChain(rootId, data.links, { showUnreviewed, expanded }), [rootId, data.links, showUnreviewed, expanded]);
  const unreviewedCount = data.links.filter(isUnreviewed).length;
  const tableLinks = showUnreviewed ? data.links : data.links.filter((l) => !isUnreviewed(l));
  const hops = Math.max(0, ...layout.nodes.map((n) => n.depth));
  const expandAll = () => setExpanded(new Set([rootId, ...data.links.map((l) => l.entityId)]));
  const summary = `${data.name}: ${layout.nodes.length - 1} linked accounts, organisations or funders shown, ${layout.linksHidden} more hidden.`;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-selection-soft px-2.5 py-1.5 text-selection">
        <span className="font-semibold">Focused on {data.name}</span>
        <span className="text-text-secondary">
          · {hops} {hops === 1 ? 'hop' : 'hops'} expanded · {layout.linksHidden} more {layout.linksHidden === 1 ? 'link' : 'links'} hidden
        </span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={showUnreviewed}
            disabled={!showUnreviewed && unreviewedCount === 0}
            onClick={() => update({ unreviewed: showUnreviewed ? null : '1' })}
            className={cn('h-6 rounded-[6px] border bg-background px-2.5 text-label disabled:opacity-60', showUnreviewed ? 'border-selection font-semibold text-selection' : 'border-input text-foreground')}
          >
            {showUnreviewed ? 'Hide unreviewed links' : `Show unreviewed links (${unreviewedCount})`}
          </button>
          {layout.linksHidden > 0 && (
            <button type="button" onClick={expandAll} className="h-6 rounded-[6px] border border-input bg-background px-2.5 text-label text-foreground">
              Show every hop
            </button>
          )}
          <button type="button" onClick={() => setExpanded(new Set([rootId]))} className="h-6 rounded-[6px] border border-input bg-background px-2.5 text-label text-foreground">
            Back to one hop
          </button>
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-label text-text-secondary">Line style matches confidence; every link names its sources.</span>
        <ViewToggle value={view} onChange={setView} options={[{ value: 'graph', label: 'Graph' }, { value: 'table', label: 'Table' }]} />
      </div>
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 grow">
          {view === 'graph' ? (
            <EntityChain layout={layout} selected={selected} onSelect={setSelected} onExpand={(id) => setExpanded((s) => new Set([...s, id]))} summary={summary} legend={<Legend />} />
          ) : (
            <LinkTable links={tableLinks} />
          )}
        </div>
        <aside aria-label="Selected" className="flex w-full shrink-0 flex-col gap-3 lg:w-[300px]">
          <Rail data={data} id={selected} rootId={rootId} />
          <p className="m-0 mt-auto text-caption text-muted-foreground">{DISCLAIMER}</p>
        </aside>
      </div>
    </div>
  );
}

export default function BehindPage() {
  const { me } = useAuth();
  const [sp] = useSearchParams();
  const name = sp.get('name')?.trim() ?? '';
  const { data, error, loading, reload } = useApi((s) => (name ? incidentsApi.behind(name, s) : Promise.resolve(null)), [name]);
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: name || 'Package', to: name ? packagePath(name) : '/incidents' },
    { label: "Who's behind it", to: behindPath(name) },
  ];
  let body;
  if (!name) body = <StateBlock kind="no-results" title="No package given" actions={[{ label: 'Incidents', to: '/incidents' }]} />;
  else if (loading && !data) body = <StateBlock kind="loading" label={`Loading who is behind ${name}`} rows={3} columns={4} />;
  else if (error && !data) body = <StateBlock kind="error" title={`Could not load who is behind ${name}`} cause={error.message} onRetry={reload} />;
  else if (data && data.links.length === 0)
    body = (
      <StateBlock
        kind="no-results"
        title={`No documented links for ${name}`}
        description={data.usedIn ? `It is used in ${data.usedIn} ${data.usedIn === 1 ? 'project' : 'projects'}, but the latest scans recorded no maintainer, owner or funder links for it. ${DISCLAIMER}` : 'No project you can see uses it.'}
        actions={[{ label: `How far ${name} spreads`, to: packagePath(name) }]}
      />
    );
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={
          <>
            Who's behind <span className="font-mono font-medium">{name || 'a package'}</span>
          </>
        }
        meta={data ? `used in ${data.usedIn} ${data.usedIn === 1 ? 'project' : 'projects'}` : undefined}
      />
      {body ? <div className="p-4">{body}</div> : data ? <Behind key={data.name} data={data} /> : null}
    </>
  );
}
