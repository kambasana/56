/**
 * The agentic pipeline end to end with the replay model: stubbed model turns
 * (test/fixtures/agentic/model/stubbed.json) drive real tools against recorded registry data and
 * real recorded pages; the gate decides. Covers the run loop (tool calls, pause_turn, refusal, a
 * run that forgets to submit), prompt injection, privacy refusals, budgets, the result cache and
 * request de-duplication.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HttpClient, type Transport } from '../../src/core/http.js';
import { makeFact, type Fact } from '../../src/core/types.js';
import { AGENTIC_FIXTURES, STUBBED } from './paths.js';
import { REQUESTS } from './requests.js';
import { AgenticPipeline, GUARDRAIL_PROMPT, ReplayModel, type ModelParams } from '../../src/agentic/index.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** Offline client over the recorded fixtures; records every URL the tools or the gate asked for. */
function client(): { http: HttpClient; asked: string[] } {
  const asked: string[] = [];
  const transport: Transport = async (req) => {
    asked.push(req.url);
    throw new Error('network is off in tests');
  };
  const http = new HttpClient({ offline: true, fixturesDir: AGENTIC_FIXTURES, cacheDir: false, transport });
  const orig = http.request.bind(http);
  http.request = async (url, opts) => {
    asked.push(url);
    return orig(url, opts);
  };
  return { http, asked };
}


const collected: Fact[] = [
  makeFact('funding', 'pkg:npm/@babel/core', { sources: [{ platform: 'open_collective', handle: 'babel', url: 'https://opencollective.com/babel' }], via: 'package.json#funding' }, { source: 'npm', fetchedAt: NOW }),
];

function pipeline(opts: { model?: ReplayModel; cacheDir?: string | false; budget?: { maxRequests?: number; maxTokens?: number; maxRuns?: number }; personTasks?: boolean } = {}) {
  const model = opts.model ?? new ReplayModel(STUBBED);
  const { http, asked } = client();
  const p = new AgenticPipeline({ model, http, now: NOW, facts: () => collected, cacheDir: opts.cacheDir ?? false, personTasks: opts.personTasks ?? false, ...(opts.budget ? { budget: opts.budget } : {}) });
  return { p, model, asked };
}

function toolResultsOf(req: ModelParams): { id: string; content: string; isError: boolean }[] {
  const out: { id: string; content: string; isError: boolean }[] = [];
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== 'user' || typeof last.content === 'string') return out;
  for (const b of last.content) if (b.type === 'tool_result') out.push({ id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), isError: b.is_error === true });
  return out;
}

