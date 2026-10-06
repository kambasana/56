/**
 * Scoped graph for one finding (GET /api/graph?finding=). Lazy-loaded by the Finding page so
 * Cytoscape is only fetched when someone asks for the graph.
 */
import { api } from '@/api';
import { ErrorState, LoadingState } from '@/components/EmptyState';
import { ScopedGraph } from '@/components/ScopedGraph';
import { useApi } from '@/lib/useApi';

export default function FindingGraph({ findingId }: { findingId: string }) {
  const { data, error, loading, reload } = useApi((s) => api.graphForFinding(findingId, s), [findingId]);
  if (loading && !data) return <LoadingState label="Loading graph…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <ScopedGraph graph={data} height={360} label="Graph scoped to this finding" />
      <p className="m-0 text-xs text-muted-foreground">
        Scoped to this finding and capped at {data.cap} nodes{data.truncated ? '; some nodes are grouped' : ''}.
      </p>
    </div>
  );
}
