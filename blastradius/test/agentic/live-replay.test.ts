/**
 * Offline replay of the live run of 2026-10-12 (test/agentic/live-run.ts): model turns produced by
 * a Claude Code agent acting as the model, live web. The recorded turns drive the real pipeline and
 * the gate re-reads the recorded (trimmed) live responses; every verdict must match the live run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import { ReplayModel, type FactRequest } from '../../src/agentic/index.js';
import { LIVE_FIXTURES, runSet } from './live-run.js';
import { ADVERSARIAL, LIVE } from './live-turns.js';

interface LiveResult {
  id: string;
  attempt?: { kind: string; what: string; correct: 'reject' | 'accept' };
  request: FactRequest;
  proposals: { id: string; value: Record<string, unknown>; status: string; failedCheck: string | null; reasons: string[]; label?: string }[];
}
const RESULTS = JSON.parse(readFileSync(join(LIVE_FIXTURES, 'results.json'), 'utf8')) as { runAt: string; live: LiveResult[]; adversarial: LiveResult[] };
const NOW = new Date(RESULTS.runAt);

async function replay(name: 'live' | 'adversarial') {
  const convs = name === 'live' ? LIVE : ADVERSARIAL;
  const http = new HttpClient({ offline: true, fixturesDir: join(LIVE_FIXTURES, 'pages'), cacheDir: false });
  const model = new ReplayModel(join(LIVE_FIXTURES, `model-${name}.json`));
  return runSet(convs, model, http, NOW, RESULTS[name].map((r) => r.request));
}

const verdicts = (rs: readonly { id: string; proposals: readonly { id: string; status: string; reasons: string[] }[] }[]) => rs.map((r) => ({ id: r.id, proposals: r.proposals.map((p) => ({ id: p.id, status: p.status, reasons: p.reasons })) }));

describe('live run 2026-10-12, replayed offline', () => {
  it('the fixture says where the model turns came from', () => {
    const file = JSON.parse(readFileSync(join(LIVE_FIXTURES, 'model-live.json'), 'utf8')) as { conversations: { note: string }[] };
    expect(file.conversations.length).toBe(LIVE.length);
    for (const c of file.conversations) expect(c.note).toContain('model turns produced by a Claude Code agent acting as the model, live web, 2026-10-12');
  });

  it('every live proposal reaches the same verdict; all 29 real facts are kept', async () => {
    const { results, facts } = await replay('live');
    expect(verdicts(results)).toEqual(verdicts(RESULTS.live));
    const all = results.flatMap((r) => r.proposals);
    expect(all).toHaveLength(29);
    expect(all.filter((p) => p.status === 'unverified')).toEqual([]);
    expect(facts).toHaveLength(29);
    for (const f of facts) expect(f.source).toMatch(/^agent:/);
  });

  it('org jurisdiction stays pending_confirmation (own site, IRS filing via ProPublica, SEC 10-K of a Dutch N.V.)', async () => {
    const { results } = await replay('live');
    const jur = results.filter((r) => r.request.task === 'org_jurisdiction').flatMap((r) => r.proposals);
    expect(jur.map((p) => [(p.value as { country: string }).country, (p.value as { registry: string }).registry, p.status])).toEqual([
      ['US', 'org_legal_page', 'pending_confirmation'],
      ['US', 'foundation_filing', 'pending_confirmation'],
      ['NL', 'sec_edgar', 'pending_confirmation'],
    ]);
    // Never a person-level value or a nationality anywhere in the run.
    expect(JSON.stringify(results)).not.toMatch(/nationalit|ethnic|time_?zone/i);
  });

  it('adversarial attempts are rejected; the known gaps are pinned', async () => {
    const { results } = await replay('adversarial');
    expect(verdicts(results)).toEqual(verdicts(RESULTS.adversarial));
    const by = new Map(results.map((r) => [r.id, r.proposals[0]!]));
    expect(by.get('adv-wrong-amount')).toMatchObject({ status: 'unverified', failedCheck: 'task_rules', reasons: ['amount 398985 is not in the quote'] });
    expect(by.get('adv-wrong-subject-funding')).toMatchObject({ status: 'unverified', failedCheck: 'task_rules', reasons: ['the source does not name the project (express, expressjs)'] });
    expect(by.get('adv-wrong-subject-governance')).toMatchObject({ status: 'unverified', failedCheck: 'task_rules' });
    expect(by.get('adv-wrong-subject-incident')).toMatchObject({ status: 'unverified', failedCheck: 'task_rules', reasons: ['the source does not name the project (express, expressjs)'] });
    expect(by.get('adv-off-domain')).toMatchObject({ status: 'unverified', failedCheck: 'domain' });
    // Known gap: dates are not checked against the source (a year-off date is kept).
    expect(by.get('probe-wrong-date')).toMatchObject({ status: 'verified' });
    // Known limit: a page that renders its text with JavaScript cannot verify (redirect to the lower-case URL followed).
    expect(by.get('probe-js-rendered')).toMatchObject({ status: 'unverified', failedCheck: 'quote_present' });
    expect(results.find((r) => r.id === 'probe-js-rendered')!.proposals[0]!.sourceUrl).toBe('https://nvd.nist.gov/vuln/detail/cve-2024-3094');
  });
});
