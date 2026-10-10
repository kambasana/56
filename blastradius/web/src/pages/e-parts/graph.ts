/** Pure helpers for the Investigate screen. */
import type { GraphEdge, GraphNode, GraphResponse, InvestigateSearchResponse } from '@server/api-types';

export interface GraphSummary {
  shown: number;
  /** Nodes folded into group nodes because of the tier's cap. */
  dropped: number;
  total: number;
  groups: { label: string; size: number }[];
  byKind: Record<string, number>;
}

export function summarise(g: GraphResponse): GraphSummary {
  const groups = g.nodes.filter((n) => n.kind === 'group').map((n) => ({ label: n.label, size: n.size ?? 0 }));
  const dropped = groups.reduce((s, x) => s + x.size, 0);
  const shown = g.nodes.length - groups.length;
  const byKind: Record<string, number> = {};
  for (const n of g.nodes) if (n.kind !== 'group') byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  return { shown, dropped, total: shown + dropped, groups, byKind };
}

export function edgesOf(g: GraphResponse, id: string): { incoming: GraphEdge[]; outgoing: GraphEdge[] } {
  return { incoming: g.edges.filter((e) => e.to === id), outgoing: g.edges.filter((e) => e.from === id) };
}

/** Nodes the Investigate API can re-centre on (assets and groups cannot). */
export function canCentre(n: Pick<GraphNode, 'kind'>): boolean {
  return n.kind === 'component' || n.kind === 'entity' || n.kind === 'incident';
}

export const KIND_LABEL: Record<string, string> = {
  asset: 'Asset',
  component: 'Component',
  entity: 'Entity',
  incident: 'Incident',
  group: 'Group',
};

export const SEARCH_GROUPS: { kind: InvestigateSearchResponse['items'][number]['kind']; label: string }[] = [
  { kind: 'component', label: 'Packages' },
  { kind: 'entity', label: 'People, orgs and funders' },
  { kind: 'incident', label: 'Incidents' },
];

export function groupResults(items: InvestigateSearchResponse['items']) {
  return SEARCH_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.kind === g.kind) })).filter((g) => g.items.length > 0);
}
