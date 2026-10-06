/**
 * Building blocks for one finding, used by the Findings side panel and the Finding page:
 * reasons (why it scored), paths to assets, who is behind it, evidence links, history and the
 * status control. All untrusted values are rendered as React text; links are http(s) only.
 */
import { useEffect, useId, useState } from 'react';
import type { AssetPathView, EntityChainEntry, FindingDetail, FindingRow, FindingStatus, Reason } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { Badge, RiskBadge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { cn, fmtTime } from '@/lib/cn';
import { factorLabel, fmtDate, purlLabel, safeHref, STATUS_LABELS } from './format';
import { Meter } from './ui';

export function ReasonsList({ reasons }: { reasons: readonly Reason[] }) {
  if (reasons.length === 0) return <p className="m-0 text-muted-foreground">No scored reasons.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Reasons">
      {reasons.map((r, i) => (
        <li key={`${r.factor}-${i}`} className="flex gap-2.5">
          <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground" title="Contribution to the 0–100 score">
            +{Math.round(r.contribution * 100)}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{factorLabel(r.factor)}</span>
            <span className="break-words text-muted-foreground">{r.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PathLine({ path, assetName }: { path: readonly string[]; assetName: string }) {
  return (
    <li className="break-words font-mono text-xs leading-5">
      {path.map((p, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden="true" className="px-1 text-muted-foreground">→</span>}
          <span className={i === path.length - 1 ? 'font-semibold' : i === 0 ? 'text-muted-foreground' : undefined}>{i === 0 ? assetName : purlLabel(p)}</span>
        </span>
      ))}
    </li>
  );
}

/** Affected assets with their dependency paths. `maxPaths` trims each asset's path list. */
export function AssetPaths({ assets, maxPaths, maxAssets }: { assets: readonly AssetPathView[]; maxPaths?: number; maxAssets?: number }) {
  if (assets.length === 0) return <p className="m-0 text-muted-foreground">No asset reaches this component.</p>;
  const shownAssets = maxAssets ? assets.slice(0, maxAssets) : assets;
  return (
    <div className="flex flex-col gap-2.5">
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Paths to assets">
        {shownAssets.map((a) => {
          const paths = maxPaths ? a.paths.slice(0, maxPaths) : a.paths;
          const more = a.paths.length - paths.length;
          return (
            <li key={a.assetId} className="flex flex-col gap-1 rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.assetName}</span>
                <Badge variant={a.environment === 'prod' ? 'outline' : 'secondary'} className={a.environment === 'prod' ? 'border-destructive/40 text-destructive' : undefined}>
                  {a.environment}
                </Badge>
                <span className="text-xs text-muted-foreground">{a.kind}</span>
                <span className="grow" />
                <span className="flex items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                  exposure {a.exposure.toFixed(2)} <Meter value={a.exposure} max={1} label={`Exposure of ${a.assetName}`} />
                </span>
              </div>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {paths.map((p, i) => (
                  <PathLine key={i} path={p} assetName={a.assetName} />
                ))}
              </ul>
              {more > 0 && <span className="text-xs text-muted-foreground">+{more} more path{more === 1 ? '' : 's'}</span>}
            </li>
          );
        })}
      </ul>
      {shownAssets.length < assets.length && <span className="text-xs text-muted-foreground">+{assets.length - shownAssets.length} more assets</span>}
    </div>
  );
}

export function BehindIt({ chain }: { chain: readonly EntityChainEntry[] }) {
  if (chain.length === 0) return <p className="m-0 text-muted-foreground">No linked organisations, funders or incidents.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Entity chain">
        {chain.map((e, i) => (
          <li key={`${e.entityId}-${i}`} className="flex flex-wrap items-center gap-2">
            {e.from && <span className="font-mono text-xs text-muted-foreground">{purlLabel(e.from)}</span>}
            <span className="text-xs text-muted-foreground">
              {e.relation.replace(/_/g, ' ')} · {e.confidence.toFixed(2)}
            </span>
            <span className="font-medium">{e.entityId}</span>
            {e.reviewed === false && <Badge variant="outline">unreviewed</Badge>}
          </li>
        ))}
      </ol>
      <p className="m-0 text-xs text-muted-foreground">Documented relationships with sources, not findings of wrongdoing.</p>
    </div>
  );
}

/** Every evidence URL on the finding (reasons and entity links), de-duplicated. */
export function collectEvidence(d: Pick<FindingDetail, 'reasons' | 'entityChain'>): { source: string; url: string }[] {
  const seen = new Set<string>();
  const out: { source: string; url: string }[] = [];
  for (const r of d.reasons) {
    for (const url of r.evidence ?? []) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ source: factorLabel(r.factor), url });
    }
  }
  for (const e of d.entityChain) {
    for (const url of e.evidence ?? []) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ source: `${e.relation.replace(/_/g, ' ')} link`, url });
    }
  }
  return out;
}

