/**
 * Live end-to-end run of the agentic gap-filler (needs network; never run in tests or CI):
 *   NODE_USE_ENV_PROXY=1 npx tsx test/agentic/live-run.ts
 *
 * The model turns are the ones in test/agentic/live-turns.ts: produced by a Claude Code agent acting
 * as the model on live web pages (no Anthropic API key). They go through the REAL pipeline:
 * AgenticPipeline → privacy screen → agent loop (client tools run for real) → verification gate with
 * a live re-fetch of every source → facts. A RecordingModel saves the turns as replay fixtures; every
 * HTTP response the tools and the gate read is saved (trimmed) so live-replay.test.ts replays the
 * run offline and must reach the same verdicts.
 *
 * Output: test/fixtures/agentic-live/{model-live.json, model-adversarial.json, results.json, pages/}.
 *
 * Re-record only some pages of the run (live, the rest of the fixtures untouched):
 *   NODE_USE_ENV_PROXY=1 npx tsx test/agentic/live-run.ts --pages <url> [<url> …]
 * The page is trimmed with the same evidence terms (from results.json) and the same rules.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient } from '../../src/core/http.js';
import { installEnvProxy } from '../../src/core/proxy.js';
import { addHomepages } from '../../src/enrich/agentic/index.js';
import { AgenticPipeline, RecordingModel, ReplayModel, foldText, htmlDateMetadata, looksLikeHtml, pageText, type FactRequest, type ReplayFile } from '../../src/agentic/index.js';
import { ADVERSARIAL, LIVE, type ScriptedConversation } from './live-turns.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIVE_FIXTURES = join(HERE, '..', 'fixtures', 'agentic-live');
export const LIVE_NOTE = 'model turns produced by a Claude Code agent acting as the model, live web, 2026-10-12 (no Anthropic API key; the agent fetched the sources itself on the task evidence domains and wrote the submit_facts calls; usage counters are 0 because no model API was called)';

/** Scripted conversations → replay file (assistant turns in Messages API shape). */
export function toReplayFile(convs: readonly ScriptedConversation[]): ReplayFile {
  let n = 0;
  const id = (p: string) => `${p}_live_${String(++n).padStart(3, '0')}`;
  return {
    model: 'claude-opus-5-5',
    conversations: convs.map((c) => ({
      key: `${c.request.task} ${c.request.subject}`,
      note: `${LIVE_NOTE}. ${c.attempt ? `${c.attempt.kind}: ${c.attempt.what}` : `run ${c.id}`}`,
      responses: c.turns.map((t) => {
        const content: unknown[] = [{ type: 'text', text: t.text }];
        for (const f of t.fetches ?? []) {
          const tid = id('srvtoolu');
          content.push({ type: 'server_tool_use', id: tid, name: 'web_fetch', input: { url: f.url } });
          content.push({
            type: 'web_fetch_tool_result',
            tool_use_id: tid,
            content: { type: 'web_fetch_result', url: f.url, retrieved_at: f.retrievedAt, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: f.excerpt }, title: null, citations: null } },
          });
        }
        for (const u of t.tools ?? []) content.push({ type: 'tool_use', id: id('toolu'), name: u.name, input: u.input });
        if (t.submit) content.push({ type: 'tool_use', id: id('toolu'), name: 'submit_facts', input: t.submit });
        return { id: id('msg'), type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
      }),
    })),
  };
}

interface Seen {
  url: string;
  status: number;
  body: string;
  location?: string;
}

