/**
 * Proposed facts (/proposed-facts): what the agentic gap-filler proposed, with the app's
 * verification result for each one (docs/WHO-BEHIND-PLAN.md §10 "Agentic gap-filler").
 *
 * Shown from others: the value, the quote and the source page. Computed by us: the gate result
 * (re-fetched the page, found the quote, allowed domain, value matches the quote). Organisation
 * jurisdiction needs a person to confirm it before anything uses it; unverified proposals are for
 * review only and never shown as fact. A self-declared location can be removed on request.
 *
 * Data: GET /api/agentic/proposals; POST /api/agentic/proposals/:id/{confirm,reject,remove}.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { agenticApi, type AgentDecision, type AgentProposalRow, type AgentProposalStatus } from '@/api-agentic';
import { AGENT_PROPOSAL_STATUS_LABELS, AGENT_TASK_LABELS } from '@server/api-types-agentic';
import { useAuth } from '@/auth';
import { PROPOSED_FACTS_PATH } from '@/nav';
import { PageHeader } from '@/components/PageHeader';
import { StateBlock } from '@/components/br';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/useApi';
import { safeHref } from '@/lib/safe-href';

const STATUS_ORDER: AgentProposalStatus[] = ['pending_confirmation', 'unverified', 'verified', 'confirmed', 'rejected', 'removed'];
const STATUS_HINT: Record<AgentProposalStatus, string> = {
  pending_confirmation: 'verified, waiting for a person',
  unverified: 'failed verification, never used',
  verified: 'quote found on the source',
  confirmed: 'confirmed by a person',
  rejected: 'rejected by a person',
  removed: 'personal data removed',
};

type V = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const words = (s: string): string => s.replace(/_/g, ' ');

/** One readable line for a proposed value. Values are untrusted text: rendered as text only. */
export function valueText(row: Pick<AgentProposalRow, 'task' | 'value'>): string {
  const v = (row.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : {}) as V;
  switch (row.task) {
    case 'funding': {
      const amount = v.amount && typeof v.amount === 'object' ? (v.amount as V) : null;
      return [words(str(v.kind)), str(v.organization), amount ? `${Number(amount.value).toLocaleString('en-US')} ${str(amount.currency)}${amount.since ? ` since ${str(amount.since)}` : ''}` : ''].filter(Boolean).join(' · ');
    }
    case 'governance':
      return [words(str(v.kind)), str(v.organization)].filter(Boolean).join(' · ');
    case 'org_jurisdiction':
      return [`${str(v.country)}${v.region ? ` (${str(v.region)})` : ''}`, words(str(v.basis)), words(str(v.registry)), v.identifier ? `id ${str(v.identifier)}` : ''].filter(Boolean).join(' · ');
    case 'lifecycle_events':
    case 'incident_writeups':
      return [words(str(v.event ?? v.kind)), str(v.date), str(v.summary)].filter(Boolean).join(' · ');
    case 'person_self_declared_location':
      return v.location ? `${str(v.location)} (self-declared on own profile)` : '';
    case 'contributor_identity': {
      const f = str(v.field);
      if (f === 'account') return [`account ${str(v.login)}`, v.createdAt ? `created ${str(v.createdAt)}` : ''].filter(Boolean).join(' · ');
      if (f === 'location') return `location: ${str(v.text)} (self-declared on own profile)`;
      if (f === 'website') return `website: ${str(v.url)}`;
      if (f === 'org_membership') return `member of ${str(v.organization)}`;
      if (f === 'role') return `${str(v.role)} · ${str(v.project)}`;
      if (f === 'signing_key') return `${str(v.keyType).toUpperCase()} signing key ${str(v.keyId)}`;
      return `${words(f)}: ${str(v.text)}`;
    }
    default:
      return row.value === null ? '' : JSON.stringify(row.value);
  }
}

function hostOf(u: string | null): string {
  try {
    return u ? new URL(u).hostname : '';
  } catch {
    return '';
  }
}

