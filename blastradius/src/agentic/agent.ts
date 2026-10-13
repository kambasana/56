/**
 * One agent run: a fact request goes to the model with the task's fixed tool set; the run ends
 * when the model calls submit_facts (or stops, refuses, or a budget runs out). Returns proposed
 * facts only; nothing is stored here (the gate decides).
 *
 * A manual loop rather than the SDK tool runner: the run must check the shared per-scan budget
 * before every request, refuse tools the task does not allow, resume `pause_turn` from the
 * server-side web tools, stop on `refusal`, and replay deterministically in tests.
 *
 * Conversation is append-only (the assistant content is sent back unchanged each turn), so prompt
 * caching and thinking-block rules hold. The system prompt and tool list are fixed per task, and
 * the request-specific text is in the first user message, after the cache prefix.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AgentJson } from '../core/agentic-types.js';
import { requestLine, type AgentEffort, type ModelClient, type ModelMessage, type ModelParams } from './model.js';
import { GUARDRAIL_PROMPT } from './privacy.js';
import type { FactRequest, TaskSpec } from './tasks.js';
import { runClientTool, toolDefinitions, untrusted, type ToolContext } from './tools.js';
import type { ProposedFact } from './verify.js';
import { allowedDomains } from './verify.js';

type BetaParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaBlock = Anthropic.Beta.Messages.BetaContentBlock;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** Shared per-scan budget: model requests and tokens. */
export class AgentBudget {
  requests = 0;
  inputTokens = 0;
  outputTokens = 0;
  constructor(
    readonly maxRequests: number,
    readonly maxTokens: number,
  ) {}
  get exhausted(): boolean {
    return this.requests >= this.maxRequests || this.inputTokens + this.outputTokens >= this.maxTokens;
  }
  charge(usage: ModelMessage['usage'] | undefined): void {
    this.requests++;
    if (!usage) return;
    this.inputTokens += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    this.outputTokens += usage.output_tokens ?? 0;
  }
}

export interface AgentRunOptions {
  model: ModelClient;
  budget: AgentBudget;
  tools: Omit<ToolContext, 'request' | 'spec'>;
  now: Date;
  effort: AgentEffort;
  /** Turns per run (default 12). */
  maxTurns?: number;
  /** Client tool calls per run (default 20). */
  maxToolCalls?: number;
}

export type AgentStop = 'submitted' | 'no_submit' | 'refusal' | 'budget' | 'max_turns' | 'max_tokens' | 'error';

export interface AgentRunResult {
  proposals: ProposedFact[];
  stop: AgentStop;
  noneFoundReason?: string;
  /** Submissions that did not parse (bad shape), with the reason. */
  malformed: string[];
  turns: number;
  error?: string;
}

const submitItem = z.object({ value: z.unknown(), source_url: z.string().max(2000), quote: z.string().max(5000), confidence_note: z.string().max(1000).optional() }).strict();
const submitInput = z.object({ facts: z.array(z.unknown()).max(50), none_found_reason: z.string().max(2000).optional() }).strict();

/** The fixed system prompt for a task (guardrails + task + output contract). Same for every subject. */
export function systemPrompt(spec: TaskSpec): string {
  return [
    'You collect public facts about open source software supply chains for Blastradius, a dependency auditor. You propose facts; the application verifies each one against its source before anything is stored.',
    GUARDRAIL_PROMPT,
    spec.instructions,
    `Finish by calling submit_facts exactly once (at most ${spec.maxFacts} facts). If nothing reliable is found, submit an empty list with none_found_reason. Do not guess.`,
  ].join('\n\n');
}

/** The first user message: request line (for replay), subject, question and allowed domains. */
export function firstMessage(spec: TaskSpec, req: FactRequest): string {
  const ctx = req.context ?? {};
  const lines = [
    requestLine(req.task, req.subject),
    `Subject (${req.subjectKind}): ${req.subject}${ctx.name ? ` (${ctx.name})` : ''}`,
    `Question: ${req.question}`,
  ];
  if (ctx.packageName) lines.push(`Package: ${ctx.ecosystem ?? ''} ${ctx.packageName}`.trim());
  if (ctx.repoUrl) lines.push(`Repository: ${ctx.repoUrl}`);
  if (ctx.homepage) lines.push(`Homepage: ${ctx.homepage}`);
  if (ctx.profileUrl) lines.push(`profile_url: ${ctx.profileUrl}`);
  lines.push(`Sources accepted as evidence for this task: ${allowedDomains(spec, req).join(', ')}`);
  if (ctx.known?.length) lines.push('Already known (from our collectors):', ...ctx.known.slice(0, 20).map((k) => `- ${k}`));
  return lines.join('\n');
}

function asJson(v: unknown): AgentJson | undefined {
  try {
    return JSON.parse(JSON.stringify(v)) as AgentJson;
  } catch {
    return undefined;
  }
}

