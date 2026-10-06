/**
 * Investigate (canvas: Investigate.dc.html, Graph*.dc.html). Search a project's latest scan for
 * a package, person, org, funder or incident, or arrive with ?finding=<id> from a finding, and
 * see a Cytoscape graph scoped to that ONE node: asset -> deps -> maintainers/orgs/funders ->
 * incidents. Never estate-wide: nothing is drawn until something is picked, and the server caps
 * nodes at the project tier's graphNodeCap (what was dropped is listed).
 *
 * The graph is mirrored by a keyboard-accessible Nodes table with the same details panel.
 */
import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { GraphNode, GraphResponse, InvestigateNodeResponse, RiskLevel } from '@server/api-types';
import { api, isApiError } from '@/api';
import { useAuth } from '@/auth';
import { Badge, RiskBadge } from '@/components/Badge';
import { ButtonLink, Button } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { EmptyState, ErrorState, LoadingState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { ScopedGraph } from '@/components/ScopedGraph';
import { SidePanel } from '@/components/SidePanel';
import { cn, fmtNum } from '@/lib/cn';
import { useApi } from '@/lib/useApi';
import { useProject } from '@/project';
import { canCentre, edgesOf, groupResults, KIND_LABEL, summarise } from './e-parts/graph';
import { Select, TabPanel, Tabs, inputClass, safeHref } from './e-parts/ui';

type Tab = 'graph' | 'nodes' | 'appear' | 'links';
type Layout = 'breadthfirst' | 'cose' | 'concentric';

const projectPath = (pid: string, rest: string) => `/projects/${encodeURIComponent(pid)}/${rest}`;

export default function Investigate() {
  const { me, can } = useAuth();
  const params = useParams();
  const { project, projectId: ctxProject } = useProject();
  const projectId = params.id ?? ctxProject ?? '';
  const [sp, setSp] = useSearchParams();
  const finding = sp.get('finding');
  const node = sp.get('node');
  const [q, setQ] = useState(node && !node.startsWith('pkg:') ? node : '');
  const dq = useDeferredValue(q.trim());
  const searchId = useId();

  const pick = (next: { finding?: string; node?: string }) => {
    const n = new URLSearchParams();
    if (next.finding) n.set('finding', next.finding);
    if (next.node) n.set('node', next.node);
    setSp(n);
  };

  const search = useApi(
    (s) => (dq.length >= 2 ? api.investigateSearch(projectId, dq, s) : Promise.resolve(null)),
    [projectId, dq],
  );
  const canFindings = can('findings', projectId);
  const suggestions = useApi(
    (s) => (canFindings ? api.findings({ project: projectId, sort: '-score', limit: 15 }, s) : Promise.resolve(null)),
    [projectId, canFindings],
  );

  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: project?.name ?? 'Project', to: canFindings ? projectPath(projectId, 'findings') : undefined },
    { label: 'Investigate' },
  ];

  const selectedKey = finding ? `finding:${finding}` : node ? `node:${node}` : null;

  return (
    <>
      <PageHeader crumbs={crumbs} title="Investigate" meta="graphs are scoped to one finding or entity" />
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2">
        <label htmlFor={searchId} className="sr-only">
          Search packages, people, orgs, funders and incidents
        </label>
        <input
          id={searchId}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search packages, people, orgs, funders, incidents"
          className={cn(inputClass, 'w-full max-w-[420px] font-mono')}
        />
        <span className="text-xs text-muted-foreground">Scope: {project?.name ?? 'this project'} · latest scan</span>
      </div>
      <div className="flex min-h-0 grow flex-wrap">
        <aside aria-label="Results" className="flex max-h-[80vh] min-w-0 flex-[1_1_240px] flex-col overflow-auto border-r py-2 lg:max-w-[300px]">
          {dq.length >= 2 ? (
            search.loading && !search.data ? (
              <LoadingState label="Searching…" />
            ) : search.error ? (
              <ErrorState error={search.error} onRetry={search.reload} />
            ) : search.data && search.data.items.length > 0 ? (
              groupResults(search.data.items).map((g) => (
                <ResultGroup
                  key={g.kind}
                  label={g.label}
                  items={g.items.map((it) => ({ key: `node:${it.id}`, name: it.label, meta: it.meta, mono: it.kind === 'component', onPick: () => pick({ node: it.id }) }))}
                  selectedKey={selectedKey}
                />
              ))
            ) : (
              <EmptyState title="No matches" description="Nothing in the latest scan matches. Try part of a package name or an entity id." />
            )
          ) : (
            <>
              <p className="m-0 px-4 pb-2 text-xs text-muted-foreground">Type at least 2 characters to search, or start from a top finding.</p>
              {suggestions.data && suggestions.data.items.length > 0 && (
                <ResultGroup
                  label="Top findings"
                  items={suggestions.data.items.map((f) => ({
                    key: `finding:${f.id}`,
                    name: `${f.name}@${f.version}`,
                    meta: `${f.level} · score ${Math.round(f.score)} · ${f.reach.assets} assets`,
                    mono: true,
                    onPick: () => pick({ finding: f.id }),
                  }))}
                  selectedKey={selectedKey}
                />
              )}
              {suggestions.error && <p className="m-0 px-4 text-xs text-muted-foreground">Top findings could not be loaded.</p>}
            </>
          )}
        </aside>
        <section aria-label="Dossier" className="flex min-w-0 flex-[999_1_560px] flex-col">
          {!projectId ? (
            <EmptyState title="No project selected" description="Open a project first; Investigate works within one project's latest scan." />
          ) : finding || node ? (
            <Dossier key={selectedKey ?? ''} projectId={projectId} finding={finding} node={node} onCentre={(id) => pick({ node: id })} />
          ) : (
            <EmptyState
              title="Pick something to investigate"
              description="Search for a package, maintainer, org, funder or incident, or pick a top finding. The graph opens centred on that one node, never the whole estate."
            />
          )}
        </section>
      </div>
    </>
  );
}

