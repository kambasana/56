/**
 * Model access for the agentic gap-filler, behind a one-method interface so tests replay recorded
 * or stubbed responses and never need a key.
 *
 * - `createAnthropicModel()`: the Anthropic SDK. The API key is read from ANTHROPIC_API_KEY only
 *   (environment, never a flag or a file) and never logged: errors are reduced to the SDK's error
 *   class and HTTP status.
 * - `ReplayModel`: answers from a fixture file of conversations (test/fixtures/agentic/model/*.json),
 *   matched by the request line the agent puts in its first message.
 * - `RecordingModel`: wraps a real model and keeps each conversation's responses, so a live run
 *   can be saved as a replay fixture.
 *
 * Model choice: $BLASTRADIUS_AGENT_MODEL, default claude-opus-5-5 (the most capable current
 * model); effort $BLASTRADIUS_AGENT_EFFORT (default "high").
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';

export type ModelParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelMessage = Anthropic.Beta.Messages.BetaMessage;

export interface ModelClient {
  readonly model: string;
  create(params: ModelParams): Promise<ModelMessage>;
}

export const DEFAULT_AGENT_MODEL = 'claude-opus-5-5';
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export function agentModelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const m = env.BLASTRADIUS_AGENT_MODEL?.trim();
  return m && /^[a-z0-9][a-z0-9.\-]{1,80}$/i.test(m) ? m : DEFAULT_AGENT_MODEL;
}

export function agentEffortFromEnv(env: NodeJS.ProcessEnv = process.env): AgentEffort {
  const e = env.BLASTRADIUS_AGENT_EFFORT?.trim().toLowerCase();
  return (AGENT_EFFORTS as readonly string[]).includes(e ?? '') ? (e as AgentEffort) : 'high';
}

/** True when a key is present in the environment (the value itself is never returned). */
export function hasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim().length > 0;
}

/** A model error that is safe to log: SDK error class and status, never headers or the key. */
export class AgentModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AgentModelError';
  }
}

function safeError(e: unknown): AgentModelError {
  if (e instanceof Anthropic.RateLimitError) return new AgentModelError('model API rate limit (429)', 429, true);
  if (e instanceof Anthropic.AuthenticationError) return new AgentModelError('model API rejected the credentials (401)', 401);
  if (e instanceof Anthropic.PermissionDeniedError) return new AgentModelError('model API permission denied (403)', 403);
  if (e instanceof Anthropic.BadRequestError) return new AgentModelError(`model API bad request (400): ${redact(e.message).slice(0, 300)}`, 400);
  if (e instanceof Anthropic.APIConnectionError) return new AgentModelError('model API connection failed', undefined, true);
  if (e instanceof Anthropic.APIError) return new AgentModelError(`model API error (${e.status ?? 'unknown'})`, e.status ?? undefined, (e.status ?? 0) >= 500);
  return new AgentModelError(`model call failed: ${redact(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
}

/** Remove anything that looks like an API key from a message. */
export function redact(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]').replace(/(x-api-key|authorization)\s*[:=]\s*\S+/gi, '$1: [redacted]');
}

/** Beta headers sent with every request: server-side refusal fallback ("default" routing). */
export const AGENT_BETAS: readonly string[] = ['server-side-fallback-2026-07-01'];

/**
 * The real model. Reads ANTHROPIC_API_KEY from the environment only. Requests go through the beta
 * Messages endpoint for the server-side refusal fallback (`fallbacks: "default"`).
 */
export function createAnthropicModel(opts: { env?: NodeJS.ProcessEnv; model?: string } = {}): ModelClient {
  const env = opts.env ?? process.env;
  if (!hasApiKey(env)) throw new AgentModelError('ANTHROPIC_API_KEY is not set; the agentic gap-filler stays off');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY!.trim(), maxRetries: 2 });
  const model = opts.model ?? agentModelFromEnv(env);
  return {
    model,
    async create(params) {
      try {
        return await client.beta.messages.create({ ...params, model, betas: [...AGENT_BETAS], fallbacks: 'default' });
      } catch (e) {
        throw safeError(e);
      }
    },
  };
}

/** One recorded conversation: the responses the model gave, in order. */
export interface ReplayConversation {
  /** "<task> <subject>", as in the agent's request line. */
  key: string;
  /** Free text: where the responses came from (recorded live, or hand-written stub). */
  note?: string;
  responses: unknown[];
}

export interface ReplayFile {
  model: string;
  conversations: ReplayConversation[];
}

/** The request line the agent writes into its first message (ReplayModel matches on it). */
export function requestLine(task: string, subject: string): string {
  return `request: ${task} ${subject}`;
}

function keyOf(params: ModelParams): string | undefined {
  const first = params.messages[0];
  if (!first) return undefined;
  const text = typeof first.content === 'string' ? first.content : first.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const m = /^request: (\S+) (\S+)$/m.exec(text);
  return m ? `${m[1]} ${m[2]}` : undefined;
}

/** Number of assistant turns already in the conversation = index of the next response. */
function turnIndex(params: ModelParams): number {
  return params.messages.filter((m) => m.role === 'assistant').length;
}

export class ReplayModel implements ModelClient {
  readonly model: string;
  /** Every request made, in order (tests inspect prompts, tools and tool results). */
  readonly requests: ModelParams[] = [];
  private readonly byKey = new Map<string, ReplayConversation>();

  constructor(file: ReplayFile | string) {
    const data: ReplayFile = typeof file === 'string' ? (JSON.parse(readFileSync(file, 'utf8')) as ReplayFile) : file;
    this.model = data.model;
    for (const c of data.conversations) this.byKey.set(c.key, c);
  }

  async create(params: ModelParams): Promise<ModelMessage> {
    this.requests.push(structuredClone(params));
    const key = keyOf(params);
    const conv = key ? this.byKey.get(key) : undefined;
    if (!conv) throw new AgentModelError(`replay: no recorded conversation for "${key ?? '?'}"`);
    const i = turnIndex(params);
    const r = conv.responses[i];
    if (!r) throw new AgentModelError(`replay: conversation "${key}" has no response #${i + 1}`);
    return structuredClone(r) as ModelMessage;
  }
}

/** Wraps a model and keeps every response by conversation key (for saving a live run as a fixture). */
export class RecordingModel implements ModelClient {
  readonly conversations = new Map<string, unknown[]>();
  constructor(private readonly inner: ModelClient) {}
  get model(): string {
    return this.inner.model;
  }
  async create(params: ModelParams): Promise<ModelMessage> {
    const res = await this.inner.create(params);
    const key = keyOf(params) ?? '?';
    const list = this.conversations.get(key) ?? [];
    list[turnIndex(params)] = res;
    this.conversations.set(key, list);
    return res;
  }
  toReplayFile(note: string): ReplayFile {
    return { model: this.model, conversations: [...this.conversations].map(([key, responses]) => ({ key, note, responses })) };
  }
}
