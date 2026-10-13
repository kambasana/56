/**
 * Blast Sankey layout (docs/UX.md §10): package → brought in by → projects → environment, width =
 * assets reached. Plain math, no chart library: four columns of stacked nodes and cubic ribbons.
 * Production flows are listed first (top), and the graph never draws more than 50 nodes: above 30
 * projects (or 15 introducers) the tail merges into "+N more".
 */

export interface SankeyFlowIn {
  via: string;
  projectId: string;
  projectName: string;
  production: boolean;
  assets: number;
}

export type SankeyColumn = 0 | 1 | 2 | 3;

export interface SankeyNode {
  id: string;
  column: SankeyColumn;
  label: string;
  /** Sum of the assets through this node. */
  value: number;
  /** For project nodes: the project id ("" for a merged "+N more" node). */
  projectId?: string;
  production: boolean;
  /** "+N more" node standing for `merged` hidden nodes. */
  merged?: number;
  y: number;
  height: number;
}

export interface SankeyLink {
  id: string;
  source: string;
  target: string;
  value: number;
  production: boolean;
  /** Ribbon path (closed shape). */
  d: string;
  /** "event-stream@3.3.6 → payments-platform · runtime · 1 asset" */
  title: string;
}

export interface SankeyLayout {
  width: number;
  height: number;
  nodeWidth: number;
  columnsX: [number, number, number, number];
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** Projects (leaves) hidden behind "+N more". */
  hiddenProjects: number;
}

export const MAX_PROJECTS = 30;
export const MAX_VIAS = 15;
export const PROD_LABEL = 'Production';
export const DEV_LABEL = 'Dev and test';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Agg {
  key: string;
  label: string;
  value: number;
  production: boolean;
  projectId?: string;
  merged?: number;
}

/** Rank keys production first, then by value, keeping the top `max` and merging the rest. */
function capped(aggs: Agg[], max: number, mergedLabel: (n: number) => string, mergedKey: string): { kept: Agg[]; map: Map<string, string>; hidden: number } {
  const sorted = [...aggs].sort((a, b) => Number(b.production) - Number(a.production) || b.value - a.value || a.label.localeCompare(b.label));
  const map = new Map<string, string>();
  if (sorted.length <= max) {
    for (const a of sorted) map.set(a.key, a.key);
    return { kept: sorted, map, hidden: 0 };
  }
  const kept = sorted.slice(0, max);
  const rest = sorted.slice(max);
  for (const a of kept) map.set(a.key, a.key);
  for (const a of rest) map.set(a.key, mergedKey);
  kept.push({ key: mergedKey, label: mergedLabel(rest.length), value: rest.reduce((n, a) => n + a.value, 0), production: rest.some((a) => a.production), merged: rest.length });
  return { kept, map, hidden: rest.length };
}

function ribbon(x0: number, y0: number, x1: number, y1: number, h: number): string {
  const mx = (x0 + x1) / 2;
  return `M${x0} ${y0} C${mx} ${y0} ${mx} ${y1} ${x1} ${y1} L${x1} ${y1 + h} C${mx} ${y1 + h} ${mx} ${y0 + h} ${x0} ${y0 + h} Z`;
}

