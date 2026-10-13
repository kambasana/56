/**
 * Outbound blast radius for workflows/repos we publish from (PLAN §3.6 step 5):
 *
 *   blast_out = compromise_likelihood · log10(1 + downstream_dependents) · publish_reach
 *
 * Input is the structural subset of ingest's `WorkflowInfo` that scoring needs.
 * `score` = 100 · blast_out (when dependents are unknown the dependents term is 1).
 */
import type { OutboundFinding, Reason } from '../core/types.js';
import { OUTBOUND_WEIGHTS, PUBLISH_REACH } from './weights.js';
import { cmpStr, noisyOr, round, short, sortReasons } from './util.js';

/** Structural subset of `WorkflowInfo` (src/ingest/workflows.ts). */
export interface WorkflowRiskInput {
  assetId: string;
  path: string;
  privilegedTriggers: string[];
  permissionsUndeclared: boolean;
  writeScopes: string[];
  hasWriteTokens: boolean;
  hasOidc: boolean;
  publishes: boolean;
  checksOutPrHead: boolean;
  actions: { uses: string; kind: string; pinning: string }[];
}

export interface OutboundOptions {
  /** Downstream dependents of what each asset publishes (by asset id), e.g. from `dependents` facts. */
  dependents?: Record<string, number>;
}

export function scoreWorkflowOutbound(wf: WorkflowRiskInput, opts: OutboundOptions = {}): OutboundFinding {
  const W = OUTBOUND_WEIGHTS;
  const terms: { factor: string; value: number; weight: number; detail: string }[] = [];
  const priv = [...new Set(wf.privilegedTriggers ?? [])].sort(cmpStr);
  if (priv.length > 0) {
    terms.push({
      factor: wf.checksOutPrHead ? 'pr_head_checkout' : 'privileged_trigger',
      value: 1,
      weight: wf.checksOutPrHead ? W.pr_head_checkout : W.privileged_trigger,
      detail: wf.checksOutPrHead
        ? `Checks out pull-request head code under privileged trigger(s): ${priv.map((t) => short(t, 40)).join(', ')}`
        : `Uses privileged trigger(s): ${priv.map((t) => short(t, 40)).join(', ')}`,
    });
  }
  const remote = (wf.actions ?? []).filter((a) => a.kind !== 'local');
  const unpinned = remote.filter((a) => a.pinning !== 'sha' && a.pinning !== 'digest');
  if (unpinned.length > 0) {
    const names = [...new Set(unpinned.map((a) => short(a.uses, 80)))].sort(cmpStr);
    terms.push({
      factor: 'unpinned_actions',
      value: Math.min(1, unpinned.length / Math.max(1, remote.length)),
      weight: W.unpinned_actions,
      detail: `${unpinned.length} of ${remote.length} action/workflow references not pinned to a commit SHA: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`,
    });
  }
  if (wf.hasWriteTokens) {
    const scopes = [...new Set(wf.writeScopes ?? [])].sort(cmpStr);
    terms.push({
      factor: 'write_permissions',
      value: 1,
      weight: W.write_permissions,
      detail: `GITHUB_TOKEN has write access${scopes.length ? ` (${scopes.map((s) => short(s, 30)).join(', ')})` : ''}`,
    });
  } else if (wf.permissionsUndeclared) {
    terms.push({
      factor: 'undeclared_permissions',
      value: 1,
      weight: W.undeclared_permissions,
      detail: 'No `permissions:` declared; the repository default token permissions apply',
    });
  }
  if (wf.hasOidc) {
    terms.push({ factor: 'oidc', value: 1, weight: W.oidc, detail: 'Requests `id-token: write` (OIDC token for cloud/registry access)' });
  }

  terms.sort((a, b) => b.weight * b.value - a.weight * a.value || cmpStr(a.factor, b.factor));
  const { total: likelihood, contributions } = noisyOr(terms);
  const reach = wf.publishes ? PUBLISH_REACH.publishes : wf.hasOidc || wf.hasWriteTokens ? PUBLISH_REACH.deployCapable : PUBLISH_REACH.none;
  const dependents = opts.dependents?.[wf.assetId];
  const depFactor = typeof dependents === 'number' && dependents >= 0 ? Math.log10(1 + dependents) : 1;

  const reasons: Reason[] = terms.map((t, i) => ({
    factor: t.factor,
    value: round(t.value),
    weight: t.weight,
    contribution: round(contributions[i] ?? 0),
    detail: t.detail,
    evidence: [],
  }));
  reasons.push({
    factor: 'publish_reach',
    value: reach,
    weight: 1,
    contribution: 0,
    detail: wf.publishes
      ? 'Workflow publishes packages or images'
      : reach === PUBLISH_REACH.deployCapable
        ? 'Workflow holds write/OIDC credentials but no publish step was detected'
        : 'No publish step or privileged credentials detected',
    evidence: [],
  });
  const out: OutboundFinding = {
    assetId: wf.assetId,
    score: round(100 * likelihood * reach * depFactor, 1),
    reasons: sortReasons(reasons),
  };
  if (typeof dependents === 'number') out.dependents = dependents;
  return out;
}

export function scoreOutbound(workflows: readonly WorkflowRiskInput[], opts: OutboundOptions = {}): OutboundFinding[] {
  return workflows
    .map((w) => scoreWorkflowOutbound(w, opts))
    .sort((a, b) => b.score - a.score || cmpStr(a.assetId, b.assetId));
}
