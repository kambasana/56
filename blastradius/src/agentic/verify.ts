/**
 * Verification gate. Deterministic and run by the app, never by the model:
 *
 *   task binding → value schema → privacy screen → source domain → quote length
 *   → re-fetch the source URL ourselves → quote present after normalising HTML and whitespace
 *   → the task's own value ↔ quote rules.
 *
 * A proposal that fails the privacy screen is refused outright (its value is not kept). Any other
 * failure leaves an `unverified` proposal for review. A pass gives `verified`, or
 * `pending_confirmation` for tasks that need a human (org jurisdiction).
 */
import { createHash } from 'node:crypto';
import type { HttpClient } from '../core/http.js';
import type { AgentGateCheck, AgentJson, AgentProposal } from '../core/agentic-types.js';
import { findQuote, pageText, quoteWeight } from './normalize.js';
import { screenProposalValue } from './privacy.js';
import { hostMatches, type FactRequest, type TaskSpec } from './tasks.js';

/** A fact as the agent proposed it, before the gate. */
export interface ProposedFact {
  task: string;
  subject: string;
  value: AgentJson;
  sourceUrl: string;
  quote: string;
  retrievedAt: string;
  confidenceNote: string;
}

export const MIN_QUOTE_CHARS = 12;
/** Redirects followed when re-fetching a source; each hop must stay on the task's evidence domains. */
export const MAX_REDIRECTS = 5;
export const REDIRECT_OFF_DOMAIN = 'redirected off allowed domain';
export const MAX_QUOTE_CHARS = 1500;

export type GateResult = { kind: 'proposal'; proposal: AgentProposal } | { kind: 'privacy'; reason: string };

/** Stable id: same task, subject, value and source → same proposal across scans. */
export function proposalId(p: Pick<ProposedFact, 'task' | 'subject' | 'value' | 'sourceUrl'>): string {
  const h = createHash('sha256').update(JSON.stringify([p.task, p.subject, canonicalJson(p.value), p.sourceUrl])).digest('hex');
  return `prop_${h.slice(0, 20)}`;
}

function canonicalJson(v: AgentJson): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Evidence domains for a request: the task's own plus, if it allows them, the subject's context domains. */
export function allowedDomains(spec: TaskSpec, req: FactRequest): string[] {
  const ctx = spec.contextDomains ? (req.context?.domains ?? []) : [];
  return [...new Set([...spec.domains, ...ctx].map((d) => d.toLowerCase()))].sort();
}

export interface GateOptions {
  http: HttpClient;
  now: Date;
  /** Cache TTL for re-fetched sources (default 1 hour). */
  ttlMs?: number;
}

