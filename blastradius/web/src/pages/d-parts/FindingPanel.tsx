/** Side panel for one row of the Findings table: loads GET /api/findings/:id on open. */
import type { FindingRow } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { RiskBadge } from '@/components/Badge';
import { ButtonLink } from '@/components/Button';
import { ExternalLink, Network } from 'lucide-react';
import { ErrorState } from '@/components/EmptyState';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { SidePanel } from '@/components/SidePanel';
import { useApi } from '@/lib/useApi';
import { fmtBlast, fmtNum } from '@/lib/cn';
import { fmtDate } from './format';
import { AssetPaths, BehindIt, EvidenceList, ReasonsList, StatusControl } from './FindingSections';
import { Section, StatusBadge } from './ui';

export function investigateHref(projectId: string, findingId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/investigate?finding=${encodeURIComponent(findingId)}`;
}

export function findingHref(projectId: string, findingId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/findings/${encodeURIComponent(findingId)}`;
}

export function FindingPanel({ row, onClose, onUpdated }: { row: FindingRow; onClose: () => void; onUpdated?: (row: FindingRow) => void }) {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi((s) => api.finding(row.id, s), [row.id]);
  const canGraph = can('investigate', row.projectId);
  return (
    <SidePanel
      label="Finding details"
      onClose={onClose}
      eyebrow={
        <>
          <RiskBadge level={row.level} score={row.score} />
          <span>
            {row.ecosystem} · first seen {fmtDate(row.firstSeenAt)}
          </span>
          <StatusBadge status={row.status} />
        </>
      }
      title={`${row.name}@${row.version}`}
      actions={
        <>
          <ButtonLink to={findingHref(row.projectId, row.id)} size="sm">
            <ExternalLink aria-hidden="true" />
            Open finding
          </ButtonLink>
          {canGraph && (
            <ButtonLink to={investigateHref(row.projectId, row.id)} size="sm">
              <Network aria-hidden="true" />
              Open graph
            </ButtonLink>
          )}
        </>
      }
    >
      <p className="pb-3 text-muted-foreground">
        {row.reachText} · {fmtNum(row.reach.paths)} dependency path{row.reach.paths === 1 ? '' : 's'} · blast {fmtBlast(row.blastScore)}
      </p>
      <StatusControl finding={row} onUpdated={onUpdated} />
      <Separator className="my-4" />
      {loading && !data && (
        <div role="status" aria-label="Loading finding…" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && (
        <div className="flex flex-col divide-y">
          <Section title={`Why it scored ${Math.round(data.score)}`} hint="Each factor's contribution, combined with noisy-OR">
            <ReasonsList reasons={data.reasons} />
          </Section>
          <Section title="Paths to assets" hint="Why is this here? Every path from your assets to this version.">
            <AssetPaths assets={data.assets} maxPaths={3} maxAssets={8} />
          </Section>
          <Section title="Who's behind it">
            <BehindIt chain={data.entityChain} />
          </Section>
          <Section title="Evidence" hint="Every claim, with its source">
            <EvidenceList detail={data} />
          </Section>
        </div>
      )}
    </SidePanel>
  );
}
