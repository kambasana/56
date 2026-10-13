/**
 * Triage building blocks shared by the Findings list, its peek sheet and the Finding page:
 * status words, who-brings-it-in text, relative times, the assignee list, and the Status / Owner
 * controls with the accept-risk dialog (reason and expiry, docs/UX.md §5). A control the viewer
 * cannot use stays visible, disabled, with the missing permission named (§6).
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { FindingStatus, IntroducedBy, PersonRef, UpdateFindingStatusRequest } from '@server/api-types';
import { FINDING_STATUSES } from '@server/api-types';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { NotAllowedHint } from '@/components/br';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { STATUS_LABELS } from '../d-parts/format';

export { STATUS_LABELS };

/** The StatusTrack step for a status ("Accepted risk" is an end state off the track). */
export function statusStep(s: FindingStatus): string {
  return STATUS_LABELS[s];
}

/** The status the page's one primary action moves to next, or null at the end. */
export function nextStatus(s: FindingStatus): FindingStatus | null {
  switch (s) {
    case 'new':
      return 'reviewed';
    case 'reviewed':
      return 'fixing';
    case 'fixing':
      return 'resolved';
    case 'resolved':
      return null;
    case 'accepted_risk':
      return 'reviewed';
  }
}

/** Primary action words: "Mark triaged", "Start fixing", "Mark resolved", "Reopen". */
export function actionLabel(to: FindingStatus): string {
  switch (to) {
    case 'new':
      return 'Reopen';
    case 'reviewed':
      return 'Mark triaged';
    case 'fixing':
      return 'Start fixing';
    case 'resolved':
      return 'Mark resolved';
    case 'accepted_risk':
      return 'Accept risk…';
  }
}

/** "Direct", "event-stream", "browser-sync +2" (who brings the package in). */
export function introducedText(ib: IntroducedBy | null | undefined): string {
  if (!ib) return '—';
  if (ib.via.length === 0) return ib.direct ? 'Direct' : '—';
  const first = ib.via[0]!;
  const more = ib.via.length - 1 + (ib.direct ? 1 : 0);
  return more > 0 ? `${first} +${more}` : first;
}