/** retrieved_at of the web_fetch results in the conversation, by URL. */
function fetchTimes(messages: readonly BetaParam[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content as unknown as BetaBlock[]) {
      if (b.type === 'web_fetch_tool_result' && b.content.type === 'web_fetch_result' && b.content.retrieved_at) out.set(b.content.url, b.content.retrieved_at);
    }
  }
  return out;
}

export async function runAgent(spec: TaskSpec, req: FactRequest, valueJsonSchema: Record<string, unknown>, opts: AgentRunOptions): Promise<AgentRunResult> {
  const tools = toolDefinitions(spec, req, valueJsonSchema);
  const system = systemPrompt(spec);
  const messages: BetaParam[] = [{ role: 'user', content: [{ type: 'text', text: firstMessage(spec, req) }] }];
  const toolCtx: ToolContext = { ...opts.tools, request: req, spec };
  const maxTurns = opts.maxTurns ?? 12;
  const maxToolCalls = opts.maxToolCalls ?? 20;
  let toolCalls = 0;
  let nudged = false;
  const malformed: string[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.budget.exhausted) return { proposals: [], stop: 'budget', malformed, turns: turn };
    const params: ModelParams = {
      model: opts.model.model,
      max_tokens: 16_000,
      system: [{ type: 'text', text: system }],
      tools,
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort },
      // Top-level automatic caching: the stable prefix (tools, system) and the growing history.
      cache_control: { type: 'ephemeral' },
    };
    let res: ModelMessage;
    try {
      res = await opts.model.create(params);
    } catch (e) {
      opts.budget.charge(undefined);
      return { proposals: [], stop: 'error', malformed, turns: turn + 1, error: (e as Error).message };
    }
    opts.budget.charge(res.usage);
    // Append the assistant turn unchanged (thinking blocks, server tool blocks and all).
    messages.push({ role: 'assistant', content: res.content as unknown as BetaParam['content'] });

    if (res.stop_reason === 'refusal') return { proposals: [], stop: 'refusal', malformed, turns: turn + 1 };
    if (res.stop_reason === 'pause_turn') continue;

    const uses = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
    const submit = uses.find((u) => u.name === 'submit_facts');
    if (submit) {
      if (res.stop_reason === 'max_tokens') return { proposals: [], stop: 'max_tokens', malformed, turns: turn + 1 };
      const parsed = submitInput.safeParse(submit.input);
      if (!parsed.success) {
        malformed.push(`submit_facts input: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        return { proposals: [], stop: 'submitted', malformed, turns: turn + 1 };
      }
      const times = fetchTimes(messages);
      const proposals: ProposedFact[] = [];
      for (const raw of parsed.data.facts.slice(0, spec.maxFacts)) {
        const item = submitItem.safeParse(raw);
        const value = item.success ? asJson(item.data.value) : undefined;
        if (!item.success || value === undefined) {
          malformed.push(item.success ? 'value is not JSON' : `fact: ${item.error.issues[0]?.path.join('.') ?? ''} ${item.error.issues[0]?.message ?? 'invalid'}`.trim());
          continue;
        }
        proposals.push({
          // Task and subject are bound by the request, never taken from the model.
          task: req.task,
          subject: req.subject,
          value,
          sourceUrl: item.data.source_url,
          quote: item.data.quote,
          retrievedAt: times.get(item.data.source_url) ?? opts.now.toISOString(),
          confidenceNote: (item.data.confidence_note ?? '').slice(0, 500),
        });
      }
      const result: AgentRunResult = { proposals, stop: 'submitted', malformed, turns: turn + 1 };
      if (parsed.data.none_found_reason) result.noneFoundReason = parsed.data.none_found_reason.slice(0, 500);
      return result;
    }

    if (res.stop_reason === 'max_tokens') return { proposals: [], stop: 'max_tokens', malformed, turns: turn + 1 };
    if (uses.length === 0) {
      // Ended without submitting: one reminder, then stop.
      if (nudged) return { proposals: [], stop: 'no_submit', malformed, turns: turn + 1 };
      nudged = true;
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Call submit_facts now with what you found (or an empty list with none_found_reason).' }] });
      continue;
    }

    // Client tools: run each, return all results in one user message.
    const results: ToolResult[] = [];
    for (const u of uses) {
      if (toolCalls >= maxToolCalls) {
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'tool call limit for this run reached; call submit_facts' });
        continue;
      }
      toolCalls++;
      const out = await runClientTool(u.name, u.input, toolCtx);
      const block: ToolResult = { type: 'tool_result', tool_use_id: u.id, content: out.isError ? untrusted('tool error', out.content) : out.content };
      if (out.isError) block.is_error = true;
      results.push(block);
    }
    messages.push({ role: 'user', content: results });
  }
  return { proposals: [], stop: 'max_turns', malformed, turns: maxTurns };
}