function Actions({ row, onDone }: { row: AgentProposalRow; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (d: AgentDecision) => {
    setBusy(true);
    try {
      await agenticApi.decide(row.id, d);
      toast.success(d === 'confirm' ? 'Confirmed' : d === 'reject' ? 'Rejected' : 'Removed', { description: `${AGENT_TASK_LABELS[row.task] ?? row.task} for ${row.subject}` });
      onDone();
    } catch (e) {
      toast.error('Could not save the decision', { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const label = `${AGENT_TASK_LABELS[row.task] ?? row.task} for ${row.subject}: ${valueText(row) || 'removed value'}`;
  return (
    <span className="flex flex-wrap gap-1">
      {row.status === 'pending_confirmation' && (
        <Button size="sm" className="h-7" disabled={busy} onClick={() => void act('confirm')} aria-label={`Confirm ${label}`}>
          Confirm
        </Button>
      )}
      {(row.status === 'pending_confirmation' || row.status === 'unverified' || row.status === 'verified') && (
        <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void act('reject')} aria-label={`Reject ${label}`}>
          Reject
        </Button>
      )}
      {(row.task === 'person_self_declared_location' || row.task === 'contributor_identity') && row.status !== 'removed' && (
        <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void act('remove')} aria-label={`Remove ${label}`}>
          Remove
        </Button>
      )}
    </span>
  );
}

function ProposalTable({ rows, canReview, onDone }: { rows: readonly AgentProposalRow[]; canReview: boolean; onDone: () => void }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Proposed facts" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-3 py-2 font-medium">Fact</th>
            <th scope="col" className="px-2 py-2 font-medium">Value</th>
            <th scope="col" className="px-2 py-2 font-medium">Evidence</th>
            <th scope="col" className="px-2 py-2 font-medium">Status</th>
            {canReview && (
              <th scope="col" className="px-3 py-2 font-medium">
                Decision
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = r.sourceUrl ? safeHref(r.sourceUrl) : null;
            return (
              <tr key={r.id} className="border-t align-top" data-status={r.status}>
                <td className="px-3 py-2">
                  <span className="flex flex-col">
                    <span className="font-medium">{AGENT_TASK_LABELS[r.task] ?? r.task}</span>
                    <span className="break-all font-mono text-[12px]">{r.subject}</span>
                  </span>
                </td>
                <td className="max-w-[18rem] px-2 py-2">{r.status === 'removed' ? <span className="text-text-secondary">Removed</span> : valueText(r)}</td>
                <td className="max-w-[26rem] px-2 py-2">
                  {r.quote ? (
                    <span className="flex flex-col gap-1">
                      <q className="text-label">{r.quote}</q>
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-caption underline underline-offset-2">
                          {hostOf(r.sourceUrl)}
                        </a>
                      ) : (
                        <span className="text-caption text-text-secondary">{hostOf(r.sourceUrl)}</span>
                      )}
                      {r.confidenceNote && <span className="text-caption text-text-secondary">Agent's note: {r.confidenceNote}</span>}
                    </span>
                  ) : (
                    <span className="text-text-secondary">—</span>
                  )}
                </td>
                <td className="px-2 py-2">
                  <span className="flex flex-col">
                    <span className={r.status === 'pending_confirmation' || r.status === 'unverified' ? 'font-semibold' : undefined}>{AGENT_PROPOSAL_STATUS_LABELS[r.status]}</span>
                    {r.label === 'self-declared' && <span className="text-caption text-text-secondary">Self-declared</span>}
                    {r.reasons.map((reason) => (
                      <span key={reason} className="text-caption text-text-secondary">
                        {reason}
                      </span>
                    ))}
                    {r.decidedBy && (
                      <span className="text-caption text-text-secondary">
                        by {r.decidedBy}
                        {r.decisionNote ? `: ${r.decisionNote}` : ''}
                      </span>
                    )}
                  </span>
                </td>
                {canReview && (
                  <td className="px-3 py-2">
                    <Actions row={r} onDone={onDone} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ProposedFacts() {
  const { me } = useAuth();
  const [status, setStatus] = useState<AgentProposalStatus | null>(null);
  const { data, error, loading, reload } = useApi((s) => agenticApi.proposals({ ...(status ? { status } : {}), limit: 500 }, s), [status]);
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Proposed facts', to: PROPOSED_FACTS_PATH },
  ];
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

  let body;
  if (loading && !data) body = <StateBlock kind="loading" label="Loading proposed facts" rows={5} columns={4} />;
  else if (error && !data) body = <StateBlock kind="error" title="Could not load proposed facts" cause={error.message} onRetry={reload} />;
  else if (data && total === 0)
    body = <StateBlock kind="no-results" title="No proposed facts yet" description="They appear after a scan runs with the agentic gap-filler turned on (--agentic and an API key)." actions={[{ label: 'Open projects', to: '/projects' }]} />;
  else if (data)
    body = (
      <>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {STATUS_ORDER.map((st) => (
            <button
              key={st}
              type="button"
              aria-pressed={status === st}
              onClick={() => setStatus(status === st ? null : st)}
              className="flex min-w-[9rem] flex-1 flex-col gap-0.5 rounded-xl border bg-card px-4 py-3 text-left hover:bg-muted aria-pressed:border-foreground"
            >
              <span className="text-label text-text-secondary">{AGENT_PROPOSAL_STATUS_LABELS[st]}</span>
              <span className="font-mono text-2xl font-semibold tabular-nums">{data.counts[st]}</span>
              <span className="text-caption text-text-secondary">{STATUS_HINT[st]}</span>
            </button>
          ))}
        </div>
        {data.items.length === 0 ? (
          <StateBlock kind="no-results" title="No proposal has this status" actions={[{ label: 'Show all', onClick: () => setStatus(null) }]} />
        ) : (
          <ProposalTable rows={data.items} canReview={data.canReview} onDone={reload} />
        )}
        {!data.personLevelShown && <p className="m-0 text-label text-text-secondary">Person-level proposals (contributor identity, self-declared locations) are shown only to people who manage projects.</p>}
        {data.total > data.items.length && (
          <p className="m-0 text-label text-text-secondary">
            Showing {data.items.length} of {data.total}.
          </p>
        )}
      </>
    );

  return (
    <>
      <PageHeader crumbs={crumbs} title="Proposed facts" meta={data ? `${total} proposals · ${data.counts.pending_confirmation} need confirmation` : undefined} />
      <div className="flex flex-col gap-4 p-4">
        <p className="m-0 text-text-secondary" role="note">
          {data?.note ?? 'Proposed by an AI agent from public pages; only verified proposals are used as facts.'}
        </p>
        {body}
      </div>
    </>
  );
}