/** "2 h ago", "3 d ago", "2 mo ago" (relative to `now`). */
export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} d ago`;
  const mo = Math.round(d / 30);
  if (mo < 24) return `${mo} mo ago`;
  return `${Math.round(d / 365)} y ago`;
}

/** "Oct 22 2021" (UTC). */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).replace(',', '');
}

// ---------------------------------------------------------------------------
// Assignees (one request per page load)
// ---------------------------------------------------------------------------

let assigneeCache: Promise<PersonRef[]> | null = null;

/** Members a finding can be assigned to. Empty while loading or when the list is not allowed. */
export function useAssignees(): PersonRef[] {
  const [items, setItems] = useState<PersonRef[]>([]);
  useEffect(() => {
    let live = true;
    assigneeCache ??= api.assignees().then(
      (r) => r.items,
      () => {
        assigneeCache = null;
        return [];
      },
    );
    void assigneeCache.then((list) => live && setItems(list));
    return () => {
      live = false;
    };
  }, []);
  return items;
}

/** Tests reset the cache between renders. */
export function resetAssigneeCache(): void {
  assigneeCache = null;
}

// ---------------------------------------------------------------------------
// Permissions for a set of projects
// ---------------------------------------------------------------------------

export interface TriagePerms {
  review: boolean;
  acceptRisk: boolean;
}

/** True only when the viewer holds the permission in every one of the projects. */
export function useTriagePerms(projectIds: readonly string[]): TriagePerms {
  const { can } = useAuth();
  const all = (p: 'review' | 'accept_risk') => projectIds.length > 0 && projectIds.every((id) => can(p, id));
  return { review: all('review'), acceptRisk: all('accept_risk') };
}

// ---------------------------------------------------------------------------
// Accept risk dialog
// ---------------------------------------------------------------------------

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

export function AcceptRiskDialog({
  open,
  onOpenChange,
  count,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many findings this applies to (for the title). */
  count: number;
  onConfirm: (reason: string, expiresAt: string) => Promise<void>;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const [touched, setTouched] = useState<{ reason?: boolean; expires?: boolean }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setExpires('');
      setTouched({});
      setError(null);
    }
  }, [open]);
  const reasonError = !reason.trim() ? 'Give the reason the risk is accepted.' : null;
  const expiresError = !expires ? 'Pick the date the acceptance runs out.' : expires < tomorrow() ? 'The expiry date must be in the future.' : null;
  const submit = async () => {
    setTouched({ reason: true, expires: true });
    if (reasonError || expiresError) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim(), `${expires}T00:00:00.000Z`);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not accept the risk.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{count === 1 ? 'Accept the risk of this finding' : `Accept the risk of ${count} findings`}</DialogTitle>
          <DialogDescription>Accepted risk needs a reason and an expiry date. On that date the finding needs a new decision.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          aria-label="Accept risk"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-r`}>Reason *</Label>
            <Textarea
              id={`${id}-r`}
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, reason: true }))}
              aria-invalid={touched.reason && !!reasonError}
              aria-describedby={touched.reason && reasonError ? `${id}-re` : undefined}
              placeholder="e.g. Only used in a sandboxed build step"
            />
            {touched.reason && reasonError && (
              <span id={`${id}-re`} className="text-label text-destructive">
                {reasonError}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-e`}>Expires on *</Label>
            <Input
              id={`${id}-e`}
              type="date"
              min={tomorrow()}
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, expires: true }))}
              aria-invalid={touched.expires && !!expiresError}
              aria-describedby={touched.expires && expiresError ? `${id}-ee` : undefined}
              className="w-44"
            />
            {touched.expires && expiresError && (
              <span id={`${id}-ee`} className="text-label text-destructive">
                {expiresError}
              </span>
            )}
          </div>
          {error && (
            <p role="alert" className="text-label text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : 'Accept risk'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Status and Owner fields
// ---------------------------------------------------------------------------

const NONE = '__none__';
const MIXED = '__mixed__';

export interface TriageFieldsProps {
  /** Projects the change applies to (permissions are checked in every one). */
  projectIds: readonly string[];
  /** Current status, or null when the findings differ. */
  status: FindingStatus | null;
  /** Current owner id ('' = unassigned), or null when the findings differ. */
  ownerId: string | null;
  /** How many findings a change applies to. */
  count?: number;
  /** Save a change; the caller updates its rows. Throw to show the error. */
  onChange: (change: UpdateFindingStatusRequest) => Promise<void>;
  /** Layout: side by side (sheet) or stacked (rail). */
  layout?: 'stacked' | 'inline';
  extra?: ReactNode;
}

/**
 * Status and Owner, saved as soon as they change. "Accepted risk" opens the reason and expiry
 * dialog. Wrapped in a form named "Finding status".
 */
export function TriageFields({ projectIds, status, ownerId, count = 1, onChange, layout = 'stacked', extra }: TriageFieldsProps) {
  const id = useId();
  const perms = useTriagePerms(projectIds);
  const people = useAssignees();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [riskOpen, setRiskOpen] = useState(false);

  // Leaving accepted risk needs accept_risk, like the server.
  const statusLocked = !perms.review || (status === 'accepted_risk' && !perms.acceptRisk);
  const statusMissing = !perms.review ? 'review' : status === 'accepted_risk' && !perms.acceptRisk ? 'accept_risk' : !perms.acceptRisk ? 'accept_risk' : null;

  const save = async (change: UpdateFindingStatusRequest) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(change);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the change.');
    } finally {
      setBusy(false);
    }
  };

  const ownerKnown = ownerId === null || ownerId === '' || people.some((p) => p.id === ownerId);
  return (
    <form aria-label="Finding status" className={layout === 'inline' ? 'grid gap-3 sm:grid-cols-2' : 'flex flex-col gap-3'} onSubmit={(e) => e.preventDefault()}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={`${id}-s`} className="text-label font-medium">
          Status
        </Label>
        <Select
          value={status ?? MIXED}
          disabled={statusLocked || busy}
          onValueChange={(v) => {
            if (v === MIXED) return;
            if (v === 'accepted_risk') setRiskOpen(true);
            else void save({ status: v as FindingStatus });
          }}
        >
          <SelectTrigger id={`${id}-s`} size="sm" className="w-full" aria-describedby={statusMissing ? `${id}-why` : undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {status === null && (
              <SelectItem value={MIXED} disabled>
                Mixed
              </SelectItem>
            )}
            {FINDING_STATUSES.map((s) => (
              <SelectItem key={s} value={s} disabled={s === 'accepted_risk' ? !perms.acceptRisk : false}>
                {s === 'accepted_risk' ? 'Accepted risk…' : STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {statusMissing && <NotAllowedHint id={`${id}-why`} permission={statusMissing} className="text-caption" />}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={`${id}-o`} className="text-label font-medium">
          Owner <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Select
          value={ownerId === null ? MIXED : ownerId === '' ? NONE : ownerId}
          disabled={!perms.review || busy}
          onValueChange={(v) => {
            if (v === MIXED) return;
            void save({ ownerId: v === NONE ? null : v });
          }}
        >
          <SelectTrigger id={`${id}-o`} size="sm" className="w-full" aria-describedby={!perms.review ? `${id}-owhy` : undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ownerId === null && (
              <SelectItem value={MIXED} disabled>
                Mixed
              </SelectItem>
            )}
            <SelectItem value={NONE}>Unassigned</SelectItem>
            <SelectSeparator />
            {!ownerKnown && ownerId && <SelectItem value={ownerId}>Current owner</SelectItem>}
            {people.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!perms.review && <NotAllowedHint id={`${id}-owhy`} permission="review" className="text-caption" />}
      </div>
      {extra}
      {error && (
        <p role="alert" className="text-label text-destructive sm:col-span-2">
          {error}
        </p>
      )}
      <AcceptRiskDialog open={riskOpen} onOpenChange={setRiskOpen} count={count} onConfirm={(reason, expiresAt) => onChange({ status: 'accepted_risk', note: reason, expiresAt })} />
    </form>
  );
}
