/**
 * Cytoscape view of one scoped graph (GET /api/graph?finding= or ?project=&node=).
 * Graphs are always scoped to one finding or entity (PLAN §12), never estate-wide.
 *
 * Import this file directly from a page (not from the components barrel) so Cytoscape is
 * bundled only into the pages that draw graphs. Labels are passed as data, so Cytoscape
 * renders them as canvas text: untrusted values are never parsed as HTML.
 */
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { useEffect, useRef, useState } from 'react';
import type { GraphResponse, GraphNodeKind, RiskLevel } from '@server/api-types';
import { cn } from '@/lib/cn';
import { toRgb } from '@/lib/css-color';

export interface ScopedGraphProps {
  graph: GraphResponse;
  onNodeClick?: (nodeId: string) => void;
  /** 'breadthfirst' (tree from the centre, default) or 'cose' (force). */
  layout?: 'breadthfirst' | 'cose' | 'concentric';
  className?: string;
  height?: number | string;
  label?: string;
}

/** A theme token as an opaque rgb(): Cytoscape cannot parse the theme's oklch() values. */
function cssVar(name: string, fallback: string, base = '#fff'): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return toRgb(v || fallback, base);
}

const LEVEL_VAR: Record<RiskLevel, string> = { critical: '--level-critical', high: '--level-high', medium: '--level-medium', low: '--level-low' };

/** Bumps when <html>'s class changes (light/dark), so the canvas re-reads the theme. */
function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setV((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return v;
}
const KIND_SHAPE: Record<GraphNodeKind, string> = { asset: 'round-rectangle', component: 'ellipse', entity: 'diamond', incident: 'triangle', group: 'barrel' };

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

export function ScopedGraph({ graph, onNodeClick, layout = 'breadthfirst', className, height = 480, label = 'Scoped graph' }: ScopedGraphProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;
  const themeVersion = useThemeVersion();

  useEffect(() => {
    if (!ref.current) return;
    const bg = cssVar('--background', '#ffffff');
    const fg = cssVar('--foreground', '#171717', bg);
    const muted = cssVar('--muted-foreground', '#737373', bg);
    const border = cssVar('--border', '#e5e5e5', bg);
    const cy = cytoscape({
      container: ref.current,
      elements: toElements(graph),
      wheelSensitivity: 0.2,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'font-size': 11,
            'font-family': 'ui-monospace, monospace',
            color: fg,
            'text-valign': 'bottom',
            'text-margin-y': 4,
            'background-color': bg,
            'border-width': 1.5,
            'border-color': muted,
            width: 18,
            height: 18,
          },
        },
        ...(['asset', 'component', 'entity', 'incident', 'group'] as GraphNodeKind[]).map((k) => ({
          selector: `node[kind = "${k}"]`,
          style: { shape: KIND_SHAPE[k] as cytoscape.Css.NodeShape },
        })),
        ...(Object.keys(LEVEL_VAR) as RiskLevel[]).map((lv) => ({
          selector: `node[level = "${lv}"]`,
          style: { 'border-color': cssVar(LEVEL_VAR[lv], fg, bg), 'border-width': lv === 'critical' || lv === 'high' ? 2.5 : 1.5 },
        })),
        { selector: 'node[centre = 1]', style: { width: 26, height: 26, 'font-weight': 'bold' } },
        { selector: 'node:selected', style: { 'overlay-opacity': 0.08, 'overlay-color': fg } },
        {
          selector: 'edge',
          style: { width: 1, 'line-color': border, 'target-arrow-color': border, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier' },
        },
        { selector: 'edge[dashed = 1]', style: { 'line-style': 'dashed' } },
      ],
      layout:
        layout === 'breadthfirst'
          ? { name: 'breadthfirst', directed: true, roots: [graph.centre].filter(Boolean), spacingFactor: 1.1, padding: 16 }
          : layout === 'concentric'
            ? { name: 'concentric', padding: 16 }
            : { name: 'cose', padding: 16, animate: false },
    });
    cy.on('tap', 'node', (evt) => clickRef.current?.(evt.target.id()));
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph, layout, themeVersion]);

  return (
    <div className="flex flex-col gap-1">
      <div ref={ref} role="img" aria-label={label} className={cn('w-full rounded-md border bg-background', className)} style={{ height }} />
      {graph.truncated && (
        <p className="m-0 text-xs text-muted-foreground">
          Showing up to {graph.cap} nodes for this project's tier; the rest are grouped.
        </p>
      )}
    </div>
  );
}

export default ScopedGraph;