describe('agent run → gate', () => {
  it('babel funding: collector tool first, real quotes verified, the fabricated one rejected; retrieved_at from web_fetch', async () => {
    const { p, model } = pipeline();
    const out = await p.request(REQUESTS.babel!);
    expect(out.run?.stop).toBe('submitted');
    expect(model.requests).toHaveLength(2);
    // The first tool call was collected_facts, answered from this scan's facts.
    const r1 = toolResultsOf(model.requests[1]!);
    expect(r1[0]!.content).toContain('<untrusted_data source="blastradius collectors">');
    expect(r1[0]!.content).toContain('opencollective.com/babel');
    const byStatus = { verified: out.proposals.filter((x) => x.status === 'verified'), unverified: out.proposals.filter((x) => x.status === 'unverified') };
    expect(byStatus.verified?.map((x) => (x.value as { organization: string }).organization).sort()).toEqual(['Airbnb', 'Open Source Collective']);
    expect(byStatus.unverified?.map((x) => x.quote)).toEqual(['Babel is funded entirely by Google']);
    expect(byStatus.unverified?.[0]!.checks.find((c) => !c.ok)?.check).toBe('quote_present');
    expect(byStatus.verified?.[0]!.retrievedAt).toBe('2026-10-11T11:58:00Z');
    // Facts: verified only, source agent:<task>, evidence URL and quote kept.
    const facts = p.facts();
    expect(facts).toHaveLength(2);
    for (const f of facts) {
      expect(f.kind).toBe('agent_fact');
      expect(f.source).toBe('agent:funding');
      expect(f.evidence).toEqual(['https://opencollective.com/babel']);
      if (f.kind === 'agent_fact') expect(f.value.quote.length).toBeGreaterThan(10);
    }
  });

  it('every request carries the fixed system prompt with the guardrails, adaptive thinking, explicit effort and caching', async () => {
    const { p, model } = pipeline();
    await p.request(REQUESTS.babel!);
    const sys = model.requests.map((r) => JSON.stringify(r.system));
    expect(new Set(sys).size).toBe(1);
    expect(sys[0]).toContain(GUARDRAIL_PROMPT.split('\n')[1]!.slice(0, 60));
    for (const r of model.requests) {
      expect(r.thinking).toEqual({ type: 'adaptive' });
      expect(r.output_config?.effort).toBe('high');
      expect(r.cache_control).toEqual({ type: 'ephemeral' });
      const names = r.tools!.map((t) => ('name' in t ? t.name : ''));
      expect(names).toContain('web_fetch');
      expect(names[names.length - 1]).toBe('submit_facts');
    }
    // Append-only conversation: each request extends the previous one.
    expect(JSON.stringify(model.requests[1]!.messages).startsWith(JSON.stringify(model.requests[0]!.messages).slice(0, -1))).toBe(true);
  });

  it('moment lifecycle: npm_package reads the recorded registry document; maintenance mode verified on momentjs.com', async () => {
    const { p, model } = pipeline();
    const out = await p.request(REQUESTS.moment!);
    const r1 = toolResultsOf(model.requests[1]!);
    expect(r1[0]!.content).toContain('"homepage":"https://momentjs.com"');
    expect(out.proposals.map((x) => [x.status, (x.value as { event: string }).event])).toEqual([['verified', 'maintenance_mode']]);
  });

  it('webpack: resumes after pause_turn, then verifies', async () => {
    const { p, model } = pipeline();
    const out = await p.request(REQUESTS.webpack!);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages.at(-1)!.role).toBe('assistant');
    expect(out.proposals.every((x) => x.status === 'verified')).toBe(true);
    expect(out.proposals).toHaveLength(2);
  });

  it('a refusal ends the run with no proposals', async () => {
    const { p } = pipeline();
    const out = await p.request(REQUESTS.expressIncident!);
    expect(out.run?.stop).toBe('refusal');
    expect(out.proposals).toEqual([]);
  });

  it('a run that ends without submit_facts gets one reminder, then its answer is taken', async () => {
    const { p, model } = pipeline();
    const out = await p.request(REQUESTS.leftpadLifecycle!);
    expect(model.requests).toHaveLength(2);
    const last = model.requests[1]!.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('Call submit_facts now');
    expect(out.run?.stop).toBe('submitted');
    expect(out.run?.noneFoundReason).toMatch(/deprecation notice/);
  });

  it('org jurisdiction is verified but stored as pending_confirmation (own site and SEC EDGAR)', async () => {
    const { p } = pipeline();
    const a = await p.request(REQUESTS.osc!);
    const b = await p.request(REQUESTS.elastic!);
    expect([...a.proposals, ...b.proposals].map((x) => x.status)).toEqual(['pending_confirmation', 'pending_confirmation']);
    const facts = p.facts();
    expect(facts.every((f) => f.kind === 'agent_fact' && f.value.status === 'pending_confirmation')).toBe(true);
  });
});

describe('prompt injection in fetched content', () => {
  it('injected instructions do not change the task, the tools or what is stored', async () => {
    const { p, model, asked } = pipeline();
    const out = await p.request(REQUESTS.leftpadIncident!);
    // The page with instructions came back wrapped as untrusted data; its fake closing tag is neutralised.
    const r1 = toolResultsOf(model.requests[1]!);
    const page = r1.find((r) => r.content.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))!;
    expect(page.content.startsWith('<untrusted_data source="https://raw.githubusercontent.com/synthetic--org/injection-test/main/README.md">')).toBe(true);
    expect(page.content.match(/<\/untrusted_data>/g)).toHaveLength(1);
    expect(page.content.trimEnd().endsWith('</untrusted_data>')).toBe(true);
    // The injected tool calls were refused by code: an off-list host and a tool this task does not have.
    const r2 = toolResultsOf(model.requests[2]!);
    expect(r2.map((r) => r.isError)).toEqual([true, true]);
    expect(r2[0]!.content).toMatch(/registry_fetch only reads https URLs on .*collector\.invalid is refused/);
    expect(r2[1]!.content).toMatch(/opencollective_account is not available for task incident_writeups/);
    expect(asked.some((u) => u.includes('collector.invalid'))).toBe(false);
    // System prompt and tool list never changed.
    expect(new Set(model.requests.map((r) => JSON.stringify([r.system, r.tools]))).size).toBe(1);
    // Only the real, verified fact is kept; the injected values are refused without being stored.
    expect(out.proposals.map((x) => [x.task, x.status])).toEqual([['incident_writeups', 'verified']]);
    expect(out.privacyRejections).toHaveLength(2);
    const report = JSON.stringify(p.report());
    expect(report).not.toContain('"XX"');
    expect(report).not.toMatch(/"nationality"\s*:/);
    expect(JSON.stringify(p.facts())).not.toContain('XX');
  });
});

