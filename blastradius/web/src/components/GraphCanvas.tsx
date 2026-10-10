/**
 * The one Cytoscape renderer for scoped graphs (GET /api/graph?finding= or ?project=&node=).
 * Graphs are always scoped to one finding or entity (PLAN §12), never estate-wide.
 * `ScopedGraph` (finding page) and `InvestigateGraph` (Investigate) are thin wrappers.
 *
 * Import this file (or a wrapper) directly from a page, not from the components barrel, so
 * Cytoscape is bundled only into the pages that draw graphs. Labels are passed as data, so
 * Cytoscape renders them as canvas text: untrusted values are never parsed as HTML.
 *
 * Colours come from the theme CSS variables (--foreground, --muted-foreground, --card, --ring,
 * --level-*), resolved to opaque rgb() (Cytoscape cannot parse oklch()), and are re-read whenever
 * <html>'s class or style changes so the canvas follows light/dark mode.
 *
 * Labels never overlap: the layered layout wraps wide layers into rows, long labels end in an ellipsis,
 * and after the layout a separation pass (separateBoxes) pushes apart any node + label boxes
 * that still collide. Percent-escapes in labels (purls such as %40scope/name) are decoded for display.
 *
 * Once the layout has run, the container carries data-graph-ready="true" and data-node-count,
 * so tests and screenshots can wait for a rendered graph rather than a fixed delay.
 */
import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from 'cytoscape';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { GraphNodeKind, GraphResponse, RiskLevel } from '@server/api-types';
import { cn } from '@/lib/utils';
import { toRgb } from '@/lib/css-color';

export type GraphLayout = 'breadthfirst' | 'cose' | 'concentric';

export interface GraphControls {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}

export interface GraphCanvasProps {
  graph: GraphResponse;
  /** 'breadthfirst' (tree from the centre, default), 'cose' (force) or 'concentric'. */
  layout?: GraphLayout;
  /** Node to show as selected. */
  selectedId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  /** Optional zoom / fit controls. */
  controlsRef?: Ref<GraphControls>;
  height?: number | string;
  label?: string;
  className?: string;
}

export const GRAPH_PADDING = 24;

export const LEVEL_VAR: Record<RiskLevel, string> = { critical: '--level-critical', high: '--level-high', medium: '--level-medium', low: '--level-low' };
export const KIND_SHAPE: Record<GraphNodeKind, string> = { asset: 'round-rectangle', component: 'ellipse', entity: 'diamond', incident: 'triangle', group: 'barrel' };

function cssVar(name: string): string {
  return typeof window === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A theme token as an opaque rgb() over the card colour (the canvas background). */
function themeColor(name: string, fallback: string): string {
  const card = toRgb(cssVar('--card') || '#fff');
  return toRgb(cssVar(name) || fallback, card);
}

/** Text shown for a node: percent-escapes decoded ("%40vue/cli" -> "@vue/cli"); display only. */
export function displayLabel(label: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(label)) return label;
  try {
    return decodeURIComponent(label);
  } catch {
    return label;
  }
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Offsets that move axis-aligned boxes (a node with its label) apart until no two overlap,
 * keeping at least `gap` between them. Each overlapping pair is split along its smaller overlap,
 * half to each box. Sweep over x-sorted boxes, so a few hundred nodes stay cheap.
 */
export function separateBoxes(boxes: readonly Box[], { gap = 4, iterations = 80 }: { gap?: number; iterations?: number } = {}): { dx: number; dy: number }[] {
  const n = boxes.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    order.sort((a, b) => boxes[a]!.x1 + dx[a]! - (boxes[b]!.x1 + dx[b]!));
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi]!;
      for (let oj = oi + 1; oj < n; oj++) {
        const j = order[oj]!;
        const a = boxes[i]!;
        const b = boxes[j]!;
        const ax1 = a.x1 + dx[i]!, ax2 = a.x2 + dx[i]!, ay1 = a.y1 + dy[i]!, ay2 = a.y2 + dy[i]!;
        const bx1 = b.x1 + dx[j]!, bx2 = b.x2 + dx[j]!, by1 = b.y1 + dy[j]!, by2 = b.y2 + dy[j]!;
        if (bx1 >= ax2 + gap) break; // sorted by x1: nothing further right can overlap i
        const ox = Math.min(ax2, bx2) - Math.max(ax1, bx1) + gap;
        const oy = Math.min(ay2, by2) - Math.max(ay1, by1) + gap;
        if (ox <= 0.01 || oy <= 0.01) continue;
        moved = true;
        if (ox < oy) {
          const dir = ax1 + ax2 <= bx1 + bx2 ? 1 : -1;
          dx[i] = dx[i]! - (dir * ox) / 2;
          dx[j] = dx[j]! + (dir * ox) / 2;
        } else {
          const dir = ay1 + ay2 < by1 + by2 || (ay1 + ay2 === by1 + by2 && i < j) ? 1 : -1;
          dy[i] = dy[i]! - (dir * oy) / 2;
          dy[j] = dy[j]! + (dir * oy) / 2;
        }
      }
    }
    if (!moved) break;
  }
  return Array.from({ length: n }, (_, i) => ({ dx: dx[i]!, dy: dy[i]! }));
}

