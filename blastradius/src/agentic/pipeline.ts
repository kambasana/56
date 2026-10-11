/**
 * The agentic gap-filler pipeline: one pipeline, a task spec per fact type.
 *
 *   FactRequest → privacy screen → result cache (TTL) / in-flight dedupe → agent run (budgeted)
 *   → verification gate (re-fetch, quote, domain, task rules) → verified facts + proposals.
 *
 * Verified proposals become `agent_fact` facts with source `agent:<task>`, the evidence URL and
 * the quote. `pending_confirmation` ones (org jurisdiction) are facts with that status: nothing
 * uses them until a human confirms. Unverified proposals are kept for review only.
 * Privacy refusals keep no value.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { HttpClient } from '../core/http.js';
import { makeFact, type Fact } from '../core/types.js';
import type { AgentPrivacyRejection, AgentProposal, AgentRefusedRequest, AgenticReport } from '../core/agentic-types.js';
import { AgentBudget, runAgent, type AgentRunResult } from './agent.js';
import type { AgentEffort, ModelClient } from './model.js';
import { screenRequest } from './privacy.js';
import { defaultTaskRegistry, type FactRequest, type TaskRegistry, type TaskSpec } from './tasks.js';
import { verifyProposal, type ProposedFact } from './verify.js';

export interface AgenticBudgetOptions {
  /** Model API requests per scan (default 60). */
  maxRequests?: number;
  /** Input + output tokens per scan (default 1,500,000). */
  maxTokens?: number;
  /** Fact requests sent to the model per scan (default 25). */
  maxRuns?: number;
}

export interface AgenticPipelineOptions {
  model: ModelClient;
  http: HttpClient;
  now: Date;
  /** Facts from the deterministic collectors (collected_facts tool). */
  facts?: () => readonly Fact[];
  registry?: TaskRegistry;
  budget?: AgenticBudgetOptions;
  /** Result cache directory (false = no disk cache) and TTL (default 7 days). */
  cacheDir?: string | false;
  cacheTtlMs?: number;
  /** Person-level tasks (self-declared location) are off unless this is true. */
  personTasks?: boolean;
  effort?: AgentEffort;
  log?: (m: string) => void;
}

export interface RequestOutcome {
  request: FactRequest;
  refused?: string;
  cached: boolean;
  run?: Pick<AgentRunResult, 'stop' | 'noneFoundReason' | 'malformed' | 'turns' | 'error'>;
  proposals: AgentProposal[];
  privacyRejections: AgentPrivacyRejection[];
}

interface CacheEntry {
  key: string;
  storedAt: number;
  proposals: ProposedFact[];
  run: RequestOutcome['run'];
}

const DAY = 24 * 60 * 60 * 1000;

export class AgenticPipeline {
  readonly registry: TaskRegistry;
  private readonly budget: AgentBudget;
  private readonly maxRuns: number;
  private runs = 0;
  private cachedCount = 0;
  private budgetHit = false;
  private readonly inflight = new Map<string, Promise<{ proposals: ProposedFact[]; run: RequestOutcome['run']; cached: boolean }>>();
  private readonly proposals = new Map<string, AgentProposal>();
  private readonly privacy: AgentPrivacyRejection[] = [];
  private readonly refused: AgentRefusedRequest[] = [];
  private readonly schemas = new Map<string, Record<string, unknown>>();

  constructor(private readonly opts: AgenticPipelineOptions) {
    this.registry = opts.registry ?? defaultTaskRegistry();
    this.budget = new AgentBudget(opts.budget?.maxRequests ?? 60, opts.budget?.maxTokens ?? 1_500_000);
    this.maxRuns = opts.budget?.maxRuns ?? 25;
  }

  /** JSON Schema of a task's value, for the submit tool (stable per task). */
  private valueSchema(spec: TaskSpec): Record<string, unknown> {
    let s = this.schemas.get(spec.id);
    if (!s) {
      s = z.toJSONSchema(spec.schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
      delete s.$schema;
      this.schemas.set(spec.id, s);
    }
    return s;
  }

  /** Cache key: task (and its version), subject, question, model. Context is not part of it on purpose: same question, same answer. */
  private cacheKey(spec: TaskSpec, req: FactRequest): string {
    return createHash('sha256')
      .update(JSON.stringify([spec.id, spec.version, req.subject, req.question.trim(), this.opts.model.model, req.context?.profileUrl ?? null]))
      .digest('hex');
  }

  private cachePath(key: string): string | undefined {
    return this.opts.cacheDir ? join(this.opts.cacheDir, `${key}.json`) : undefined;
  }

  private async readCache(key: string): Promise<CacheEntry | undefined> {
    const p = this.cachePath(key);
    if (!p) return undefined;
    try {
      const e = JSON.parse(await readFile(p, 'utf8')) as CacheEntry;
      const ttl = this.opts.cacheTtlMs ?? 7 * DAY;
      if (e.key !== key || typeof e.storedAt !== 'number' || this.opts.now.getTime() - e.storedAt > ttl || e.storedAt > this.opts.now.getTime() + 5 * 60_000) return undefined;
      return e;
    } catch {
      return undefined;
    }
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    const p = this.cachePath(entry.key);
    if (!p || !this.opts.cacheDir) return;
    try {
      await mkdir(this.opts.cacheDir, { recursive: true });
      const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(entry));
      await rename(tmp, p);
    } catch {
      // best effort
    }
  }

