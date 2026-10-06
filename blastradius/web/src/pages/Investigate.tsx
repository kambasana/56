/**
 * Investigate (canvas: Investigate.dc.html, Graph*.dc.html). Search a project's latest scan for
 * a package, person, org, funder or incident, or arrive with ?finding=<id> from a finding, and
 * see a Cytoscape graph scoped to that ONE node: asset -> deps -> maintainers/orgs/funders ->
 * incidents. Never estate-wide: nothing is drawn until something is picked, and the server caps
 * nodes at the project tier's graphNodeCap (what was dropped is listed).
 *
 * The graph sits in a Card with a toolbar (layout ToggleGroup, zoom and fit Buttons); node
 * details open in a Sheet. A keyboard-accessible Nodes table mirrors the graph.
 */
import { useDeferredValue, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Maximize2Icon, SearchIcon, TriangleAlertIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import type { GraphNode, GraphResponse, InvestigateNodeResponse, RiskLevel } from '@server/api-types';
import { api, isApiError } from '@/api';
import { useAuth } from '@/auth';
import { Badge, RiskBadge } from '@/components/Badge';
import { ButtonLink } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { SidePanel } from '@/components/SidePanel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtNum } from '@/lib/cn';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/useApi';
import { useProject } from '@/project';
import { canCentre, edgesOf, groupResults, KIND_LABEL, summarise } from './e-parts/graph';
import { InvestigateGraph, type GraphControls, type GraphLayout } from './e-parts/InvestigateGraph';
import { safeHref } from './e-parts/ui';

type Tab = 'graph' | 'nodes' | 'appear' | 'links';

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
    <TooltipProvider delayDuration={150}>
      <PageHeader crumbs={crumbs} title="Investigate" meta="graphs are scoped to one finding or entity" />
      <div className="flex min-h-0 grow flex-wrap">
        <aside aria-label="Results" className="flex max-h-[85vh] min-w-0 flex-[1_1_240px] flex-col border-r lg:max-w-[300px]">
          <div className="flex flex-col gap-1.5 border-b p-3">
            <Label htmlFor={searchId} className="sr-only">
              Search packages, people, orgs, funders and incidents
            </Label>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id={searchId}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Packages, people, orgs, incidents"
                className="h-8 pl-8 font-mono text-[13px]"
              />
            </div>
            <span className="text-xs text-muted-foreground">Scope: {project?.name ?? 'this project'} · latest scan</span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="py-2">
              {dq.length >= 2 ? (
                search.loading && !search.data ? (
                  <ResultsSkeleton />
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
                  <p className="px-4 pb-2 text-xs text-muted-foreground">Type at least 2 characters to search, or start from a top finding.</p>
                  {suggestions.loading && !suggestions.data && canFindings && <ResultsSkeleton />}
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
                  {suggestions.error && <p className="px-4 text-xs text-muted-foreground">Top findings could not be loaded.</p>}
                </>
              )}
            </div>
          </ScrollArea>
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
    </TooltipProvider>
  );
}

function ResultsSkeleton() {
  return (
    <div role="status" aria-label="Searching…" className="flex flex-col gap-2 px-4 py-2">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex flex-col gap-1">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
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
    <div role="group" aria-label={label} className="flex flex-col gap-0.5 px-2 pb-2">
      <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {items.map((it) => {
        const on = it.key === selectedKey;
        return (
          <Button
            key={it.key}
            type="button"
            variant="ghost"
            aria-pressed={on}
            onClick={it.onPick}
            className={cn('h-auto w-full flex-col items-start gap-0 px-2 py-1.5 text-left font-normal', on && 'bg-accent text-accent-foreground')}
          >
            <span className={cn('max-w-full truncate text-[13px] font-medium', it.mono && 'font-mono')}>{it.name}</span>
            <span className="max-w-full truncate text-xs text-muted-foreground">{it.meta}</span>
          </Button>
        );
      })}
    </div>
  );
}