/** Run a set of conversations through the pipeline; returns per-request results. */
export async function runSet(convs: readonly ScriptedConversation[], model: RecordingModel | ReplayModel, http: HttpClient, now: Date, requests: FactRequest[]) {
  const p = new AgenticPipeline({ model, http, now, cacheDir: false, personTasks: false, budget: { maxRuns: 50, maxRequests: 200 } });
  const out = [];
  for (const [i, c] of convs.entries()) {
    const t0 = Date.now();
    const r = await p.request(requests[i]!);
    const ms = Date.now() - t0;
    out.push({
      id: c.id,
      ...(c.attempt ? { attempt: c.attempt } : {}),
      request: requests[i]!,
      latencyMs: ms,
      run: r.run ?? null,
      refused: r.refused ?? null,
      privacyRejections: r.privacyRejections,
      proposals: r.proposals.map((x) => ({
        id: x.id,
        value: x.value,
        sourceUrl: x.sourceUrl,
        quote: x.quote,
        retrievedAt: x.retrievedAt,
        status: x.status,
        failedCheck: x.checks.find((k) => !k.ok)?.check ?? null,
        reasons: x.reasons,
        ...(x.label ? { label: x.label } : {}),
        ...(x.unverifiedFields ? { unverifiedFields: x.unverifiedFields } : {}),
      })),
    });
  }
  return { results: out, facts: p.facts() };
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

/**
 * Trim a fetched body for the offline fixture. JSON and small text are kept (emails removed). Pages
 * are stored as the gate's own normalised text (pageText: visible text, folded, lower-cased), cut to
 * windows around the quotes and terms the rules read; Open Collective "Individuals" lists and mail
 * headers are removed (organisation funders only).
 */
export function trimForFixture(url: string, body: string, terms: readonly string[]): string {
  if (new URL(url).hostname === 'registry.npmjs.org') {
    // Registry documents: people fields removed (the npm_package tool only counts maintainers).
    try {
      const doc = JSON.parse(body) as Record<string, unknown>;
      for (const k of ['author', 'contributors', '_npmUser', 'gitHead']) delete doc[k];
      if (Array.isArray(doc.maintainers)) doc.maintainers = doc.maintainers.map(() => ({ name: '[removed]' }));
      return JSON.stringify(doc).replace(EMAIL_RE, '[email removed]');
    } catch {
      // not JSON: fall through
    }
  }
  if (!looksLikeHtml(body) && body.length <= 40_000) return body.replace(EMAIL_RE, '[email removed]');
  const text = trimText(url, body, terms);
  // Publication-date metadata the gate reads (meta tags, JSON-LD datePublished, <time>, byline),
  // kept as a minimal HTML head so the date check replays exactly; the text stays the gate's text.
  const meta = looksLikeHtml(body) ? htmlDateMetadata(body).map((m) => m.html) : [];
  if (meta.length === 0) return text;
  return `<!doctype html><html><head>${meta.join('')}</head><body>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</body></html>`;
}

function trimText(url: string, body: string, terms: readonly string[]): string {
  let text = pageText(body);
  if (/(^|\.)opencollective\.com$/.test(new URL(url).hostname)) text = text.replace(/ individuals 1 .*?(?= top financial contributors| $)/g, ' ').replace(/ individuals 1 .*$/, '');
  text = text.replace(/from: [^<]{0,80}<[^>]*>/g, 'from: [removed]').replace(EMAIL_RE, '[email removed]');
  const keep: [number, number][] = [[0, Math.min(text.length, 300)]];
  for (const term of terms) {
    const f = foldText(term);
    if (!f) continue;
    let at = text.indexOf(f);
    if (at < 0) at = text.indexOf(f.slice(0, 40));
    if (at < 0) continue;
    keep.push([Math.max(0, at - 600), Math.min(text.length, at + f.length + 600)]);
  }
  keep.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const k of keep) {
    const last = merged[merged.length - 1];
    if (last && k[0] <= last[1]) last[1] = Math.max(last[1], k[1]);
    else merged.push([...k]);
  }
  return merged.map(([a, b]) => text.slice(a, b)).join(' [...] ');
}

type RunResult = Awaited<ReturnType<typeof runSet>>['results'][number];

/** Evidence terms per source URL: the quotes, list values and the subject name the rules read. */
function addTerms(terms: Map<string, Set<string>>, results: readonly Pick<RunResult, 'request' | 'proposals'>[]): void {
  for (const r of results) {
    for (const p of r.proposals) {
      const t = terms.get(p.sourceUrl) ?? new Set<string>();
      t.add(p.quote);
      for (const v of Object.values(p.value as Record<string, unknown>)) if (Array.isArray(v)) v.forEach((x) => typeof x === 'string' && t.add(x));
      const name = r.request.context?.name;
      if (name) t.add(name);
      terms.set(p.sourceUrl, t);
    }
  }
}

