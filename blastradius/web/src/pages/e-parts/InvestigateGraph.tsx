/**
 * Cytoscape view for Investigate: one scoped graph (never estate-wide) with zoom / fit controls
 * exposed through `controlsRef`. Colours come from the shadcn theme CSS variables
 * (--foreground, --muted-foreground, --card, --level-*, --ring) and are re-read whenever the <html>
 * light/dark class changes, so the canvas follows dark mode. Labels are canvas text, never HTML.
 */
import cytoscape, { type Core, type StylesheetJson } from 'cytoscape';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { GraphNodeKind, GraphResponse, RiskLevel } from '@server/api-types';
import { toElements } from '@/components/ScopedGraph';
import { cn } from '@/lib/utils';
import { toRgb } from '@/lib/css-color';

export type GraphLayout = 'breadthfirst' | 'cose' | 'concentric';

export interface GraphControls {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}

export interface InvestigateGraphProps {
  graph: GraphResponse;
  layout?: GraphLayout;
  selectedId?: string | null;
  onNodeClick?: (nodeId: string) => void;
  controlsRef?: Ref<GraphControls>;
  height?: number | string;
  label?: string;
  className?: string;
}

export { toRgb };

function cssVar(name: string): string {
  return typeof window === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A theme token as an opaque rgb() over the card colour. */
function themeColor(name: string, fallback: string): string {
  const card = toRgb(cssVar('--card') || '#fff');
  return toRgb(cssVar(name) || fallback, card);
}

const LEVEL_VAR: Record<RiskLevel, string> = { critical: '--level-critical', high: '--level-high', medium: '--level-medium', low: '--level-low' };
const KIND_SHAPE: Record<GraphNodeKind, string> = { asset: 'round-rectangle', component: 'ellipse', entity: 'diamond', incident: 'triangle', group: 'barrel' };

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

function layoutOptions(layout: GraphLayout, centre: string): cytoscape.LayoutOptions {
  if (layout === 'breadthfirst') return { name: 'breadthfirst', directed: true, roots: [centre].filter(Boolean), spacingFactor: 1.1, padding: 24 } as cytoscape.LayoutOptions;
  if (layout === 'concentric') return { name: 'concentric', padding: 24 } as cytoscape.LayoutOptions;
  return { name: 'cose', padding: 24, animate: false } as cytoscape.LayoutOptions;
}

export function InvestigateGraph({ graph, layout = 'breadthfirst', selectedId, onNodeClick, controlsRef, height = 520, label = 'Scoped graph', className }: InvestigateGraphProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const clickRef = useRef(onNodeClick);
  clickRef.current = onNodeClick;

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
      fit: () => cyRef.current?.fit(undefined, 24),
    }),
    [],
  );

  useEffect(() => {
    if (!ref.current) return;
    const cy = cytoscape({
      container: ref.current,
      elements: toElements(graph),
      wheelSensitivity: 0.2,
      minZoom: 0.15,
      maxZoom: 4,
      style: themeStyles(),
      layout: layoutOptions(layout, graph.centre),
    });
    cy.on('tap', 'node', (evt) => clickRef.current?.(evt.target.id()));
    cyRef.current = cy;
    // Follow the light/dark switch on <html>.
    const mo = new MutationObserver(() => cy.style(themeStyles()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      mo.disconnect();
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

  return <div ref={ref} role="img" aria-label={label} className={cn('w-full bg-card', className)} style={{ height }} />;
}

export default InvestigateGraph;