/** Push apart nodes whose boxes (node + label) still overlap after the layout, then refit. */
function separateLabels(cy: Core): void {
  const nodes = cy.nodes();
  if (nodes.length < 2) return;
  const boxes = nodes.map((n) => n.boundingBox({ includeLabels: true, includeOverlays: false, includeEdges: false } as cytoscape.BoundingBoxOptions));
  const offsets = separateBoxes(boxes);
  cy.batch(() => {
    nodes.forEach((n, i) => {
      const o = offsets[i]!;
      if (o.dx === 0 && o.dy === 0) return;
      const p = n.position();
      n.position({ x: p.x + o.dx, y: p.y + o.dy });
    });
  });
  cy.fit(undefined, GRAPH_PADDING);
  // A small graph fitted to the canvas would be blown up to giant labels: cap the initial zoom.
  if (cy.zoom() > MAX_INITIAL_ZOOM) {
    cy.zoom(MAX_INITIAL_ZOOM);
    cy.center();
  }
}

const MAX_INITIAL_ZOOM = 1.5;

export function toElements(graph: GraphResponse): ElementDefinition[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const nodes: ElementDefinition[] = graph.nodes.map((n) => ({
    data: {
      id: n.id,
      label: displayLabel(n.kind === 'group' && n.size ? `${n.label} (${n.size})` : n.label),
      kind: n.kind,
      level: n.level ?? '',
      centre: n.id === graph.centre ? 1 : 0,
    },
  }));
  const edges: ElementDefinition[] = graph.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e, i) => ({
      data: { id: `e${i}`, source: e.from, target: e.to, relation: e.relation, dashed: e.reviewed === false || (e.confidence !== undefined && e.confidence < 0.7) ? 1 : 0 },
    }));
  return [...nodes, ...edges];
}