/** Re-record some pages of the run live (same trimming, same evidence terms); other fixtures stay. */
async function rerecordPages(urls: readonly string[]): Promise<void> {
  await installEnvProxy();
  const report = JSON.parse(readFileSync(join(LIVE_FIXTURES, 'results.json'), 'utf8')) as { live: RunResult[]; adversarial: RunResult[] };
  const terms = new Map<string, Set<string>>();
  addTerms(terms, [...report.live, ...report.adversarial]);
  const http = new HttpClient({ cacheDir: false });
  const now = new Date();
  for (const url of urls) {
    const file = join(LIVE_FIXTURES, 'pages', fixtureName(url));
    if (!existsSync(file)) throw new Error(`${url} is not a page of the recorded run`);
    const res = await http.request(url, { headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8' }, ttlMs: 0, redirect: 'manual' });
    if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
    const old = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const env = {
      request: { url },
      status: res.status,
      response: trimForFixture(url, res.body, [...(terms.get(url) ?? [])]),
      _note: "Live page re-recorded by live-run.ts --pages: the gate's own normalised text (pageText) cut to windows around the quotes, with the page's publication-date metadata (meta tags, JSON-LD datePublished, <time>, byline) kept as a minimal HTML head; personal data removed.",
      _recordedAt: old._recordedAt,
      _rerecordedAt: now.toISOString(),
    };
    writeFileSync(file, `${JSON.stringify(env, null, 1)}\n`);
    console.log(`${url}: ${res.body.length} → ${env.response.length} bytes`);
  }
}

function fixtureName(url: string): string {
  const u = new URL(url);
  const slug = `${u.hostname}${u.pathname}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
  return `${slug}-${createHash('sha256').update(url).digest('hex').slice(0, 8)}.json`;
}

async function main(): Promise<void> {
  await installEnvProxy();
  const now = new Date();
  const seen = new Map<string, Seen>();
  const http = new HttpClient({ cacheDir: false });
  const orig = http.request.bind(http);
  http.request = async (url, opts) => {
    const res = await orig(url, opts);
    seen.set(url, { url, status: res.status, body: res.body, ...(res.location ? { location: res.location } : {}) });
    return res;
  };

  const sets = [
    { name: 'live', convs: LIVE },
    { name: 'adversarial', convs: ADVERSARIAL },
  ] as const;
  const report: Record<string, unknown> = { note: LIVE_NOTE, runAt: now.toISOString() };
  const terms = new Map<string, Set<string>>();
  for (const set of sets) {
    const requests = set.convs.map((c) => structuredClone(c.request));
    // npm homepages exactly as the enricher adds them (live registry).
    await addHomepages(requests.filter((_r, i) => set.convs[i]!.npmHomepage), http, () => undefined);
    const recording = new RecordingModel(new ReplayModel(toReplayFile(set.convs)));
    const { results, facts } = await runSet(set.convs, recording, http, now, requests);
    const file: ReplayFile = recording.toReplayFile(LIVE_NOTE);
    // Keep the per-conversation notes of the scripted file.
    const notes = new Map(toReplayFile(set.convs).conversations.map((c) => [c.key, c.note]));
    for (const c of file.conversations) c.note = notes.get(c.key) ?? LIVE_NOTE;
    mkdirSync(LIVE_FIXTURES, { recursive: true });
    writeFileSync(join(LIVE_FIXTURES, `model-${set.name}.json`), `${JSON.stringify(file, null, 1)}\n`);
    report[set.name] = results;
    report[`${set.name}Facts`] = facts.length;
    addTerms(terms, results);
    for (const r of results) {
      for (const p of r.proposals) {
        const status = p.status === 'unverified' ? `REJECTED (${p.failedCheck}: ${p.reasons.join('; ')})` : p.status.toUpperCase();
        console.log(`[${set.name}] ${r.id} ${r.latencyMs}ms ${p.sourceUrl} → ${status}`);
      }
      if (r.proposals.length === 0) console.log(`[${set.name}] ${r.id} ${r.latencyMs}ms no proposals (${JSON.stringify(r.run)} ${r.refused ?? ''})`);
    }
  }

  // Page fixtures (also redirects and errors), trimmed.
  const pagesDir = join(LIVE_FIXTURES, 'pages');
  rmSync(pagesDir, { recursive: true, force: true });
  mkdirSync(pagesDir, { recursive: true });
  for (const s of seen.values()) {
    // Evidence terms are keyed by the final URL after redirects; the stated URL's 3xx carries no body.
    const body = s.status >= 200 && s.status < 300 ? trimForFixture(s.url, s.body, [...(terms.get(s.url) ?? [])]) : '';
    const env = {
      request: { url: s.url },
      status: s.status,
      response: body,
      ...(s.location ? { location: s.location } : {}),
      _note: s.status >= 200 && s.status < 300 && looksLikeHtml(s.body) ? 'Live page as the gate read it on the run date, stored as the gate\'s own normalised text (pageText) cut to windows around the quotes; Open Collective individual backers, mail headers and email addresses removed.' : 'Live response on the run date (emails removed).',
      _recordedAt: now.toISOString(),
    };
    writeFileSync(join(pagesDir, fixtureName(s.url)), `${JSON.stringify(env, null, 1)}\n`);
  }
  writeFileSync(join(LIVE_FIXTURES, 'results.json'), `${JSON.stringify(report, null, 1)}\n`);

  // Offline replay must reach the same verdicts.
  let mismatches = 0;
  const used = new Set<string>();
  for (const set of sets) {
    const results = report[set.name] as Awaited<ReturnType<typeof runSet>>['results'];
    const offline = new HttpClient({ offline: true, fixturesDir: pagesDir, cacheDir: false });
    const replayOrig = offline.request.bind(offline);
    offline.request = async (url, opts) => {
      used.add(url);
      return replayOrig(url, opts);
    };
    const replay = await runSet(set.convs, new ReplayModel(join(LIVE_FIXTURES, `model-${set.name}.json`)), offline, now, results.map((r) => r.request));
    for (const [i, r] of replay.results.entries()) {
      const a = results[i]!.proposals.map((p) => `${p.id}:${p.status}:${p.reasons.join('|')}`).join(',');
      const b = r.proposals.map((p) => `${p.id}:${p.status}:${p.reasons.join('|')}`).join(',');
      if (a !== b) {
        mismatches++;
        console.error(`REPLAY MISMATCH ${r.id}\n live:   ${a}\n replay: ${b}`);
      }
    }
  }
  // Keep only the responses the replay reads (the enricher's homepage lookups are not replayed).
  for (const s of seen.values()) if (!used.has(s.url)) rmSync(join(pagesDir, fixtureName(s.url)));
  console.log(mismatches ? `${mismatches} replay mismatches` : 'offline replay reproduces every verdict');
  if (mismatches) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf('--pages');
  (at >= 0 ? rerecordPages(process.argv.slice(at + 1)) : main()).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
