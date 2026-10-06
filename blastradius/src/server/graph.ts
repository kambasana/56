/**
 * Scoped graphs and Investigate lookups (PLAN §12: never estate-wide). Built from the stored
 * engine findings and, when kept, the scan inventory. Every graph is capped at the project
 * tier's graphNodeCap; overflow collapses into "group" nodes and `truncated` is set.
 */
import type { EntityChainEntry, Finding, Inventory, RiskLevel } from '../core/types.js';
import type { GraphEdge, GraphNode, GraphResponse, InvestigateNodeResponse, InvestigateSearchResponse } from './api-types.js';

/** `pkg:npm/@scope/name@1.2.3?x=y` -> `pkg:npm/@scope/name`. */
export function unversionedPurl(purl: string): string {
  const noQ = purl.split(/[?#]/)[0] ?? purl;
  const slash = noQ.lastIndexOf('/');
  const at = noQ.indexOf('@', slash + 1);
  return at === -1 ? noQ : noQ.slice(0, at);
}

export function purlLabel(purl: string): string {
  const noQ = purl.split(/[?#]/)[0] ?? purl;
  return noQ.replace(/^pkg:[^/]+\//, '');
}

export interface ScanFindingSet {
  projectId: string;
  projectName: string;
  /** finding row id by purl. */
  findingIds: Map<string, string>;
  findings: Finding[];
  inventory: Inventory | null;
  assetNames: Map<string, string>;
}

class GraphBuilder {
  readonly nodes = new Map<string, GraphNode & { prio: number }>();
  readonly edges = new Map<string, GraphEdge>();

  node(n: GraphNode, prio: number): void {
    const prev = this.nodes.get(n.id);
    if (!prev) this.nodes.set(n.id, { ...n, prio });
    else if (prio < prev.prio || (n.level && !prev.level)) this.nodes.set(n.id, { ...prev, ...n, prio: Math.min(prio, prev.prio) });
  }

  edge(e: GraphEdge): void {
    const key = `${e.from}\u0000${e.to}\u0000${e.relation}`;
    if (!this.edges.has(key)) this.edges.set(key, e);
  }

  /** Apply the cap: keep the highest-priority nodes, collapse the rest into one group per kind. */
  build(centre: string, cap: number): GraphResponse {
    const all = [...this.nodes.values()];
    let truncated = false;
    let kept = all;
    const redirect = new Map<string, string>();
    if (all.length > cap) {
      truncated = true;
      const sorted = [...all].sort((a, b) => a.prio - b.prio || (a.id === centre ? -1 : b.id === centre ? 1 : 0));
      // Leave room for up to one group node per dropped kind.
      const droppedKinds = new Set<string>();
      let keepCount = Math.max(1, cap);
      for (;;) {
        droppedKinds.clear();
        for (const n of sorted.slice(keepCount)) droppedKinds.add(n.kind);
        if (keepCount + droppedKinds.size <= cap || keepCount <= 1) break;
        keepCount--;
      }
      kept = sorted.slice(0, keepCount);
      const dropped = sorted.slice(keepCount);
      const groups = new Map<string, GraphNode & { prio: number }>();
      for (const n of dropped) {
        const gid = `group:${n.kind}`;
        const g = groups.get(gid) ?? { id: gid, kind: 'group' as const, label: '', size: 0, prio: 99 };
        g.size = (g.size ?? 0) + 1;
        groups.set(gid, g);
        redirect.set(n.id, gid);
      }
      for (const g of groups.values()) {
        const kind = g.id.slice('group:'.length);
        g.label = `+${g.size} more ${kind === 'component' ? 'components' : kind === 'asset' ? 'assets' : kind === 'incident' ? 'incidents' : 'entities'}`;
        kept.push(g);
      }
    }
    const edges = new Map<string, GraphEdge>();
    for (const e of this.edges.values()) {
      const from = redirect.get(e.from) ?? e.from;
      const to = redirect.get(e.to) ?? e.to;
      if (from === to) continue;
      const key = `${from}\u0000${to}\u0000${e.relation}`;
      if (!edges.has(key)) edges.set(key, { ...e, from, to });
    }
    return {
      centre,
      nodes: kept.map(({ prio: _prio, ...n }) => n),
      edges: [...edges.values()],
      cap,
      truncated,
    };
  }
}

function scopeIndex(inv: Inventory | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of inv?.edges ?? []) m.set(`${e.from}\u0000${e.to}`, e.scope);
  return m;
}

function levelIndex(findings: readonly Finding[]): Map<string, RiskLevel> {
  return new Map(findings.map((f) => [f.purl, f.level] as const));
}

/** Entity / incident nodes and edges for one finding's chain. */
function addChain(g: GraphBuilder, f: Finding, prio: number): void {
  const unv = unversionedPurl(f.purl);
  for (const link of f.entityChain ?? []) {
    const from = link.from === undefined || link.from === unv ? f.purl : link.from;
    const isIncident = link.relation === 'incident';
    g.node({ id: link.entityId, kind: isIncident ? 'incident' : 'entity', label: link.entityId, ...(isIncident ? {} : entityTypeOf(link.entityId)) }, prio);
    if (from !== f.purl && !g.nodes.has(from)) g.node({ id: from, kind: from.startsWith('pkg:') ? 'component' : 'entity', label: from.startsWith('pkg:') ? purlLabel(from) : from }, prio);
    g.edge({
      from,
      to: link.entityId,
      relation: link.relation,
      confidence: link.confidence,
      ...(link.reviewed !== undefined ? { reviewed: link.reviewed } : {}),
      ...(link.evidence ? { evidence: link.evidence.slice(0, 20) } : {}),
    });
  }
}

function entityTypeOf(id: string): Pick<GraphNode, 'entityType'> {
  const prefix = id.split(':')[0];
  if (prefix === 'person' || prefix === 'org' || prefix === 'funder' || prefix === 'account') return { entityType: prefix };
  return {};
}

/** Graph centred on one finding: its assets, the dependency paths to it, and its entity chain. */
export function findingGraph(f: Finding, set: Pick<ScanFindingSet, 'findings' | 'inventory' | 'assetNames'>, cap: number): GraphResponse {
  const g = new GraphBuilder();
  const levels = levelIndex(set.findings);
  const scopes = scopeIndex(set.inventory);
  g.node({ id: f.purl, kind: 'component', label: purlLabel(f.purl), level: f.level }, 0);
  addChain(g, f, 1);
  for (const a of f.blastRadius?.assets ?? []) {
    g.node({ id: a.assetId, kind: 'asset', label: set.assetNames.get(a.assetId) ?? a.assetId }, 2);
    for (const p of a.paths) {
      for (let i = 0; i + 1 < p.length; i++) {
        const from = p[i]!;
        const to = p[i + 1]!;
        if (i + 1 < p.length - 1 || to !== f.purl) {
          const lvl = levels.get(to);
          g.node({ id: to, kind: 'component', label: purlLabel(to), ...(lvl ? { level: lvl } : {}) }, 3 + i);
        }
        g.edge({ from, to, relation: scopes.get(`${from}\u0000${to}`) ?? 'depends_on' });
      }
    }
  }
  return g.build(f.purl, cap);
}

/**
 * Graph centred on a component (purl, versioned or not) or an entity / incident id, within one
 * project's latest scan. Returns null when the node does not occur in it.
 */
export function nodeGraph(nodeId: string, set: ScanFindingSet, cap: number): GraphResponse | null {
  if (nodeId.startsWith('pkg:')) {
    const exact = set.findings.find((f) => f.purl === nodeId) ?? set.findings.find((f) => unversionedPurl(f.purl) === nodeId);
    if (exact) return findingGraph(exact, set, cap);
    const comp = set.inventory?.components.find((c) => c.purl === nodeId || unversionedPurl(c.purl) === nodeId);
    if (!comp || !set.inventory) return null;
    const g = new GraphBuilder();
    const levels = levelIndex(set.findings);
    g.node({ id: comp.purl, kind: 'component', label: purlLabel(comp.purl) }, 0);
    for (const e of set.inventory.edges) {
      if (e.to === comp.purl) {
        const isAsset = !e.from.startsWith('pkg:');
        const lvl = levels.get(e.from);
        g.node({ id: e.from, kind: isAsset ? 'asset' : 'component', label: isAsset ? (set.assetNames.get(e.from) ?? e.from) : purlLabel(e.from), ...(lvl ? { level: lvl } : {}) }, 1);
        g.edge({ from: e.from, to: e.to, relation: e.scope });
      } else if (e.from === comp.purl) {
        const lvl = levels.get(e.to);
        g.node({ id: e.to, kind: 'component', label: purlLabel(e.to), ...(lvl ? { level: lvl } : {}) }, 2);
        g.edge({ from: e.from, to: e.to, relation: e.scope });
      }
    }
    return g.build(comp.purl, cap);
  }
  const touching = set.findings.filter((f) => (f.entityChain ?? []).some((l) => l.entityId === nodeId || l.from === nodeId));
  if (touching.length === 0) return null;
  const g = new GraphBuilder();
  const isIncident = touching.some((f) => f.entityChain.some((l) => l.entityId === nodeId && l.relation === 'incident'));
  g.node({ id: nodeId, kind: isIncident ? 'incident' : 'entity', label: nodeId, ...(isIncident ? {} : entityTypeOf(nodeId)) }, 0);
  for (const f of touching) {
    g.node({ id: f.purl, kind: 'component', label: purlLabel(f.purl), level: f.level }, 1);
    addChain(g, f, 2);
  }
  return g.build(nodeId, cap);
}

/** Search one project's latest scan for components, entities and incidents. */
export function investigateSearch(q: string, set: ScanFindingSet, limit = 50): InvestigateSearchResponse {
  const needle = q.trim().toLowerCase();
  const items: InvestigateSearchResponse['items'] = [];
  if (!needle) return { items };
  const seen = new Set<string>();
  const findingByPurl = new Map(set.findings.map((f) => [f.purl, f] as const));
  for (const f of set.findings) {
    if (items.length >= limit) break;
    if (f.purl.toLowerCase().includes(needle) && !seen.has(f.purl)) {
      seen.add(f.purl);
      items.push({ kind: 'component', id: f.purl, label: purlLabel(f.purl), meta: `${f.level} · score ${f.score}` });
    }
  }
  for (const c of set.inventory?.components ?? []) {
    if (items.length >= limit) break;
    if (!seen.has(c.purl) && c.purl.toLowerCase().includes(needle)) {
      seen.add(c.purl);
      items.push({ kind: 'component', id: c.purl, label: purlLabel(c.purl), meta: findingByPurl.has(c.purl) ? 'finding' : 'no finding' });
    }
  }
  const counts = new Map<string, { kind: 'entity' | 'incident'; n: number }>();
  for (const f of set.findings) {
    const ids = new Set<string>();
    for (const l of f.entityChain ?? []) {
      ids.add(`${l.relation === 'incident' ? 'incident' : 'entity'}\u0000${l.entityId}`);
      if (l.from && !l.from.startsWith('pkg:')) ids.add(`entity\u0000${l.from}`);
    }
    for (const k of ids) {
      const [kind, id] = k.split('\u0000') as ['entity' | 'incident', string];
      const prev = counts.get(id);
      counts.set(id, { kind: prev?.kind === 'incident' ? 'incident' : kind, n: (prev?.n ?? 0) + 1 });
    }
  }
  for (const [id, v] of counts) {
    if (items.length >= limit) break;
    if (!seen.has(id) && id.toLowerCase().includes(needle)) {
      seen.add(id);
      items.push({ kind: v.kind, id, label: id, meta: `${v.kind} · ${v.n} finding${v.n === 1 ? '' : 's'}` });
    }
  }
  return { items };
}

/** Where a node appears across the given scans, and every chain link touching it. */
export function investigateNode(nodeId: string, sets: readonly ScanFindingSet[]): InvestigateNodeResponse | null {
  const isPurl = nodeId.startsWith('pkg:');
  const appearances: InvestigateNodeResponse['appearances'] = [];
  const links = new Map<string, EntityChainEntry & { from: string }>();
  let kind: InvestigateNodeResponse['kind'] = isPurl ? 'component' : 'entity';
  let known = false;
  for (const set of sets) {
    // Inventory membership is per set: checked once, so sets without findings still count.
    if (isPurl && !known && set.inventory?.components.some((c) => c.purl === nodeId || unversionedPurl(c.purl) === nodeId)) known = true;
    for (const f of set.findings) {
      const unv = unversionedPurl(f.purl);
      const findingId = set.findingIds.get(f.purl);
      let via: string | null = null;
      if (isPurl && (f.purl === nodeId || unv === nodeId)) via = 'component';
      for (const l of f.entityChain ?? []) {
        const from = l.from ?? unv;
        if (l.entityId === nodeId || from === nodeId || (isPurl && (from === unversionedPurl(nodeId)))) {
          links.set(`${from}\u0000${l.entityId}\u0000${l.relation}`, { ...l, from });
          if (!isPurl && l.entityId === nodeId && l.relation === 'incident') kind = 'incident';
          via ??= `entity chain (${l.relation})`;
        }
      }
      if (via && findingId) {
        appearances.push({
          projectId: set.projectId,
          projectName: set.projectName,
          findingId,
          purl: f.purl,
          via,
          assets: f.blastRadius?.assets.length ?? 0,
          level: f.level,
          score: f.score,
        });
      }
    }
  }
  if (appearances.length === 0 && links.size === 0 && !known) return null;
  appearances.sort((a, b) => b.score - a.score);
  return { id: nodeId, kind, label: isPurl ? purlLabel(nodeId) : nodeId, appearances: appearances.slice(0, 500), links: [...links.values()].slice(0, 500) };
}
