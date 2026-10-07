/**
 * Finding: one finding on its own page (deep-linkable). A summary Card (level, reach, main
 * reason, status control), then Card sections: why it scored, who's behind it, evidence and
 * history on the left; affected assets and the scoped graph (Tabs) on the right.
 */
import { lazy, Suspense, useState } from 'react';
import { useParams } from 'react-router';
import { ArrowLeft, Network } from 'lucide-react';
import type { FindingRow } from '@server/api-types';
import { api, isApiError } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { RiskBadge, levelLabel } from '@/components/Badge';
import { ButtonLink } from '@/components/Button';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/useApi';
import { fmtNum } from '@/lib/cn';
import { factorLabel, fmtDate } from './d-parts/format';
import { investigateHref } from './d-parts/FindingPanel';
import { AssetPaths, BehindIt, EvidenceList, ReasonsList, ScoreHistory, StatusControl, StatusHistory } from './d-parts/FindingSections';
import { PageSkeleton, SectionCard, StatusBadge } from './d-parts/ui';

const FindingGraph = lazy(() => import('./d-parts/FindingGraph'));

function GraphSkeleton() {
  return (
    <div role="status" aria-label="Loading graph…" className="flex flex-col gap-2">
      <Skeleton className="h-[360px] w-full" />
    </div>
  );
}

export default function FindingDetail() {
  const { id = '', fid = '' } = useParams();
  const { me, can } = useAuth();
  const { project } = useProject();
  const { data, error, loading, reload } = useApi((s) => api.finding(fid, s), [fid]);
  const [row, setRow] = useState<FindingRow | null>(null);
  const [tab, setTab] = useState('paths');
  const findingsPath = `/projects/${encodeURIComponent(id)}/findings`;
  const title = data ? `${data.name}@${data.version}` : 'Finding';
  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: project?.name ?? 'Project' }, { label: 'Findings', to: findingsPath }, { label: title }];

  if (loading && !data) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Finding" />
        <PageSkeleton label="Loading finding…" rows={5} />
      </>
    );
  }
  if (error || !data) {
    const notFound = isApiError(error, 'not_found');
    return (
      <>
        <PageHeader crumbs={crumbs} title="Finding" />
        {notFound ? (
          <EmptyState title="Finding not found" description="It may belong to an older scan or another project." action={<ButtonLink to={findingsPath}>Back to findings</ButtonLink>} />
        ) : (
          <ErrorState error={error ?? new Error('No data')} onRetry={reload} />
        )}
      </>
    );
  }

  const current: FindingRow = row && row.id === data.id ? row : data;
  const canGraph = can('investigate', data.projectId);

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={<span className="font-mono">{title}</span>}
        actions={
          <>
            <ButtonLink to={findingsPath} variant="ghost">
              <ArrowLeft aria-hidden="true" />
              Back to findings
            </ButtonLink>
            {canGraph && (
              <ButtonLink to={investigateHref(data.projectId, data.id)} variant="default">
                <Network aria-hidden="true" />
                Open in graph
              </ButtonLink>
            )}
          </>
        }
      >
        <Badge variant="outline">{data.ecosystem}</Badge>
        {data.factors.slice(0, 4).map((f) => (
          <Badge key={f} variant="secondary">
            {factorLabel(f)}
          </Badge>
        ))}
      </PageHeader>
      <div className="flex flex-col gap-4 p-4">
        <Card className="gap-0 py-0">
          <CardContent className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <RiskBadge level={data.level} score={data.score} />
              <span className="font-medium">
                {levelLabel(data.level)} · risk {Math.round(data.score)} · reaches {fmtNum(data.reach.assets)} asset{data.reach.assets === 1 ? '' : 's'}, {fmtNum(data.reach.prodAssets)} in production
              </span>
              <StatusBadge status={current.status} />
              <span className="font-mono text-xs text-muted-foreground">first seen {fmtDate(data.firstSeenAt)}</span>
            </div>
            {data.mainReason && <p className="max-w-3xl text-sm text-muted-foreground">{data.mainReason.detail}</p>}
            <Separator className="my-1" />
            <StatusControl finding={current} onUpdated={setRow} />
          </CardContent>
        </Card>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <SectionCard id="why" title={`Why it scored ${Math.round(data.score)}`} description="Each factor's contribution, combined with noisy-OR">
              <ReasonsList reasons={data.reasons} />
            </SectionCard>
            <SectionCard id="behind" title="Who's behind it" description="Each link shows its confidence. Unreviewed links below 0.80 are not scored.">
              <BehindIt chain={data.entityChain} ownership={data.ownership} />
            </SectionCard>
            <SectionCard id="evidence" title="Evidence" description="Every claim on this page, with its source">
              <EvidenceList detail={data} />
            </SectionCard>
            <SectionCard id="history" title="History" description="Same component in this project's earlier scans" contentClassName="flex flex-col gap-3">
              <ScoreHistory history={data.history} />
              <StatusHistory changes={data.statusHistory} />
            </SectionCard>
          </div>
          <SectionCard id="assets" title="Affected assets" description="Every path from your assets to this version; the graph is scoped to this finding, never estate-wide">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="paths">Paths ({fmtNum(data.assets.length)})</TabsTrigger>
                <TabsTrigger value="graph">Graph</TabsTrigger>
              </TabsList>
              <TabsContent value="paths" className="pt-2">
                <AssetPaths assets={data.assets} />
              </TabsContent>
              <TabsContent value="graph" className="pt-2">
                {/* Cytoscape is only fetched once someone opens this tab. */}
                {tab === 'graph' && (
                  <Suspense fallback={<GraphSkeleton />}>
                    <FindingGraph findingId={data.id} />
                  </Suspense>
                )}
              </TabsContent>
            </Tabs>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