export function EvidenceList({ detail }: { detail: Pick<FindingDetail, 'reasons' | 'entityChain'> }) {
  const items = collectEvidence(detail);
  if (items.length === 0) return <p className="m-0 text-muted-foreground">No evidence links recorded.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Evidence">
      {items.map((e) => {
        const href = safeHref(e.url);
        return (
          <li key={e.url} className="flex gap-2">
            <span className="w-32 shrink-0 text-xs text-muted-foreground">{e.source}</span>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 break-all text-xs text-info underline-offset-2 hover:underline">
                {e.url}
              </a>
            ) : (
              <span className="min-w-0 break-all font-mono text-xs">{e.url}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ScoreHistory({ history }: { history: FindingDetail['history'] }) {
  if (history.length === 0) return <p className="m-0 text-muted-foreground">First seen in this scan.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Score history">
      {history.map((h) => (
        <li key={h.scanId} className="flex items-center gap-2">
          <span className="w-24 font-mono text-xs text-muted-foreground">{fmtDate(h.at)}</span>
          <RiskBadge level={h.level} score={h.score} />
        </li>
      ))}
    </ul>
  );
}

export function StatusHistory({ changes }: { changes: FindingDetail['statusHistory'] }) {
  if (changes.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Status history">
      {changes.map((c, i) => (
        <li key={i} className="text-xs">
          <span className="font-mono text-muted-foreground">{fmtTime(c.at)}</span> {STATUS_LABELS[c.from]} → {STATUS_LABELS[c.to]}
          {c.note && <span className="text-muted-foreground"> · {c.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Statuses `can` allows: new/reviewed need `review`, accepted_risk needs `accept_risk`.
 * Leaving accepted_risk also needs `accept_risk` (the server enforces the same rule).
 */
export function allowedStatuses(can: (p: 'review' | 'accept_risk') => boolean, current?: FindingStatus): FindingStatus[] {
  if (current === 'accepted_risk' && !can('accept_risk')) return [];
  const out: FindingStatus[] = [];
  if (can('review')) out.push('new', 'reviewed');
  if (can('accept_risk')) out.push('accepted_risk');
  return out;
}

/**
 * Status select + optional note. Hidden entirely (static badge) when the user can change
 * nothing; the server enforces the same rule.
 */
export function StatusControl({ finding, onUpdated }: { finding: FindingRow; onUpdated?: (row: FindingRow) => void }) {
  const { can } = useAuth();
  const allowed = allowedStatuses((p) => can(p, finding.projectId), finding.status);
  const [status, setStatus] = useState<FindingStatus>(finding.status);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const id = useId();
  useEffect(() => {
    setStatus(finding.status);
    setNote('');
    setError(null);
    setSaved(false);
  }, [finding.id, finding.status]);

  if (allowed.length === 0) return null;
  const options = allowed.includes(finding.status) ? allowed : [finding.status, ...allowed];

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const row = await api.updateFindingStatus(finding.id, { status, ...(note.trim() ? { note: note.trim() } : {}) });
      setSaved(true);
      setNote('');
      onUpdated?.(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the status.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      aria-label="Finding status"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={`${id}-s`} className="text-xs text-muted-foreground">
        Status
      </label>
      <select
        id={`${id}-s`}
        value={status}
        onChange={(e) => setStatus(e.target.value as FindingStatus)}
        className="h-8 rounded-md border border-input bg-background px-2 text-[13px]"
      >
        {options.map((s) => (
          <option key={s} value={s} disabled={!allowed.includes(s)}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-n`} className="sr-only">
        Note
      </label>
      <input
        id={`${id}-n`}
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="h-8 w-40 min-w-0 grow rounded-md border border-input bg-background px-2 text-[13px]"
      />
      <Button type="submit" variant="outline" disabled={busy || status === finding.status}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
      <span aria-live="polite" className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? (saved ? 'Saved' : '')}
      </span>
    </form>
  );
}