function DossierSkeleton() {
  return (
    <div role="status" aria-label="Loading graph…" className="flex flex-col gap-3 p-4">
      <span className="sr-only">Loading graph…</span>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-7 w-72" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}

export function Dossier({ projectId, finding, node, onCentre }: { projectId: string; finding: string | null; node: string | null; onCentre: (id: string) => void }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('graph');
  const [layout, setLayout] = useState<GraphLayout>('breadthfirst');
  const controls = useRef<GraphControls>(null);
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
  // Node details open on click (not by default) so the sheet does not cover the graph.
  const [sel, setSel] = useState<string | null>(null);

  if (graph.loading && !g) return <DossierSkeleton />;
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
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-0">
      <div className="flex flex-col gap-1.5 border-b px-4 py-3">
        <span className="text-xs text-muted-foreground">
          {KIND_LABEL[centreNode.kind] ?? centreNode.kind}
          {centreNode.entityType ? ` · ${centreNode.entityType}` : ''}
        </span>
        <h2 className="flex flex-wrap items-center gap-2 font-mono text-lg leading-7 font-semibold break-all">
          {centreNode.label}
          {centreNode.level && <RiskBadge level={centreNode.level} />}
        </h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          <Stat k="Nodes" v={`${fmtNum(sum.shown)}${sum.dropped ? ` of ${fmtNum(sum.total)}` : ''}`} />
          <Stat k="Assets" v={fmtNum(sum.byKind.asset ?? 0)} />
          <Stat k="Components" v={fmtNum(sum.byKind.component ?? 0)} />
          <Stat k="Entities" v={fmtNum((sum.byKind.entity ?? 0) + (sum.byKind.incident ?? 0))} />
          {info.data && <Stat k="Projects" v={fmtNum(projects)} />}
          <Stat k="Cap" v={fmtNum(g.cap)} />
        </div>
        {g.truncated && (
          <Alert role="note" className="mt-1 border-warning/40 py-2 text-warning">
            <TriangleAlertIcon />
            <AlertDescription className="text-[13px] text-warning">
              Capped at {fmtNum(g.cap)} nodes for this project's tier: {fmtNum(sum.dropped)} node{sum.dropped === 1 ? '' : 's'} dropped into groups
              {sum.groups.length > 0 ? ` (${sum.groups.map((x) => x.label.replace(/^\+/, '')).join(', ')})` : ''}. Centre on a node to see its neighbourhood.
            </AlertDescription>
          </Alert>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <TabsList aria-label="Dossier views">
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="nodes">Nodes ({fmtNum(sum.shown + sum.groups.length)})</TabsTrigger>
          <TabsTrigger value="appear" disabled={!centreId}>
            Where it appears{info.data ? ` (${appearances.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="links" disabled={!centreId}>
            Links and sources{info.data ? ` (${links.length})` : ''}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="graph" className="p-4">
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="flex flex-wrap items-center gap-2 border-b px-3 py-2 [.border-b]:pb-2">
            <span id="graph-layout-label" className="text-xs text-muted-foreground">
              Layout
            </span>
            <ToggleGroup type="single" variant="outline" size="sm" aria-labelledby="graph-layout-label" value={layout} onValueChange={(v) => v && setLayout(v as GraphLayout)}>
              <ToggleGroupItem value="breadthfirst">Layered</ToggleGroupItem>
              <ToggleGroupItem value="cose">Force</ToggleGroupItem>
              <ToggleGroupItem value="concentric">Concentric</ToggleGroupItem>
            </ToggleGroup>
            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
            <div role="group" aria-label="Zoom" className="flex items-center gap-1">
              <ToolButton label="Zoom in" onClick={() => controls.current?.zoomIn()}>
                <ZoomInIcon />
              </ToolButton>
              <ToolButton label="Zoom out" onClick={() => controls.current?.zoomOut()}>
                <ZoomOutIcon />
              </ToolButton>
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
              <ToolButton label="Fit to view" onClick={() => controls.current?.fit()}>
                <Maximize2Icon />
              </ToolButton>
            </div>
          </CardHeader>
          <CardContent className="px-0">
            <InvestigateGraph
              graph={g}
              layout={layout}
              selectedId={sel}
              controlsRef={controls}
              height={520}
              onNodeClick={setSel}
              label={`Graph centred on ${centreNode.label}`}
            />
          </CardContent>
          <CardFooter className="flex-wrap gap-x-4 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground [.border-t]:pt-2">
            <GraphLegend />
            <span className="grow" />
            <span>Click a node for details. Dashed edges are unreviewed or low-confidence links; they never affect scores. The Nodes tab lists the same nodes for keyboard use.</span>
          </CardFooter>
        </Card>
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
      </TabsContent>
      <TabsContent value="nodes" className="flex">
        <NodesTable g={g} projectId={projectId} onCentre={onCentre} findingFor={findingFor} />
      </TabsContent>
      <TabsContent value="appear" className="flex">
        {info.error ? (
          <ErrorState error={info.error} onRetry={info.reload} />
        ) : (
          <AppearancesTable rows={appearances} loading={info.loading && !info.data} />
        )}
      </TabsContent>
      <TabsContent value="links" className="flex flex-col gap-2 px-4 py-3">
        {info.loading && !info.data ? (
          <ResultsSkeleton />
        ) : info.error ? (
          <ErrorState error={info.error} onRetry={info.reload} />
        ) : links.length === 0 ? (
          <EmptyState title="No entity links" description="No maintainer, org, funder or incident links touch this node in the latest scans." />
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table aria-label="Entity links" className="text-[13px]">
              <TableHeader className="bg-muted">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 px-4 text-xs text-muted-foreground">Link</TableHead>
                  <TableHead className="h-8 text-xs text-muted-foreground">Relation</TableHead>
                  <TableHead className="h-8 text-xs text-muted-foreground">Review</TableHead>
                  <TableHead className="h-8 text-right text-xs text-muted-foreground">Confidence</TableHead>
                  <TableHead className="h-8 text-xs text-muted-foreground">Method</TableHead>
                  <TableHead className="h-8 px-4 text-xs text-muted-foreground">Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map((l, i) => (
                  <TableRow key={`${l.from}-${l.entityId}-${l.relation}-${i}`}>
                    <TableCell className="px-4 font-mono">
                      {l.from} → {l.entityId}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{l.relation}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={l.reviewed ? 'secondary' : 'outline'} className={l.reviewed ? '' : 'border-warning/40 text-warning'}>
                        {l.reviewed ? 'reviewed' : 'unreviewed'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{l.confidence.toFixed(2)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.method ?? '—'}</TableCell>
                    <TableCell className="px-4">
                      <Evidence urls={l.evidence} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Links record documented relationships with sources. They are not findings of wrongdoing. Unreviewed links never affect scores.</p>
      </TabsContent>
    </Tabs>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const LEGEND_LEVELS: RiskLevel[] = ['critical', 'high', 'medium', 'low'];

function GraphLegend() {
  return (
    <span className="flex flex-wrap items-center gap-1.5" aria-label="Risk colours" role="group">
      {LEGEND_LEVELS.map((l) => (
        <RiskBadge key={l} level={l} className="px-1.5 py-0 text-[11px]" />
      ))}
    </span>
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
        <Button type="button" size="xs" variant="outline" onClick={() => onCentre(n.id)}>
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
          <Button key={i} asChild variant="link" size="xs" className="h-auto p-0">
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              source {i + 1}
            </a>
          </Button>
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
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">
        {title} ({edges.length})
      </h3>
      {edges.length === 0 ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {edges.map((e, i) => (
            <li key={i}>
              <Card className="gap-1 px-3 py-2 shadow-none">
                <span className="font-mono break-all">{label(dir === 'from' ? e.from : e.to)}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline">{e.relation}</Badge>
                  {e.confidence !== undefined && <span>confidence {e.confidence.toFixed(2)}</span>}
                  {e.reviewed !== undefined && <span className={e.reviewed ? '' : 'text-warning'}>· {e.reviewed ? 'reviewed' : 'unreviewed'}</span>}
                </span>
                <Evidence urls={e.evidence} />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="font-mono text-xs break-all text-muted-foreground">{n.id}</div>
      {n.kind === 'group' && <p>These nodes were folded together because the graph hit the tier's node cap ({g.cap}). Centre on a nearby node to see them.</p>}
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
      { id: 'kind', accessorFn: (n) => KIND_LABEL[n.kind] ?? n.kind, header: 'Kind', meta: { facet: {} } },
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

function AppearancesTable({ rows, loading }: { rows: InvestigateNodeResponse['appearances']; loading: boolean }) {
  const { can } = useAuth();
  const columns = useMemo<ColumnDef<InvestigateNodeResponse['appearances'][number], any>[]>(
    () => [
      { id: 'project', accessorFn: (a) => a.projectName, header: 'Project', meta: { facet: {} }, cell: ({ getValue }) => <span className="font-mono">{getValue()}</span> },
      {
        id: 'purl',
        accessorFn: (a) => a.purl,
        header: 'Finding',
        cell: ({ row }) =>
          can('findings', row.original.projectId) ? (
            <Button asChild variant="link" size="xs" className="h-auto p-0 font-mono text-[13px]">
              <Link to={projectPath(row.original.projectId, `findings/${encodeURIComponent(row.original.findingId)}`)}>{row.original.purl}</Link>
            </Button>
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
      loading={loading}
      getRowId={(a) => `${a.projectId}:${a.findingId}`}
      initialSorting={[{ id: 'score', desc: true }]}
      emptyTitle="Not in any finding"
      emptyDescription="This node does not appear in a finding in the latest scans you can see."
    />
  );
}
