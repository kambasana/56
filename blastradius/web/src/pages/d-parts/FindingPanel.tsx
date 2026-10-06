/** Side panel for one row of the Findings table: loads GET /api/findings/:id on open. */
import type { FindingRow } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { RiskBadge } from '@/components/Badge';
import { ButtonLink } from '@/components/Button';
import { ErrorState, LoadingState } from '@/components/EmptyState';
import { SidePanel } from '@/components/SidePanel';
import { useApi } from '@/lib/useApi';
import { fmtNum } from '@/lib/cn';
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
          <ButtonLink to={findingHref(row.projectId, row.id)} size="xs">
            Open finding
          </ButtonLink>
          {canGraph && (
            <ButtonLink to={investigateHref(row.projectId, row.id)} size="xs">
              Open graph
            </ButtonLink>
          )}
        </>
      }
    >
      <p className="m-0 pb-3 text-muted-foreground">
        Reaches {fmtNum(row.reach.assets)} asset{row.reach.assets === 1 ? '' : 's'} ({fmtNum(row.reach.prodAssets)} in production) through {fmtNum(row.reach.paths)} path
        {row.reach.paths === 1 ? '' : 's'} · blast {fmtNum(Math.round(row.blastScore))}
      </p>
      <div className="pb-3">
        <StatusControl finding={row} onUpdated={onUpdated} />
      </div>
      {loading && !data && <LoadingState label="Loading finding…" />}
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
