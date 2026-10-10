/**
 * Building blocks for one finding, used by the Findings side panel and the Finding page:
 * reasons (why it scored), paths to assets, who is behind it, evidence links, history and the
 * status control. All untrusted values are rendered as React text; links are http(s) only.
 */
import { NotAllowedHint } from '@/components/br/StateBlock';
import { useEffect, useId, useState } from 'react';
import type { AssetPathView, EntityChainEntry, FindingDetail, FindingRow, FindingStatus, Reason } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { toast } from 'sonner';
import { RiskBadge } from '@/components/Badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtTime } from '@/lib/cn';
import { factorLabel, fmtDate, purlLabel, safeHref, STATUS_LABELS } from './format';
import { Meter } from './ui';

export function ReasonsList({ reasons }: { reasons: readonly Reason[] }) {
  if (reasons.length === 0) return <p className="text-sm text-muted-foreground">No scored reasons.</p>;
  return (
    <ul className="flex flex-col gap-3" aria-label="Reasons">
      {reasons.map((r, i) => {
        const pts = Math.round(r.contribution * 100);
        const pct = Math.max(2, Math.min(100, pts));
        return (
          <li key={`${r.factor}-${i}`} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{factorLabel(r.factor)}</span>
              <span className="grow" />
              <span className="font-mono text-xs tabular-nums text-muted-foreground" title="Contribution to the 0–100 score">
                +{pts}
              </span>
            </div>
            <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-muted">
              <span className={pts > 40 ? 'block h-full bg-level-critical' : pts > 20 ? 'block h-full bg-level-high' : 'block h-full bg-muted-foreground/50'} style={{ width: `${pct}%` }} />
            </span>
            <span className="break-words text-sm text-muted-foreground">{r.detail}</span>
          </li>
        );
      })}
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
  if (assets.length === 0) return <p className="text-sm text-muted-foreground">No asset reaches this component.</p>;
  const shownAssets = maxAssets ? assets.slice(0, maxAssets) : assets;
  return (
    <div className="flex flex-col gap-2.5">
      <ul className="flex flex-col gap-2.5" aria-label="Paths to assets">
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
              <ul className="flex flex-col gap-0.5">
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

const ENTITY_KIND: Record<string, string> = { account: 'Account', org: 'Org', person: 'Person', funder: 'Funder' };

/** "account:npm/qix" -> { kind: "Account", name: "npm/qix" }; anything else is shown as is. */
export function entityLabel(id: string): { kind?: string; name: string } {
  const at = id.indexOf(':');
  const kind = at > 0 ? ENTITY_KIND[id.slice(0, at)] : undefined;
  return kind ? { kind, name: id.slice(at + 1) } : { name: id };
}

function ChainList({ chain, label }: { chain: readonly EntityChainEntry[]; label: string }) {
  return (
    <ol className="flex flex-col gap-1.5" aria-label={label}>
      {chain.map((e, i) => {
        const to = entityLabel(e.entityId);
        return (
          <li key={`${e.from ?? ''}-${e.entityId}-${i}`} className="flex flex-wrap items-center gap-2">
            {e.from && <span className="font-mono text-xs text-muted-foreground">{e.from.startsWith('pkg:') ? purlLabel(e.from) : entityLabel(e.from).name}</span>}
            <span className="text-xs text-muted-foreground">
              {e.relation.replace(/_/g, ' ')} · {e.confidence.toFixed(2)}
            </span>
            {to.kind && <Badge variant="secondary">{to.kind}</Badge>}
            <span className="font-medium">{to.name}</span>
            {e.reviewed === false && <Badge variant="outline">unreviewed</Badge>}
          </li>
        );
      })}
    </ol>
  );
}

/** Incident chain (if any), then who publishes, owns and funds the package. */
export function BehindIt({ chain, ownership = [] }: { chain: readonly EntityChainEntry[]; ownership?: readonly EntityChainEntry[] }) {
  if (chain.length === 0 && ownership.length === 0) return <p className="text-sm text-muted-foreground">No linked organisations, funders or incidents.</p>;
  return (
    <div className="flex flex-col gap-3">
      {chain.length > 0 && <ChainList chain={chain} label="Entity chain" />}
      {ownership.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {chain.length > 0 && <span className="text-xs font-medium text-muted-foreground">Publishers, owners and funders</span>}
          <ChainList chain={ownership} label="Ownership" />
        </div>
      )}
      <p className="text-xs text-muted-foreground">Documented relationships with sources, not findings of wrongdoing.</p>
    </div>
  );
}

/** Every evidence URL on the finding (reasons and entity links), de-duplicated. */
export function collectEvidence(d: Pick<FindingDetail, 'reasons' | 'entityChain'> & { ownership?: FindingDetail['ownership'] }): { source: string; url: string }[] {
  const seen = new Set<string>();
  const out: { source: string; url: string }[] = [];
  for (const r of d.reasons) {
    for (const url of r.evidence ?? []) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ source: factorLabel(r.factor), url });
    }
  }
  for (const e of [...d.entityChain, ...(d.ownership ?? [])]) {
    for (const url of e.evidence ?? []) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ source: `${e.relation.replace(/_/g, ' ')} link`, url });
    }
  }
  return out;
}