/** Cytoscape stylesheet from the current theme tokens. */
export function themeStyles(): StylesheetJson {
  const fg = themeColor('--foreground', '#171717');
  const muted = themeColor('--muted-foreground', '#737373');
  const card = themeColor('--card', '#ffffff');
  const ring = themeColor('--ring', '#a1a1a1');
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': 11,
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: fg,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-background-color': card,
        'text-background-opacity': 0.85,
        'text-background-padding': '1px',
        // Long names end in an ellipsis instead of running into neighbours; the full name is in
        // the side panel. Labels too small to read when zoomed out are not drawn.
        'text-wrap': 'ellipsis',
        'text-max-width': `${LABEL_MAX_WIDTH}px`,
        'min-zoomed-font-size': 5,
        'background-color': card,
        'border-width': 1.5,
        'border-color': muted,
        width: 18,
        height: 18,
      },
    },
    ...(Object.keys(KIND_SHAPE) as GraphNodeKind[]).map((k) => ({
      selector: `node[kind = "${k}"]`,
      style: { shape: KIND_SHAPE[k] as cytoscape.Css.NodeShape },
    })),
    ...(Object.keys(LEVEL_VAR) as RiskLevel[]).map((lv) => {
      const c = themeColor(LEVEL_VAR[lv], fg);
      return {
        selector: `node[level = "${lv}"]`,
        style: lv === 'critical' || lv === 'high' ? { 'border-color': c, 'border-width': 2.5, 'background-color': c, 'background-opacity': 0.18 } : { 'border-color': c },
      };
    }),
    { selector: 'node[centre = 1]', style: { width: 28, height: 28, 'font-weight': 'bold', 'border-width': 3 } },
    { selector: 'node:selected', style: { 'overlay-opacity': 0.12, 'overlay-color': fg, 'overlay-padding': 6 } },
    {
      selector: 'edge',
      style: { width: 1.2, 'line-color': ring, 'target-arrow-color': ring, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier' },
    },
    { selector: 'edge[dashed = 1]', style: { 'line-style': 'dashed', 'line-color': muted, 'target-arrow-color': muted } },
  ] as StylesheetJson;
}

/** Rendered label width estimate: 11px monospace (~0.6em per character), capped by text-max-width. */
export const LABEL_MAX_WIDTH = 160;
export function labelWidth(label: string): number {
  return Math.min(LABEL_MAX_WIDTH, Math.ceil(label.length * 6.6));
}

export interface LayeredOptions {
  /** Width to pack rows into (the canvas width at zoom 1). */
  width: number;
  /** Width a node needs (its label, or its shape when wider). */
  nodeWidth: (id: string) => number;
  /** Height of one row: node, label below it, and breathing room. */
  rowHeight?: number;
  /** Extra space between layers. */
  layerGap?: number;
  /** Horizontal space between neighbours. */
  gap?: number;
}

/**
 * "Layered" layout: the centre on top, then nodes by hop distance from it (edges taken both ways),
 * each layer wrapped into as many rows as the width needs. Cytoscape's breadthfirst puts a whole
 * layer on one line, so a component with 30 dependents became a strip 30 labels wide that only
 * fitted at an unreadable zoom, with labels overlapping. Nodes keep their input order (the API's
 * priority order); nodes not connected to the centre form the last layer.
 */