interface ResultItem {
  key: string;
  name: string;
  meta: string;
  mono?: boolean;
  onPick: () => void;
}

function ResultGroup({ label, items, selectedKey }: { label: string; items: ResultItem[]; selectedKey: string | null }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col pb-2">
      <div className="px-4 pb-1 pt-2 text-xs font-medium text-muted-foreground">{label}</div>
      {items.map((it) => {
        const on = it.key === selectedKey;
        return (
          <button
            key={it.key}
            type="button"
            aria-pressed={on}
            onClick={it.onPick}
            className={cn(
              'flex w-full cursor-pointer flex-col items-start border-0 px-4 py-1.5 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
              on ? 'bg-muted' : 'bg-transparent',
            )}
          >
            <span className={cn('max-w-full truncate text-[13px] font-medium', it.mono && 'font-mono')}>{it.name}</span>
            <span className="max-w-full truncate text-xs text-muted-foreground">{it.meta}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Dossier({ projectId, finding, node, onCentre }: { projectId: string; finding: string | null; node: string | null; onCentre: (id: string) => void }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('graph');
  const [layout, setLayout] = useState<Layout>('breadthfirst');
  const graph = useApi<GraphResponse>(
    (s) => (finding ? api.graphForFinding(finding, s) : api.graphForNode(projectId, node ?? '', s)),
    [projectId, finding, node],
  );
  const g = graph.data;
  const centreNode = g?.nodes.find((n) => n.id === g.centre) ?? null;
  const centreId = centreNode && canCentre(centreNode) ? centreNode.id : null;
  const info = useApi<InvestigateNodeResponse | null>(
    (s) => (centreId ? api.investigateNode(projectId, centreId, s) : Promise.resolve(null)),
    [projectId, centreId],
  );
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => setSel(g?.centre ?? null), [g]);

  if (graph.loading && !g) return <LoadingState label="Loading graph…" />;
  if (graph.error) {
    return isApiError(graph.error, 'not_found') ? (
      <EmptyState title="Not in the latest scan" description="This finding or node does not occur in the project's latest succeeded scan." />
    ) : (
      <ErrorState error={graph.error} onRetry={graph.reload} />
    );
  }
  if (!g || !centreNode) return <EmptyState title="Nothing to show" description="The graph for this node is empty." />;

  const sum = summarise(g);
  const appearances = info.data?.appearances ?? [];
  const links = info.data?.links ?? [];
  const projects = new Set(appearances.map((a) => a.projectId)).size;
  const selectedNode = g.nodes.find((n) => n.id === sel) ?? null;
  const findingFor = (purl: string) => appearances.find((a) => a.projectId === projectId && a.purl === purl) ?? null;

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1.5 border-b px-5 py-3">
        <span className="text-xs text-muted-foreground">
          {KIND_LABEL[centreNode.kind] ?? centreNode.kind}
          {centreNode.entityType ? ` · ${centreNode.entityType}` : ''}
        </span>
        <h2 className="m-0 flex flex-wrap items-center gap-2 break-all font-mono text-lg font-semibold leading-7">
          {centreNode.label}
          {centreNode.level && <RiskBadge level={centreNode.level} />}
        </h2>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
          <Stat k="Nodes" v={`${fmtNum(sum.shown)}${sum.dropped ? ` of ${fmtNum(sum.total)}` : ''}`} />
          <Stat k="Assets" v={fmtNum(sum.byKind.asset ?? 0)} />
          <Stat k="Components" v={fmtNum(sum.byKind.component ?? 0)} />
          <Stat k="Entities" v={fmtNum((sum.byKind.entity ?? 0) + (sum.byKind.incident ?? 0))} />
          {info.data && <Stat k="Projects" v={fmtNum(projects)} />}
          <Stat k="Cap" v={fmtNum(g.cap)} />
        </div>
        {g.truncated && (
          <p role="note" className="m-0 rounded-md border border-warning/40 px-3 py-1.5 text-[13px] text-warning">
            Capped at {fmtNum(g.cap)} nodes for this project's tier: {fmtNum(sum.dropped)} node{sum.dropped === 1 ? '' : 's'} dropped into groups
            {sum.groups.length > 0 ? ` (${sum.groups.map((x) => x.label.replace(/^\+/, '')).join(', ')})` : ''}. Centre on a node to see its neighbourhood.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-b px-5">
        <Tabs
          idBase="inv"
          label="Dossier views"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'graph', label: 'Graph' },
            { id: 'nodes', label: `Nodes (${fmtNum(sum.shown + sum.groups.length)})` },
            { id: 'appear', label: `Where it appears${info.data ? ` (${appearances.length})` : ''}`, disabled: !centreId },
            { id: 'links', label: `Links and sources${info.data ? ` (${links.length})` : ''}`, disabled: !centreId },
          ]}
        />
        <span className="grow" />
        {tab === 'graph' && (
          <Select label="Layout" value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
            <option value="breadthfirst">Layered</option>
            <option value="cose">Force</option>
            <option value="concentric">Concentric</option>
          </Select>
        )}
      </div>
      {tab === 'graph' && (
        <TabPanel idBase="inv" id="graph" className="flex flex-wrap">
          <div className="min-w-0 flex-[999_1_480px] p-4">
            <ScopedGraph graph={g} layout={layout} height={520} onNodeClick={setSel} label={`Graph centred on ${centreNode.label}`} />
            <p className="m-0 mt-1.5 text-xs text-muted-foreground">
              Click a node for details. Dashed edges are unreviewed or low-confidence links; they never affect scores. The Nodes tab lists the same nodes for keyboard use.
            </p>
          </div>
          {selectedNode && (
            <SidePanel
              label="Node details"
              eyebrow={<NodeEyebrow n={selectedNode} />}
              title={selectedNode.label}
              onClose={() => setSel(null)}
              actions={<NodeActions n={selectedNode} centre={g.centre} projectId={projectId} onCentre={onCentre} finding={findingFor(selectedNode.id)} canFindings={can('findings', projectId)} />}
            >
              <NodeDetails g={g} n={selectedNode} />
            </SidePanel>
          )}
        </TabPanel>
      )}
      {tab === 'nodes' && (
        <TabPanel idBase="inv" id="nodes" className="flex">
          <NodesTable g={g} projectId={projectId} onCentre={onCentre} findingFor={findingFor} />
        </TabPanel>
      )}
      {tab === 'appear' && (
        <TabPanel idBase="inv" id="appear" className="flex">
          {info.loading && !info.data ? (
            <LoadingState />
          ) : info.error ? (
            <ErrorState error={info.error} onRetry={info.reload} />
          ) : (
            <AppearancesTable rows={appearances} />
          )}
        </TabPanel>
      )}
      {tab === 'links' && (
        <TabPanel idBase="inv" id="links" className="flex flex-col gap-2 px-5 py-3">
          {info.loading && !info.data ? (
            <LoadingState />
          ) : info.error ? (
            <ErrorState error={info.error} onRetry={info.reload} />
          ) : links.length === 0 ? (
            <EmptyState title="No entity links" description="No maintainer, org, funder or incident links touch this node in the latest scans." />
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {links.map((l, i) => (
                <li key={`${l.from}-${l.entityId}-${l.relation}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 text-[13px]">
                  <span className="font-mono">
                    {l.from} → {l.entityId}
                  </span>
                  <Badge variant="outline">{l.relation}</Badge>
                  <Badge variant={l.reviewed ? 'secondary' : 'outline'} className={l.reviewed ? '' : 'text-warning'}>
                    {l.reviewed ? 'reviewed' : 'unreviewed'}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">confidence {l.confidence.toFixed(2)}</span>
                  {l.method && <span className="text-xs text-muted-foreground">{l.method}</span>}
                  <Evidence urls={l.evidence} />
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-xs text-muted-foreground">
            Links record documented relationships with sources. They are not findings of wrongdoing. Unreviewed links never affect scores.
          </p>
        </TabPanel>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <span>
      <span className="text-muted-foreground">{k}</span> <b className="font-mono font-semibold">{v}</b>
    </span>
  );
}

function NodeEyebrow({ n }: { n: GraphNode }) {
  return (
    <>
      <span>{KIND_LABEL[n.kind] ?? n.kind}</span>
      {n.entityType && <span>· {n.entityType}</span>}
      {n.level && <RiskBadge level={n.level} />}
      {n.kind === 'group' && n.size !== undefined && <span>· {n.size} nodes</span>}
    </>
  );
}

function NodeActions({ n, centre, projectId, onCentre, finding, canFindings }: {
  n: GraphNode;
  centre: string;
  projectId: string;
  onCentre: (id: string) => void;
  finding: InvestigateNodeResponse['appearances'][number] | null;
  canFindings: boolean;
}) {
  return (
    <>
      {canCentre(n) && n.id !== centre && (
        <Button size="xs" variant="outline" onClick={() => onCentre(n.id)}>
          Centre graph here
        </Button>
      )}
      {finding && canFindings && (
        <ButtonLink size="xs" variant="ghost" to={projectPath(projectId, `findings/${encodeURIComponent(finding.findingId)}`)}>
          Open finding
        </ButtonLink>
      )}
    </>
  );
}

function Evidence({ urls }: { urls?: string[] }) {
  if (!urls || urls.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-2 text-xs">
      {urls.slice(0, 5).map((u, i) => {
        const href = safeHref(u);
        return href ? (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all">
            source {i + 1}
          </a>
        ) : (
          <span key={i} className="break-all text-muted-foreground">
            {u}
          </span>
        );
      })}
    </span>
  );
}

export function NodeDetails({ g, n }: { g: GraphResponse; n: GraphNode }) {
  const { incoming, outgoing } = edgesOf(g, n.id);
  const label = (id: string) => g.nodes.find((x) => x.id === id)?.label ?? id;
  const section = (title: string, edges: typeof incoming, dir: 'from' | 'to') => (
    <div className="flex flex-col gap-1">
      <h3 className="m-0 text-xs font-medium text-muted-foreground">
        {title} ({edges.length})
      </h3>
      {edges.length === 0 ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {edges.map((e, i) => (
            <li key={i} className="flex flex-col gap-0.5 rounded-md border px-2 py-1.5">
              <span className="break-all font-mono">{label(dir === 'from' ? e.from : e.to)}</span>
              <span className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                <span>{e.relation}</span>
                {e.confidence !== undefined && <span>· confidence {e.confidence.toFixed(2)}</span>}
                {e.reviewed !== undefined && <span className={e.reviewed ? '' : 'text-warning'}>· {e.reviewed ? 'reviewed' : 'unreviewed'}</span>}
              </span>
              <Evidence urls={e.evidence} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="break-all font-mono text-xs text-muted-foreground">{n.id}</div>
      {n.kind === 'group' && <p className="m-0">These nodes were folded together because the graph hit the tier's node cap ({g.cap}). Centre on a nearby node to see them.</p>}
      {section('Incoming', incoming, 'from')}
      {section('Outgoing', outgoing, 'to')}
    </div>
  );
}

const LEVEL_RANK: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function NodesTable({ g, projectId, onCentre, findingFor }: {
  g: GraphResponse;
  projectId: string;
  onCentre: (id: string) => void;
  findingFor: (purl: string) => InvestigateNodeResponse['appearances'][number] | null;
}) {
  const { can } = useAuth();
  const degree = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of g.edges) {
      m.set(e.from, (m.get(e.from) ?? 0) + 1);
      m.set(e.to, (m.get(e.to) ?? 0) + 1);
    }
    return m;
  }, [g]);
  const columns = useMemo<ColumnDef<GraphNode, any>[]>(
    () => [
      {
        id: 'label',
        accessorFn: (n) => n.label,
        header: 'Node',
        cell: ({ row }) => (
          <span className={cn('font-mono', row.original.id === g.centre && 'font-semibold')}>
            {row.original.label}
            {row.original.id === g.centre && <span className="ml-1.5 font-sans text-xs text-muted-foreground">(centre)</span>}
          </span>
        ),
      },
      { id: 'kind', accessorFn: (n) => KIND_LABEL[n.kind] ?? n.kind, header: 'Kind' },
      {
        id: 'level',
        accessorFn: (n) => (n.level ? LEVEL_RANK[n.level] : 9),
        header: 'Risk',
        cell: ({ row }) => (row.original.level ? <RiskBadge level={row.original.level} /> : <span className="text-muted-foreground">—</span>),
      },
      { id: 'edges', accessorFn: (n) => degree.get(n.id) ?? 0, header: 'Edges', meta: { align: 'right' } },
    ],
    [g, degree],
  );
  return (
    <DataTable
      label="Graph nodes"
      data={g.nodes}
      columns={columns}
      getRowId={(n) => n.id}
      filterPlaceholder="Filter nodes…"
      renderPanel={(n, close) => (
        <SidePanel
          label="Node details"
          eyebrow={<NodeEyebrow n={n} />}
          title={n.label}
          onClose={close}
          actions={<NodeActions n={n} centre={g.centre} projectId={projectId} onCentre={onCentre} finding={findingFor(n.id)} canFindings={can('findings', projectId)} />}
        >
          <NodeDetails g={g} n={n} />
        </SidePanel>
      )}
    />
  );
}

function AppearancesTable({ rows }: { rows: InvestigateNodeResponse['appearances'] }) {
  const { can } = useAuth();
  const columns = useMemo<ColumnDef<InvestigateNodeResponse['appearances'][number], any>[]>(
    () => [
      { id: 'project', accessorFn: (a) => a.projectName, header: 'Project', cell: ({ getValue }) => <span className="font-mono">{getValue()}</span> },
      {
        id: 'purl',
        accessorFn: (a) => a.purl,
        header: 'Finding',
        cell: ({ row }) =>
          can('findings', row.original.projectId) ? (
            <Link to={projectPath(row.original.projectId, `findings/${encodeURIComponent(row.original.findingId)}`)} className="font-mono">
              {row.original.purl}
            </Link>
          ) : (
            <span className="font-mono">{row.original.purl}</span>
          ),
      },
      { id: 'via', accessorFn: (a) => a.via, header: 'Via' },
      { id: 'assets', accessorFn: (a) => a.assets, header: 'Assets', meta: { align: 'right' } },
      {
        id: 'score',
        accessorFn: (a) => a.score,
        header: 'Risk',
        cell: ({ row }) => <RiskBadge level={row.original.level} score={row.original.score} />,
      },
    ],
    [can],
  );
  return (
    <DataTable
      label="Where it appears"
      data={rows}
      columns={columns}
      getRowId={(a) => `${a.projectId}:${a.findingId}`}
      initialSorting={[{ id: 'score', desc: true }]}
      emptyTitle="Not in any finding"
      emptyDescription="This node does not appear in a finding in the latest scans you can see."
    />
  );
}