export async function verifyProposal(p: ProposedFact, req: FactRequest, spec: TaskSpec, opts: GateOptions): Promise<GateResult> {
  const checks: AgentGateCheck[] = [];
  // The evidence is the page that was actually read: the final URL after redirects.
  let evidenceUrl = p.sourceUrl;
  const reasons: string[] = [];
  /** Fields the task's rules could not verify (kept, shown as unverified). */
  const flagged: { field: string; reason: string }[] = [];
  const fail = (check: AgentGateCheck['check'], detail: string): void => {
    checks.push({ check, ok: false, detail });
    reasons.push(detail);
  };
  const pass = (check: AgentGateCheck['check'], detail?: string): void => {
    checks.push(detail ? { check, ok: true, detail } : { check, ok: true });
  };
  const done = (): GateResult => {
    const ok = reasons.length === 0;
    const proposal: AgentProposal = {
      id: proposalId(p),
      task: p.task,
      subject: p.subject,
      subjectKind: req.subjectKind,
      value: p.value,
      sourceUrl: evidenceUrl,
      quote: p.quote,
      retrievedAt: p.retrievedAt,
      confidenceNote: p.confidenceNote,
      status: ok ? (spec.storage === 'pending_confirmation' ? 'pending_confirmation' : 'verified') : 'unverified',
      checks,
      reasons,
    };
    // Locations are always labelled self-declared (the person location task, and the location field of contributor_identity).
    const isLocationField = p.value !== null && typeof p.value === 'object' && !Array.isArray(p.value) && p.value.field === 'location';
    if (flagged.length > 0) proposal.unverifiedFields = [...new Set(flagged.map((f) => f.field))].sort();
    if (spec.label) proposal.label = spec.label;
    else if (isLocationField) proposal.label = 'self-declared';
    if (ok) proposal.verifiedAt = opts.now.toISOString();
    return { kind: 'proposal', proposal };
  };

  // 1. The model cannot change the task or the subject: both are bound by the request.
  if (p.task !== req.task || p.subject !== req.subject) {
    fail('task_binding', `proposal is for ${p.task} / ${p.subject}, the request was ${req.task} / ${req.subject}`);
    return done();
  }
  pass('task_binding');

  // 2. Privacy first: a refused value is never kept, whatever else is wrong with it.
  const privacy = screenProposalValue(spec.id, p.value);
  if (privacy) return { kind: 'privacy', reason: privacy };

  // 3. Schema.
  const parsed = spec.schema.safeParse(p.value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    fail('schema', `value does not match the ${spec.id} schema: ${first ? `${first.path.join('.') || 'value'}: ${first.message}` : 'invalid'}`);
    return done();
  }
  pass('schema');
  pass('privacy');

  // 4. Source domain.
  let url: URL;
  try {
    url = new URL(p.sourceUrl);
  } catch {
    fail('domain', 'source URL is not a URL');
    return done();
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail('domain', 'source URL must be plain https');
    return done();
  }
  const domains = allowedDomains(spec, req);
  if (!domains.some((d) => hostMatches(url.hostname, d))) {
    fail('domain', `${url.hostname} is not an allowed source for ${spec.id}`);
    return done();
  }
  pass('domain', url.hostname);

  // 5. Quote length (letters and digits).
  const weight = quoteWeight(p.quote);
  if (weight < MIN_QUOTE_CHARS || p.quote.length > MAX_QUOTE_CHARS) {
    fail('quote_length', `quote must have ${MIN_QUOTE_CHARS}–${MAX_QUOTE_CHARS} characters (has ${weight} letters/digits, ${p.quote.length} chars)`);
    return done();
  }
  pass('quote_length');

  // 6. Re-fetch the source ourselves (cached, offline fixtures in tests). Redirects are followed
  // by hand (at most MAX_REDIRECTS), and every hop must stay plain https on an allowed domain.
  let body: string;
  try {
    let at = url;
    for (let hop = 0; ; hop++) {
      const res = await opts.http.request(at.href, { headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8' }, ttlMs: opts.ttlMs ?? 60 * 60 * 1000, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) {
          fail('fetch', `source answered HTTP ${res.status} without a Location when re-fetched`);
          return done();
        }
        if (hop >= MAX_REDIRECTS) {
          fail('fetch', `source redirected more than ${MAX_REDIRECTS} times when re-fetched`);
          return done();
        }
        let next: URL;
        try {
          next = new URL(res.location, at);
        } catch {
          fail('domain', REDIRECT_OFF_DOMAIN);
          return done();
        }
        if (next.protocol !== 'https:' || next.username || next.password || !domains.some((d) => hostMatches(next.hostname, d))) {
          fail('domain', REDIRECT_OFF_DOMAIN);
          return done();
        }
        at = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        fail('fetch', `source answered HTTP ${res.status} when re-fetched`);
        return done();
      }
      body = res.body;
      break;
    }
    if (at !== url) {
      url = at;
      evidenceUrl = at.href;
    }
  } catch (e) {
    fail('fetch', `source could not be re-fetched: ${(e as Error).message.slice(0, 200)}`);
    return done();
  }
  pass('fetch');

  // 7. Quote present.
  const page = pageText(body);
  const match = findQuote(page, p.quote);
  if (!match) {
    fail('quote_present', 'the quoted text is not on the source page');
    return done();
  }
  pass('quote_present', match);

  // 8. Task rules (value ↔ quote).
  const flag = (field: string, reason: string): void => {
    flagged.push({ field, reason });
  };
  const problems = spec.rules?.({ value: parsed.data, quote: p.quote, sourceUrl: url, request: req, page, body, flag }) ?? [];
  if (problems.length > 0) for (const pr of problems) fail('task_rules', pr);
  else pass('task_rules', flagged.length > 0 ? flagged.map((f) => `${f.field} unverified: ${f.reason}`).join('; ') : undefined);
  return done();
}