export function layeredPositions(
  nodeIds: readonly string[],
  edges: readonly (readonly [string, string])[],
  centre: string,
  { width, nodeWidth, rowHeight = 56, layerGap = 20, gap = 16 }: LayeredOptions,
): Record<string, { x: number; y: number }> {
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const [a, b] of edges) {
    if (!adj.has(a) || !adj.has(b) || a === b) continue;
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const depth = new Map<string, number>();
  const root = adj.has(centre) ? centre : nodeIds[0];
  if (root !== undefined) {
    depth.set(root, 0);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      for (const n of adj.get(id)!) {
        if (depth.has(n)) continue;
        depth.set(n, depth.get(id)! + 1);
        queue.push(n);
      }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const layers: string[][] = Array.from({ length: maxDepth + 2 }, () => []);
  for (const id of nodeIds) layers[depth.get(id) ?? maxDepth + 1]!.push(id);

  const avail = Math.max(200, width);
  const pos: Record<string, { x: number; y: number }> = {};
  let y = 0;
  for (const layer of layers) {
    if (layer.length === 0) continue;
    // Greedy rows: as many nodes as fit in the width.
    const rows: string[][] = [[]];
    let used = 0;
    for (const id of layer) {
      const w = nodeWidth(id);
      const row = rows[rows.length - 1]!;
      if (row.length > 0 && used + gap + w > avail) {
        rows.push([id]);
        used = w;
      } else {
        used += (row.length > 0 ? gap : 0) + w;
        row.push(id);
      }
    }
    for (const row of rows) {
      const total = row.reduce((sum, id) => sum + nodeWidth(id), 0) + gap * (row.length - 1);
      let x = -total / 2;
      for (const id of row) {
        const w = nodeWidth(id);
        pos[id] = { x: x + w / 2, y };
        x += w + gap;
      }
      y += rowHeight;
    }
    y += layerGap;
  }
  return pos;
}

/**
 * Layout options. 'breadthfirst' ("Layered") is a preset of layeredPositions(), sized to the
 * canvas when `cy` is given. Force and concentric space nodes by their own size and leave label
 * collisions to the separation pass that follows every layout.
 */
export function layoutOptions(layout: GraphLayout, centre: string, cy?: Core): cytoscape.LayoutOptions {
  const common = { padding: GRAPH_PADDING, animate: false };
  if (layout === 'breadthfirst') {
    const positions = cy
      ? layeredPositions(
          cy.nodes().map((n) => n.id()),
          cy.edges().map((e) => [e.source().id(), e.target().id()] as const),
          centre,
          { width: (cy.width() || 800) - 2 * GRAPH_PADDING, nodeWidth: (id) => Math.max(28, labelWidth(String(cy.getElementById(id).data('label') ?? ''))) },
        )
      : {};
    return { ...common, name: 'preset', positions: (n: cytoscape.NodeSingular) => positions[n.id()] ?? { x: 0, y: 0 }, fit: true } as cytoscape.LayoutOptions;
  }
  if (layout === 'concentric') return { ...common, name: 'concentric', avoidOverlap: true, minNodeSpacing: 24 } as cytoscape.LayoutOptions;
  return { ...common, name: 'cose', nodeRepulsion: () => 8_000, idealEdgeLength: () => 60, nodeOverlap: 20, componentSpacing: 60 } as cytoscape.LayoutOptions;
}

export function GraphCanvas({ graph, layout = 'breadthfirst', selectedId, onNodeClick, controlsRef, height = 480, label = 'Scoped graph', className }: GraphCanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [readyNodes, setReadyNodes] = useState<number | null>(null);

  useImperativeHandle(
    controlsRef,
    () => ({
      zoomIn: () => {
        const cy = cyRef.current;
        if (cy) cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
      },
      zoomOut: () => {
        const cy = cyRef.current;
        if (cy) cy.zoom({ level: cy.zoom() / 1.25, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
      },
      fit: () => cyRef.current?.fit(undefined, GRAPH_PADDING),
    }),
    [],
  );

  useEffect(() => {
    if (!ref.current) return;
    setReadyNodes(null);
    const cy = cytoscape({
      container: ref.current,
      elements: toElements(graph),
      wheelSensitivity: 0.2,
      minZoom: 0.15,
      maxZoom: 4,
      style: themeStyles(),
      layout: { name: 'preset' },
    });
    cy.on('tap', 'node', (evt) => clickRef.current?.(evt.target.id()));
    cyRef.current = cy;
    let alive = true;
    const run = cy.layout(layoutOptions(layout, graph.centre, cy));
    run.one('layoutstop', () => {
      if (!alive) return;
      try {
        separateLabels(cy);
      } catch {
        /* no canvas text metrics (jsdom): keep the layout as is */
      }
      const sel = selectedRef.current;
      if (sel) cy.getElementById(sel).select();
      setReadyNodes(cy.nodes().length);
    });
    run.run();
    // Follow the light/dark switch (class) and inline theme tokens (style) on <html>.
    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(() => cy.style(themeStyles()));
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    return () => {
      alive = false;
      mo?.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph, layout]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes(':selected').unselect();
    if (selectedId) cy.getElementById(selectedId).select();
  }, [selectedId, graph, layout]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      data-graph-ready={readyNodes !== null ? 'true' : 'false'}
      data-node-count={readyNodes ?? undefined}
      className={cn('w-full bg-card', className)}
      style={{ height }}
    />
  );
}

export default GraphCanvas;