describe('person-level data', () => {
  it('is refused before any model call unless person tasks are turned on', async () => {
    const { p, model } = pipeline();
    const out = await p.request(REQUESTS.person!);
    expect(out.refused).toMatch(/person-level tasks are off/);
    expect(model.requests).toHaveLength(0);
  });

  it('when on: only the self-declared text from the own profile is kept, labelled; a country is refused; another page is rejected', async () => {
    const { p } = pipeline({ personTasks: true });
    const out = await p.request(REQUESTS.person!);
    const verified = out.proposals.filter((x) => x.status === 'verified');
    expect(verified.map((x) => x.value)).toEqual([{ location: 'Lisbon, Portugal' }]);
    expect(verified[0]!.label).toBe('self-declared');
    expect(verified[0]!.sourceUrl).toBe('https://github.com/synthetic--profile');
    expect(out.privacyRejections.map((r) => r.reason)).toEqual([expect.stringMatching(/"country" is not allowed; a self-declared location is stored only as the profile's own text/)]);
    const other = out.proposals.find((x) => x.status === 'unverified')!;
    expect(other.reasons).toContain("the quote must come from the person's own profile page (profile_url), not another page");
    const f = p.facts().find((x) => x.kind === 'agent_fact')!;
    expect(f.kind === 'agent_fact' && f.value.label).toBe('self-declared');
  });
});

describe('cost controls', () => {
  it('per-scan request budget stops further runs and is reported', async () => {
    const { p, model } = pipeline({ budget: { maxRequests: 2 } });
    await p.request(REQUESTS.babel!); // uses 2 requests
    const out = await p.request(REQUESTS.moment!);
    expect(out.run?.stop).toBe('budget');
    expect(model.requests).toHaveLength(2);
    const r = p.report();
    expect(r.budgetExhausted).toBe(true);
    expect(r.requests).toBe(2);
    expect(r.inputTokens).toBe(1800 + 4200);
    expect(r.outputTokens).toBe(300 + 520);
  });

  it('token budget is shared across runs', async () => {
    const { p, model } = pipeline({ budget: { maxTokens: 5000 } });
    await p.request(REQUESTS.babel!); // 6,820 tokens: over the budget after the run
    const out = await p.request(REQUESTS.moment!);
    expect(out.run?.stop).toBe('budget');
    expect(model.requests).toHaveLength(2);
  });

  it('per-scan run limit', async () => {
    const { p } = pipeline({ budget: { maxRuns: 1 } });
    await p.request(REQUESTS.express!);
    const out = await p.request(REQUESTS.moment!);
    expect(out.run?.stop).toBe('budget');
  });

  it('results are cached with a TTL and re-verified; a second scan makes no model call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'br-agentic-cache-'));
    tmp.push(dir);
    const first = pipeline({ cacheDir: dir });
    await first.p.request(REQUESTS.express!);
    expect(first.model.requests).toHaveLength(2);
    expect(readdirSync(dir)).toHaveLength(1);
    const second = pipeline({ cacheDir: dir });
    const out = await second.p.request(REQUESTS.express!);
    expect(out.cached).toBe(true);
    expect(second.model.requests).toHaveLength(0);
    expect(out.proposals.map((x) => x.status)).toEqual(['verified']);
    expect(second.p.report().cached).toBe(1);
    // Past the TTL the entry is ignored.
    const { http } = client();
    const later = new AgenticPipeline({ model: new ReplayModel(STUBBED), http, now: new Date(NOW.getTime() + 8 * 24 * 3600 * 1000), cacheDir: dir });
    const again = await later.request(REQUESTS.express!);
    expect(again.cached).toBe(false);
  });

  it('identical requests in flight are de-duplicated into one run', async () => {
    const { p, model } = pipeline();
    const [a, b] = await Promise.all([p.request(REQUESTS.express!), p.request(REQUESTS.express!)]);
    expect(model.requests).toHaveLength(2); // one conversation of two turns
    expect(a.proposals.map((x) => x.id)).toEqual(b.proposals.map((x) => x.id));
    expect(p.report().runs).toBe(1);
  });
});