  /** Run one fact request end to end. Never throws for a single request. */
  async request(req: FactRequest): Promise<RequestOutcome> {
    const spec = this.registry.get(req.task);
    const refuse = (reason: string): RequestOutcome => {
      this.refused.push({ task: req.task, subject: req.subject, reason });
      return { request: req, refused: reason, cached: false, proposals: [], privacyRejections: [] };
    };
    // Privacy screening first: a forbidden request is refused even if no such task exists.
    const screened = screenRequest(req, { personTasksEnabled: this.opts.personTasks === true });
    if (screened) return refuse(screened);
    if (!spec) return refuse(`unknown task "${req.task}"`);
    if (!spec.subjectKinds.includes(req.subjectKind)) return refuse(`task ${spec.id} does not take a ${req.subjectKind} subject`);

    const key = this.cacheKey(spec, req);
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.produce(spec, req, key);
      this.inflight.set(key, pending);
    }
    const produced = await pending;

    const out: RequestOutcome = { request: req, cached: produced.cached, proposals: [], privacyRejections: [] };
    if (produced.run) out.run = produced.run;
    for (const p of produced.proposals) {
      const gate = await verifyProposal(p, req, spec, { http: this.opts.http, now: this.opts.now });
      if (gate.kind === 'privacy') {
        const r = { task: req.task, subject: req.subject, reason: gate.reason };
        out.privacyRejections.push(r);
        if (!this.privacy.some((x) => x.task === r.task && x.subject === r.subject && x.reason === r.reason)) this.privacy.push(r);
        continue;
      }
      out.proposals.push(gate.proposal);
      this.proposals.set(gate.proposal.id, gate.proposal);
    }
    return out;
  }

  private async produce(spec: TaskSpec, req: FactRequest, key: string): Promise<{ proposals: ProposedFact[]; run: RequestOutcome['run']; cached: boolean }> {
    const hit = await this.readCache(key);
    if (hit) {
      this.cachedCount++;
      // Cached proposals are re-bound to this request (task/subject) and re-verified like new ones.
      return { proposals: hit.proposals.map((p) => ({ ...p, task: req.task, subject: req.subject })), run: hit.run, cached: true };
    }
    if (this.runs >= this.maxRuns || this.budget.exhausted) {
      this.budgetHit = true;
      return { proposals: [], run: { stop: 'budget', malformed: [], turns: 0 }, cached: false };
    }
    this.runs++;
    this.opts.log?.(`agentic: ${spec.id} for ${req.subject}`);
    const res = await runAgent(spec, req, this.valueSchema(spec), {
      model: this.opts.model,
      budget: this.budget,
      tools: { http: this.opts.http, facts: this.opts.facts ?? (() => []) },
      now: this.opts.now,
      effort: this.opts.effort ?? 'high',
    });
    if (res.stop === 'budget') this.budgetHit = true;
    const run: RequestOutcome['run'] = { stop: res.stop, malformed: res.malformed, turns: res.turns };
    if (res.noneFoundReason) run.noneFoundReason = res.noneFoundReason;
    if (res.error) run.error = res.error;
    // Only completed runs are cached (a budget stop or an API error should be retried next scan).
    if (res.stop === 'submitted') await this.writeCache({ key, storedAt: this.opts.now.getTime(), proposals: res.proposals, run });
    return { proposals: res.proposals, run, cached: false };
  }

  /** Run several requests (sequentially: the budget is shared and runs are cheap to order). */
  async requestAll(reqs: readonly FactRequest[]): Promise<RequestOutcome[]> {
    const out: RequestOutcome[] = [];
    for (const r of reqs) out.push(await this.request(r));
    return out;
  }

  /** Verified and pending-confirmation proposals as facts (source `agent:<task>`). */
  facts(): Fact[] {
    const out: Fact[] = [];
    for (const p of [...this.proposals.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (p.status !== 'verified' && p.status !== 'pending_confirmation') continue;
      const value = {
        task: p.task,
        value: p.value,
        quote: p.quote,
        sourceUrl: p.sourceUrl,
        retrievedAt: p.retrievedAt,
        verifiedAt: p.verifiedAt ?? this.opts.now.toISOString(),
        confidenceNote: p.confidenceNote,
        status: p.status,
        proposalId: p.id,
        ...(p.label ? { label: p.label } : {}),
      } as const;
      out.push(makeFact('agent_fact', p.subject, value, { source: `agent:${p.task}`, fetchedAt: this.opts.now, evidence: [p.sourceUrl] }));
    }
    return out;
  }

  report(): AgenticReport {
    return {
      model: this.opts.model.model,
      runs: this.runs,
      cached: this.cachedCount,
      requests: this.budget.requests,
      inputTokens: this.budget.inputTokens,
      outputTokens: this.budget.outputTokens,
      budgetExhausted: this.budgetHit,
      proposals: [...this.proposals.values()].sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.id < b.id ? -1 : 1)),
      privacyRejections: [...this.privacy],
      refused: [...this.refused],
    };
  }
}