export function layoutSankey(pkg: { label: string }, flowsIn: readonly SankeyFlowIn[], opts: { width?: number; height?: number; nodeWidth?: number; gap?: number } = {}): SankeyLayout {
  const width = opts.width ?? 720;
  const nodeWidth = opts.nodeWidth ?? 14;
  const gap = opts.gap ?? 10;
  const flows = flowsIn.filter((f) => f.assets > 0);
  const total = flows.reduce((n, f) => n + f.assets, 0);

  const viaAgg = new Map<string, Agg>();
  const projAgg = new Map<string, Agg>();
  for (const f of flows) {
    const v = viaAgg.get(f.via) ?? { key: `via:${f.via}`, label: f.via === '(direct)' ? 'Direct dependency' : f.via, value: 0, production: false };
    v.value += f.assets;
    v.production ||= f.production;
    viaAgg.set(f.via, v);
    const p = projAgg.get(f.projectId) ?? { key: `project:${f.projectId}`, label: f.projectName, value: 0, production: false, projectId: f.projectId };
    p.value += f.assets;
    p.production ||= f.production;
    projAgg.set(f.projectId, p);
  }
  const vias = capped([...viaAgg.values()], MAX_VIAS, (n) => `+${n} more`, 'via:+more');
  const projects = capped([...projAgg.values()], MAX_PROJECTS, (n) => `+${plural(n, 'more project')}`, 'project:+more');
  const prodValue = flows.filter((f) => f.production).reduce((n, f) => n + f.assets, 0);
  const envs: Agg[] = [];
  if (prodValue > 0) envs.push({ key: 'env:prod', label: PROD_LABEL, value: prodValue, production: true });
  if (total - prodValue > 0) envs.push({ key: 'env:dev', label: DEV_LABEL, value: total - prodValue, production: false });

  const columns: Agg[][] = [[{ key: 'pkg', label: pkg.label, value: total, production: prodValue > 0 }], vias.kept, projects.kept, envs];
  const maxCount = Math.max(...columns.map((c) => c.length), 1);
  const top = 24;
  const budget = opts.height ?? Math.max(160, Math.min(560, maxCount * 34 + 40));
  const usable = budget - top - 8;
  // Thin flows stay thin: at most 28px per asset, so one asset is not a wall.
  const scale = total > 0 ? Math.min(28, Math.max(0, (usable - gap * (maxCount - 1)) / total)) : 0;
  const columnsX: SankeyLayout['columnsX'] = [0, Math.round(width * 0.28), Math.round(width * 0.56), Math.round(width * 0.8)];

  const nodes: SankeyNode[] = [];
  const byKey = new Map<string, SankeyNode>();
  columns.forEach((col, ci) => {
    let y = top;
    for (const a of col) {
      const h = Math.max(4, a.value * scale);
      const n: SankeyNode = {
        id: a.key,
        column: ci as SankeyColumn,
        label: a.label,
        value: a.value,
        production: a.production,
        ...(a.projectId !== undefined ? { projectId: a.projectId } : a.merged !== undefined && ci === 2 ? { projectId: '' } : {}),
        ...(a.merged !== undefined ? { merged: a.merged } : {}),
        y,
        height: h,
      };
      nodes.push(n);
      byKey.set(a.key, n);
      y += h + gap;
    }
  });

  // Links per column pair, aggregated after merging, production first.
  type L = { source: string; target: string; value: number; production: boolean; kinds: Set<string> };
  const pairs = new Map<string, L>();
  const add = (source: string, target: string, value: number, production: boolean) => {
    const k = `${source}\u0000${target}`;
    const l = pairs.get(k) ?? { source, target, value: 0, production: false, kinds: new Set<string>() };
    l.value += value;
    l.production ||= production;
    l.kinds.add(production ? 'runtime' : 'dev');
    pairs.set(k, l);
  };
  for (const f of flows) {
    const via = vias.map.get(`via:${f.via}`)!;
    const proj = projects.map.get(`project:${f.projectId}`)!;
    add('pkg', via, f.assets, f.production);
    add(via, proj, f.assets, f.production);
    add(proj, f.production ? 'env:prod' : 'env:dev', f.assets, f.production);
  }
  const order = new Map(nodes.map((n, i) => [n.id, i] as const));
  const ordered = [...pairs.values()].sort((a, b) => order.get(a.source)! - order.get(b.source)! || order.get(a.target)! - order.get(b.target)!);
  const outOffset = new Map<string, number>();
  const inOffset = new Map<string, number>();
  // Incoming offsets follow the source order so ribbons do not cross more than needed.
  const inOrder = [...ordered].sort((a, b) => order.get(a.target)! - order.get(b.target)! || order.get(a.source)! - order.get(b.source)!);
  const inY = new Map<L, number>();
  for (const l of inOrder) {
    const t = byKey.get(l.target)!;
    const off = inOffset.get(l.target) ?? 0;
    inY.set(l, t.y + off);
    inOffset.set(l.target, off + l.value * scale);
  }
  const links: SankeyLink[] = ordered.map((l, i) => {
    const s = byKey.get(l.source)!;
    const t = byKey.get(l.target)!;
    const off = outOffset.get(l.source) ?? 0;
    outOffset.set(l.source, off + l.value * scale);
    const h = Math.max(1, l.value * scale);
    const x0 = columnsX[s.column] + nodeWidth;
    const x1 = columnsX[t.column];
    return {
      id: `l${i}`,
      source: l.source,
      target: l.target,
      value: l.value,
      production: l.production,
      d: ribbon(x0, s.y + off, x1, inY.get(l)!, h),
      title: `${s.label} → ${t.label} · ${[...l.kinds].join(' and ')} · ${plural(l.value, 'asset')}`,
    };
  });
  const bottom = Math.max(...nodes.map((n) => n.y + n.height), top);
  const height = opts.height ?? Math.max(110, Math.ceil(bottom + 26));
  return { width, height, nodeWidth, columnsX, nodes, links, hiddenProjects: projects.hidden };
}
