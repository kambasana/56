/**
 * Cytoscape view for Investigate: the shared GraphCanvas renderer with zoom / fit controls
 * (through `controlsRef`), a layout toggle (`layout`) and node selection.
 */
import { GraphCanvas, type GraphCanvasProps } from '@/components/GraphCanvas';

export type { GraphControls, GraphLayout } from '@/components/GraphCanvas';
export { themeStyles } from '@/components/GraphCanvas';
export { toRgb } from '@/lib/css-color';

export type InvestigateGraphProps = GraphCanvasProps;

export function InvestigateGraph({ height = 520, ...props }: InvestigateGraphProps) {
  return <GraphCanvas height={height} {...props} />;
}

export default InvestigateGraph;
