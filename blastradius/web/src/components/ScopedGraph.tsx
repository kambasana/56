/**
 * Cytoscape view of one scoped graph (GET /api/graph?finding= or ?project=&node=), drawn by the
 * shared GraphCanvas renderer, with a note when the graph was capped.
 *
 * Import this file directly from a page (not from the components barrel) so Cytoscape is
 * bundled only into the pages that draw graphs.
 */
import { GraphCanvas, type GraphCanvasProps } from '@/components/GraphCanvas';
import { cn } from '@/lib/cn';

export { toElements } from '@/components/GraphCanvas';

export type ScopedGraphProps = Omit<GraphCanvasProps, 'controlsRef' | 'selectedId'>;

export function ScopedGraph({ graph, className, ...props }: ScopedGraphProps) {
  return (
    <div className="flex flex-col gap-1">
      <GraphCanvas graph={graph} className={cn('rounded-md border', className)} {...props} />
      {graph.truncated && (
        <p className="m-0 text-xs text-muted-foreground">
          Showing up to {graph.cap} nodes for this project's tier; the rest are grouped.
        </p>
      )}
    </div>
  );
}

export default ScopedGraph;
