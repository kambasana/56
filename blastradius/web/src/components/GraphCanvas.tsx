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

export function toElements(graph: GraphResponse): ElementDefinition[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const nodes: ElementDefinition[] = graph.nodes.map((n) => ({
    data: {
      id: n.id,
      label: n.kind === 'group' && n.size ? `${n.label} (${n.size})` : n.label,
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

export function layoutOptions(layout: GraphLayout, centre: string): cytoscape.LayoutOptions {
  if (layout === 'breadthfirst') return { name: 'breadthfirst', directed: true, roots: [centre].filter(Boolean), spacingFactor: 1.1, padding: GRAPH_PADDING } as cytoscape.LayoutOptions;
  if (layout === 'concentric') return { name: 'concentric', padding: GRAPH_PADDING } as cytoscape.LayoutOptions;
  return { name: 'cose', padding: GRAPH_PADDING, animate: false } as cytoscape.LayoutOptions;
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
    const run = cy.layout(layoutOptions(layout, graph.centre));
    run.one('layoutstop', () => {
      if (!alive) return;
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
