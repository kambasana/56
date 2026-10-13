/**
 * Verification gate: the app re-fetches a proposal's source URL and follows redirects by hand, so a
 * page on an allowed domain cannot hand the check to another site. Each hop and the final URL must
 * be on the task's evidence domains; the final URL is the evidence.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpClient, type TransportRequest, type TransportResponse } from '../core/http.js';
import type { AgentJson } from '../core/agentic-types.js';
import { MAX_REDIRECTS, REDIRECT_OFF_DOMAIN, verifyProposal, type ProposedFact } from './verify.js';
import type { FactRequest, TaskSpec } from './tasks.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const PAGE = '<html><body><p>The project is maintained by the Example Foundation since 2019.</p></body></html>';
const QUOTE = 'maintained by the Example Foundation since 2019';

const spec: TaskSpec = {
  id: 'redirect_test',
  version: 1,
  title: 'redirect test',
  subjectKinds: ['package'],
  personLevel: false,
  storage: 'fact',
  instructions: 'test',
  tools: [],
  domains: ['example.org'],
  contextDomains: false,
  schema: z.object({ backer: z.string() }) as unknown as z.ZodType<AgentJson>,
  maxFacts: 1,
};
const req: FactRequest = { task: spec.id, subject: 'pkg:npm/demo', subjectKind: 'package', question: 'q' };
const proposal = (sourceUrl: string): ProposedFact => ({ task: spec.id, subject: req.subject, value: { backer: 'Example Foundation' }, sourceUrl, quote: QUOTE, retrievedAt: NOW.toISOString(), confidenceNote: '' });

type Pages = Record<string, { body: string } | { redirect: string; status?: number }>;

/** A web of pages: URL → page body, or a redirect. Records every URL requested and how. */
function site(pages: Pages) {
  const seen: TransportRequest[] = [];
  const transport = async (r: TransportRequest): Promise<TransportResponse> => {
    seen.push(r);
    const p = pages[r.url];
    if (!p) return { status: 404, body: '' };
    if ('redirect' in p) return { status: p.status ?? 301, body: '', location: p.redirect };
    return { status: 200, body: p.body };
  };
  return { http: new HttpClient({ transport, cacheDir: false, offline: false, minIntervalMs: 0, maxRetries: 0 }), seen };
}

describe('verification gate: redirects of the re-fetched source', () => {
  it('an on-domain redirect is accepted and the final URL is the evidence', async () => {
    const { http, seen } = site({
      'https://example.org/about': { redirect: '/about/' },
      'https://example.org/about/': { redirect: 'https://www.example.org/governance', status: 302 },
      'https://www.example.org/governance': { body: PAGE },
    });
    const r = await verifyProposal(proposal('https://example.org/about'), req, spec, { http, now: NOW });
    expect(r.kind).toBe('proposal');
    if (r.kind !== 'proposal') return;
    expect(r.proposal.status).toBe('verified');
    expect(r.proposal.reasons).toEqual([]);
    expect(r.proposal.sourceUrl).toBe('https://www.example.org/governance');
    // Redirects were never followed by the transport itself.
    expect(seen.map((s) => [s.url, s.redirect])).toEqual([
      ['https://example.org/about', 'manual'],
      ['https://example.org/about/', 'manual'],
      ['https://www.example.org/governance', 'manual'],
    ]);
  });

  it('an off-domain redirect is rejected, at any hop', async () => {
    const cases: Pages[] = [
      { 'https://example.org/about': { redirect: 'https://attacker.example.net/about' }, 'https://attacker.example.net/about': { body: PAGE } },
      {
        'https://example.org/about': { redirect: 'https://www.example.org/x' },
        'https://www.example.org/x': { redirect: 'https://example.org.attacker.net/y' },
        'https://example.org.attacker.net/y': { body: PAGE },
      },
      { 'https://example.org/about': { redirect: 'http://example.org/plain' }, 'http://example.org/plain': { body: PAGE } },
    ];
    for (const pages of cases) {
      const { http, seen } = site(pages);
      const r = await verifyProposal(proposal('https://example.org/about'), req, spec, { http, now: NOW });
      expect(r.kind === 'proposal' && r.proposal.status).toBe('unverified');
      expect(r.kind === 'proposal' && r.proposal.reasons).toEqual([REDIRECT_OFF_DOMAIN]);
      // The proposal keeps its own URL; the off-domain page is never read.
      expect(r.kind === 'proposal' && r.proposal.sourceUrl).toBe('https://example.org/about');
      expect(seen.some((s) => !/^https:\/\/(www\.)?example\.org\//.test(s.url))).toBe(false);
    }
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    const pages: Record<string, { redirect: string }> = {};
    for (let i = 0; i <= MAX_REDIRECTS + 1; i++) pages[`https://example.org/${i}`] = { redirect: `https://example.org/${i + 1}` };
    const { http } = site(pages);
    const r = await verifyProposal(proposal('https://example.org/0'), req, spec, { http, now: NOW });
    expect(r.kind === 'proposal' && r.proposal.reasons[0]).toMatch(/more than 5 times/);
  });
});
