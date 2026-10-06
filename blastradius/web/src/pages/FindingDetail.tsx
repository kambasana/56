/** Finding: one finding on its own page (deep-linkable), with paths, reasons, evidence and history. */
import { lazy, Suspense, useState } from 'react';
import { useParams } from 'react-router';
import type { FindingRow } from '@server/api-types';
import { api, isApiError } from '@/api';
import { useAuth } from '@/auth';
import { useProject } from '@/project';
import { Badge, RiskBadge, levelLabel } from '@/components/Badge';
import { Button, ButtonLink } from '@/components/Button';
import { EmptyState, ErrorState, LoadingState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { fmtNum } from '@/lib/cn';
import { factorLabel, fmtDate } from './d-parts/format';
import { investigateHref } from './d-parts/FindingPanel';
import { AssetPaths, BehindIt, EvidenceList, ReasonsList, ScoreHistory, StatusControl, StatusHistory } from './d-parts/FindingSections';
import { Section, StatusBadge } from './d-parts/ui';

const FindingGraph = lazy(() => import('./d-parts/FindingGraph'));

export default function FindingDetail() {
  const { id = '', fid = '' } = useParams();
  const { me, can } = useAuth();
  const { project } = useProject();
  const { data, error, loading, reload } = useApi((s) => api.finding(fid, s), [fid]);
  const [row, setRow] = useState<FindingRow | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const findingsPath = `/projects/${encodeURIComponent(id)}/findings`;
  const title = data ? `${data.name}@${data.version}` : 'Finding';
  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: project?.name ?? 'Project' }, { label: 'Findings', to: findingsPath }, { label: title }];

  if (loading && !data) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="Finding" />
        <LoadingState label="Loading finding…" />
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
  const factors = data.factors;

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={<span className="font-mono">{title}</span>}
        actions={
          <>
            <ButtonLink to={findingsPath}>Back to findings</ButtonLink>
            {can('investigate', data.projectId) && (
              <ButtonLink to={investigateHref(data.projectId, data.id)} variant="default">
                Open in graph
              </ButtonLink>
            )}
          </>
        }
      >
        <Badge variant="outline">{data.ecosystem}</Badge>
        {factors.slice(0, 4).map((f) => (
          <Badge key={f} variant="secondary">
            {factorLabel(f)}
          </Badge>
        ))}
      </PageHeader>
      <div className="flex flex-col gap-1 border-b px-5 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <RiskBadge level={data.level} score={data.score} />
          <span>
            {levelLabel(data.level)} · risk {Math.round(data.score)} · reaches {fmtNum(data.reach.assets)} asset{data.reach.assets === 1 ? '' : 's'}, {fmtNum(data.reach.prodAssets)} in production
          </span>
          <StatusBadge status={current.status} />
          <span className="text-xs text-muted-foreground">first seen {fmtDate(data.firstSeenAt)}</span>
        </div>
        {data.mainReason && <p className="m-0 max-w-3xl text-[13px] text-muted-foreground">{data.mainReason.detail}</p>}
        <div className="pt-1.5">
          <StatusControl finding={current} onUpdated={setRow} />
        </div>
      </div>
      <div className="grid gap-x-8 px-5 py-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col divide-y">
          <Section title={`Why it scored ${Math.round(data.score)}`} hint="Each factor's contribution, combined with noisy-OR">
            <ReasonsList reasons={data.reasons} />
          </Section>
          <Section title="Who's behind it" hint="Each link shows its confidence. Unreviewed links below 0.80 are not scored.">
            <BehindIt chain={data.entityChain} />
          </Section>
          <Section title="Evidence" hint="Every claim on this page, with its source">
            <EvidenceList detail={data} />
          </Section>
          <Section title="History" hint="Same component in this project's earlier scans">
            <ScoreHistory history={data.history} />
            <StatusHistory changes={data.statusHistory} />
          </Section>
        </div>
        <div className="flex min-w-0 flex-col divide-y">
          <Section title="Affected assets" hint="Every path from your assets to this version">
            <AssetPaths assets={data.assets} />
          </Section>
          <Section title="Graph" hint="Scoped to this finding, never estate-wide">
            {showGraph ? (
              <Suspense fallback={<LoadingState label="Loading graph…" />}>
                <FindingGraph findingId={data.id} />
              </Suspense>
            ) : (
              <div>
                <Button variant="outline" onClick={() => setShowGraph(true)}>
                  Show graph
                </Button>
              </div>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
