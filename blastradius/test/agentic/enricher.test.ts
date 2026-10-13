/**
 * The agentic enricher: runs after the deterministic collectors and asks only for what is still
 * missing; replayed with the stubbed model over recorded data.
 */
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import { makeFact, type Component, type Fact, type Inventory } from '../../src/core/types.js';
import type { AgenticReport } from '../../src/core/agentic-types.js';
import { ReplayModel } from '../../src/agentic/index.js';
import { createAgenticEnricher, planAgenticRequests } from '../../src/enrich/agentic/index.js';
import { AGENTIC_FIXTURES, STUBBED } from './paths.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const meta = { source: 'npm', fetchedAt: NOW };

function inventory(pkgs: [string, string, boolean][]): Inventory {
  const components: Component[] = pkgs.map(([name, version]) => ({ purl: `pkg:npm/${name.replace('@', '%40')}@${version}`, ecosystem: 'npm', name, version }));
  return {
    assets: [{ id: 'a', kind: 'npm-lockfile', path: 'package-lock.json' }],
    components,
    edges: pkgs.map(([name, version, direct], i) => ({ from: 'a', to: components[i]!.purl, scope: 'prod', direct })),
  } as unknown as Inventory;
}

describe('planAgenticRequests: only what the collectors left missing', () => {
  const inv = inventory([
    ['webpack', '5.0.0', true],
    ['@babel/core', '7.0.0', true],
    ['left-pad', '1.3.0', false],
    ['express', '4.21.2', true],
    ['event-stream', '3.3.6', false],
  ]);
  const facts: Fact[] = [
    makeFact('funding', 'pkg:npm/%40babel/core', { sources: [{ platform: 'open_collective', handle: 'babel' }], via: 'package.json#funding' }, meta),
    makeFact('repo_owner', 'pkg:npm/%40babel/core', { repo: 'github.com/babel/babel', owner: 'babel', ownerType: 'Organization', url: 'https://github.com/babel' }, { source: 'github', fetchedAt: NOW }),
    makeFact('release_age', 'pkg:npm/left-pad@1.3.0', { version: '1.3.0', publishedAt: '2018-04-09T01:11:05.473Z', ageDays: 3107, deprecated: 'use String.prototype.padStart()' }, meta),
    makeFact('funding', 'pkg:npm/express', { sources: [{ platform: 'open_collective', handle: 'express' }], via: 'package.json#funding' }, meta),
    makeFact('repo_owner', 'pkg:npm/express', { repo: 'github.com/expressjs/express', owner: 'expressjs', ownerType: 'Organization', url: 'https://github.com/expressjs' }, { source: 'github', fetchedAt: NOW }),
    makeFact('malware', 'pkg:npm/event-stream@3.3.6', { id: 'GHSA-mh6f-8j2x-4483', origin: 'osv' }, { source: 'osv', fetchedAt: NOW }),
  ];

  it('plans the expected requests in a stable order', () => {
    const plan = planAgenticRequests(inv, facts);
    expect(plan.map((r) => `${r.task} ${r.subject}`)).toEqual([
      // babel: funding known, owner known → nothing
      // express: funding and owner known → only its org's jurisdiction (below)
      'funding pkg:npm/webpack',
      'governance pkg:npm/webpack',
      'incident_writeups pkg:npm/event-stream',
      'lifecycle_events pkg:npm/left-pad',
      'org_jurisdiction org:github/babel',
      'org_jurisdiction org:github/expressjs',
    ]);
  });

  it('a verified agent fact from an earlier run counts as known', () => {
    const known = [...facts, makeFact('agent_fact', 'pkg:npm/webpack', { task: 'funding', value: { kind: 'fiscal_host', organization: 'Open Source Collective' }, quote: 'q', sourceUrl: 'https://opencollective.com/webpack', retrievedAt: 'x', verifiedAt: 'x', confidenceNote: '', status: 'verified', proposalId: 'p' }, { source: 'agent:funding', fetchedAt: NOW })];
    expect(planAgenticRequests(inv, known).some((r) => r.task === 'funding')).toBe(false);
  });

  it('never plans a person-level request', () => {
    expect(planAgenticRequests(inv, facts).every((r) => r.subjectKind !== 'person' && r.task !== 'person_self_declared_location')).toBe(true);
  });
});

describe('agentic enricher (replayed)', () => {
  it('runs last, adds verified agent facts and reports usage', async () => {
    const inv = inventory([
      ['webpack', '5.0.0', true],
      ['left-pad', '1.3.0', false],
    ]);
    const facts: Fact[] = [
      makeFact('release_age', 'pkg:npm/left-pad@1.3.0', { version: '1.3.0', publishedAt: '2018-04-09T01:11:05.473Z', ageDays: 3107, deprecated: 'use String.prototype.padStart()' }, meta),
      makeFact('repo_owner', 'pkg:npm/webpack', { repo: 'github.com/webpack/webpack', owner: 'webpack', ownerType: 'User', url: 'https://github.com/webpack' }, { source: 'github', fetchedAt: NOW }),
    ];
    let report: AgenticReport | undefined;
    const warnings: string[] = [];
    const e = createAgenticEnricher({ facts: () => facts, model: new ReplayModel(STUBBED), cacheDir: false, tasks: ['funding', 'lifecycle_events'], onReport: (r) => (report = r) });
    expect(e.usesEarlierFacts).toBe(true);
    const http = new HttpClient({ offline: true, fixturesDir: AGENTIC_FIXTURES, cacheDir: false });
    const out = await e.enrich(inv, { http, now: NOW, offline: true, warn: (m) => warnings.push(m) });
    expect(out.map((f) => [f.kind, f.subject, f.source])).toEqual([
      ['agent_fact', 'pkg:npm/webpack', 'agent:funding'],
      ['agent_fact', 'pkg:npm/webpack', 'agent:funding'],
    ]);
    expect(report?.runs).toBe(2);
    expect(report?.requests).toBe(4);
    expect(report?.proposals.filter((p) => p.status === 'verified')).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('without a model it stays off: offline → one warning; online without a key → one warning', async () => {
    const e = createAgenticEnricher({ facts: () => [] });
    const warnings: string[] = [];
    const http = new HttpClient({ offline: true, cacheDir: false });
    expect(await e.enrich(inventory([['webpack', '5.0.0', true]]), { http, now: NOW, offline: true, warn: (m) => warnings.push(m) })).toEqual([]);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await e.enrich(inventory([['webpack', '5.0.0', true]]), { http, now: NOW, offline: false, warn: (m) => warnings.push(m) })).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
    expect(warnings).toEqual(['agentic: offline scan without a recorded model; skipped', 'agentic: --agentic needs ANTHROPIC_API_KEY in the environment; skipped']);
  });
});