export function EvidenceList({ detail }: { detail: Pick<FindingDetail, 'reasons' | 'entityChain'> & { ownership?: FindingDetail['ownership'] } }) {
  const items = collectEvidence(detail);
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No evidence links recorded.</p>;
  return (
    <Table aria-label="Evidence" className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 w-36 pl-0 text-xs text-muted-foreground">Source</TableHead>
          <TableHead className="h-8 pr-0 text-xs text-muted-foreground">Link</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((e) => {
          const href = safeHref(e.url);
          return (
            <TableRow key={e.url} className="hover:bg-transparent">
              <TableCell className="pl-0 align-top whitespace-normal text-muted-foreground">{e.source}</TableCell>
              <TableCell className="pr-0 whitespace-normal">
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-info underline-offset-2 hover:underline">
                    {e.url}
                  </a>
                ) : (
                  <span className="break-all font-mono">{e.url}</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function ScoreHistory({ history }: { history: FindingDetail['history'] }) {
  if (history.length === 0) return <p className="text-sm text-muted-foreground">First seen in this scan.</p>;
  return (
    <ul className="flex flex-col gap-1" aria-label="Score history">
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
    <ul className="flex flex-col gap-1" aria-label="Status history">
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
 * Status Select + optional note. When the user can change nothing, the control stays visible
 * but disabled, with the missing permission named (docs/UX.md §6); the server enforces the same
 * rule. A saved change is confirmed with a toast.
 */
export function StatusControl({ finding, onUpdated }: { finding: FindingRow; onUpdated?: (row: FindingRow) => void }) {
  const { can } = useAuth();
  const allowed = allowedStatuses((p) => can(p, finding.projectId), finding.status);
  const [status, setStatus] = useState<FindingStatus>(finding.status);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    setStatus(finding.status);
    setNote('');
    setError(null);
  }, [finding.id, finding.status]);

  const locked = allowed.length === 0;
  const options = allowed.includes(finding.status) ? allowed : [finding.status, ...allowed];
  const missing: 'review' | 'accept_risk' | null = locked ? (finding.status === 'accepted_risk' ? 'accept_risk' : 'review') : !allowed.includes('accepted_risk') ? 'accept_risk' : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const row = await api.updateFindingStatus(finding.id, { status, ...(note.trim() ? { note: note.trim() } : {}) });
      setNote('');
      toast.success(`Marked ${STATUS_LABELS[row.status].toLowerCase()}`, { description: `${row.name}@${row.version}` });
      onUpdated?.(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the status.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      aria-label="Finding status"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${id}-s`} className="text-xs text-muted-foreground">
          Status
        </Label>
        <Select value={status} onValueChange={(v) => setStatus(v as FindingStatus)} disabled={locked}>
          <SelectTrigger id={`${id}-s`} size="sm" className="w-[150px]" aria-describedby={missing ? `${id}-why` : undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((s) => (
              <SelectItem key={s} value={s} disabled={!allowed.includes(s)}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label htmlFor={`${id}-n`} className="sr-only">
          Note
        </Label>
        {!locked && (
          <>
            <Input id={`${id}-n`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="h-8 w-40 min-w-0 grow" />
            <Button type="submit" variant="outline" size="sm" disabled={busy || status === finding.status}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      </div>
      {missing && (
        <NotAllowedHint
          id={`${id}-why`}
          permission={missing}
          className="text-xs"
        />
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
