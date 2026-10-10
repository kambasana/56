import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeFact, npmPurl, type EntityLink, type Fact, type Incident } from '../core/types.js';
import {
  applyReviewState,
  buildEntityGraph,
  editDistance,
  entityPathsToIncidents,
  isLinkUsable,
  linkKey,
  loadReviewState,
  parseReviewState,
  resolveEntities,
  reviewQueue,
} from './index.js';

const at = '2026-01-01T00:00:00.000Z';
const meta = { source: 'npm', fetchedAt: at };
const FOO = npmPurl('foo');
const BAR = npmPurl('@scope/bar');

function syntheticFacts(): Fact[] {
  return [
    makeFact('maintainers', FOO, { maintainers: [{ name: 'Alice', email: 'alice@acme.dev' }, { name: 'bob', email: 'bob@gmail.com' }], count: 2 }, meta),
    makeFact('publisher', npmPurl('foo', '1.2.3'), { name: 'alice', version: '1.2.3' }, meta),
    makeFact('maintainers', BAR, { maintainers: [{ name: 'carol', email: 'carol@acme.dev' }], count: 1 }, meta),
    makeFact('repo', FOO, { url: 'https://github.com/acme/foo', host: 'github', owner: 'acme', name: 'foo', via: 'npm.repository' }, meta),
    makeFact('repo_owner', FOO, { repo: 'github.com/acme/foo', owner: 'acme', ownerType: 'Organization', url: 'https://github.com/acme' }, { source: 'github', fetchedAt: at }),
    makeFact('repo', BAR, { url: 'https://github.com/carol/bar', host: 'github', owner: 'carol', name: 'bar', via: 'npm.repository' }, meta),
    makeFact('funding', FOO, {
      sources: [
        { platform: 'open_collective', handle: 'acme-collective', url: 'https://opencollective.com/acme-collective' },
        { platform: 'github', handle: 'alice' },
        { platform: 'custom', url: 'https://acme.dev/donate' },
      ],
      via: 'FUNDING.yml',
    }, { source: 'github', fetchedAt: at }),
    // Junk / hostile values are ignored.
    makeFact('maintainers', npmPurl('baz'), { maintainers: [{ name: 'x; rm -rf /' }], count: 1 }, meta),
  ];
}

const incidentFor = (ref: string, id = 'INC-2023-0001', confidence = 0.9): Incident => ({
  id, title: 'example incident', type: 'crypto_rugpull', status: 'confirmed', date: '2023-01-01', severity: 'high',
  affected: [{ purl: 'pkg:npm/other', versions: ['*'] }],
  entities: [{ ref, role: 'maintainer', confidence }],
  evidence: ['https://example.org/inc'],
});

function find(links: EntityLink[], from: string, relation: string, to: string): EntityLink | undefined {
  return links.find((l) => l.from === from && l.relation === relation && l.to === to);
}

describe('resolveEntities', () => {
  const { entities, links } = resolveEntities(syntheticFacts(), { incidents: [incidentFor('person:example-person')] });

  it('creates deterministic registry links', () => {
    expect(find(links, 'account:npm/alice', 'maintains', FOO)).toMatchObject({ confidence: 1, method: 'deterministic', reviewed: true });
    expect(find(links, 'account:npm/alice', 'publishes', FOO)?.evidence).toContain('https://www.npmjs.com/package/foo');
    expect(find(links, 'account:npm/carol', 'maintains', BAR)?.evidence).toEqual(['https://www.npmjs.com/package/@scope/bar']);
    expect(entities.find((e) => e.id === 'account:npm/alice')).toEqual({ id: 'account:npm/alice', type: 'account', name: 'alice' });
    expect(entities.some((e) => e.id.includes('rm -rf'))).toBe(false);
  });

  it('links repository owners (typed by repo_owner, else org)', () => {
    expect(find(links, 'org:github/acme', 'owns', FOO)).toMatchObject({ confidence: 0.9, method: 'deterministic', reviewed: true });
    expect(find(links, 'org:github/carol', 'owns', BAR)?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('links funding sources', () => {
    const f = find(links, 'funder:opencollective/acme-collective', 'funds', 'org:github/acme');
    expect(f).toMatchObject({ confidence: 0.9, method: 'deterministic', reviewed: true });
    expect(f?.evidence).toContain('https://opencollective.com/acme-collective');
    expect(find(links, 'account:github/alice', 'linked_to', FOO)?.evidence[0]).toBe('https://github.com/sponsors/alice');
    expect(entities.find((e) => e.id === 'funder:opencollective/acme-collective')?.type).toBe('funder');
  });

  it('adds incident entity refs as entities', () => {
    expect(entities.find((e) => e.id === 'person:example-person')).toEqual({ id: 'person:example-person', type: 'person', name: 'example-person' });
  });

  it('creates unreviewed probabilistic links, never storing emails', () => {
    const email = find(links, 'account:npm/alice', 'linked_to', 'account:npm/carol');
    expect(email).toMatchObject({ confidence: 0.5, method: 'probabilistic', reviewed: false });
    // gmail is a shared domain: no link from bob
    expect(links.some((l) => l.from === 'account:npm/bob' && l.relation === 'linked_to')).toBe(false);
    const handle = find(links, 'account:npm/alice', 'linked_to', 'account:github/alice');
    expect(handle).toMatchObject({ confidence: 0.7, method: 'probabilistic', reviewed: false });
    const carol = find(links, 'account:npm/carol', 'linked_to', 'org:github/carol');
    expect(carol?.confidence).toBe(0.7);
    expect(JSON.stringify({ entities, links })).not.toMatch(/@acme\.dev|@gmail/);
    for (const l of links) {
      expect(l.evidence.length).toBeGreaterThan(0);
      if (l.method === 'probabilistic') expect(l.confidence).toBeLessThan(0.8);
      else expect(l.confidence).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('can skip probabilistic links and is deterministic', () => {
    const r = resolveEntities(syntheticFacts(), { probabilistic: false });
    expect(r.links.every((l) => l.method === 'deterministic')).toBe(true);
    expect(resolveEntities(syntheticFacts())).toEqual(resolveEntities(syntheticFacts()));
  });

  it('editDistance', () => {
    expect(editDistance('kitten', 'sitten', 1)).toBe(1);
    expect(editDistance('abcdef', 'abcxyz', 1)).toBe(2);
  });
});

describe('review state', () => {
  const { links } = resolveEntities(syntheticFacts());

  it('queues low-confidence probabilistic links', () => {
    const q = reviewQueue(links);
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((l) => !isLinkUsable(l))).toBe(true);
    expect(q[0]!.confidence).toBeGreaterThanOrEqual(q[q.length - 1]!.confidence);
  });

  it('accepts and rejects links', () => {
    const state = parseReviewState({
      version: 1,
      decisions: [
        { from: 'account:npm/alice', to: 'account:github/alice', relation: 'linked_to', decision: 'accept', reviewer: 'r1' },
        { from: 'account:npm/alice', to: 'account:npm/carol', relation: 'linked_to', decision: 'reject' },
        { from: 'x', to: 'y', relation: 'owns', decision: 'accept' },
      ],
    });
    const res = applyReviewState(links, state);
    expect(res.accepted).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.unmatched).toHaveLength(1);
    const accepted = res.links.find((l) => linkKey(l) === 'account:npm/alice|linked_to|account:github/alice');
    expect(accepted?.reviewed).toBe(true);
    expect(isLinkUsable(accepted!)).toBe(true);
    expect(res.links.some((l) => linkKey(l) === 'account:npm/alice|linked_to|account:npm/carol')).toBe(false);
    // input untouched
    expect(links.find((l) => linkKey(l) === 'account:npm/alice|linked_to|account:github/alice')?.reviewed).toBe(false);
  });

  it('loads from disk; missing file is empty; invalid is an error', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'review-'));
    expect(await loadReviewState(path.join(dir, 'none.json'))).toEqual({ version: 1, decisions: [] });
    const file = path.join(dir, 'r.json');
    await writeFile(file, JSON.stringify({ version: 1, decisions: [{ from: 'a', to: 'b', relation: 'owns', decision: 'maybe' }] }));
    await expect(loadReviewState(file)).rejects.toThrow(/invalid review state/);
  });
});

describe('entityPathsToIncidents', () => {
  it('finds direct maintainer incidents (1 hop)', () => {
    const inc = incidentFor('account:npm/carol');
    const data = resolveEntities(syntheticFacts(), { incidents: [inc] });
    const g = buildEntityGraph(data, [inc]);
    const paths = g.entityPathsToIncidents(npmPurl('@scope/bar', '3.0.0'));
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ path: [BAR, 'account:npm/carol'], hops: 1, confidence: 0.9 });
    expect(paths[0]!.links[0]!.relation).toBe('maintains');
    expect(entityPathsToIncidents(g, BAR)).toEqual(paths);
  });

  it('follows org and funder hops with decaying confidence and respects maxHops', () => {
    const inc = incidentFor('funder:opencollective/acme-collective', 'INC-2023-0002', 1);
    const data = resolveEntities(syntheticFacts(), { incidents: [inc] });
    const g = buildEntityGraph(data, [inc]);
    const paths = g.entityPathsToIncidents(FOO);
    expect(paths[0]).toMatchObject({
      path: [FOO, 'org:github/acme', 'funder:opencollective/acme-collective'],
      hops: 2,
    });
    expect(paths[0]!.confidence).toBeCloseTo(0.81);
    expect(g.entityPathsToIncidents(FOO, 1)).toEqual([]);
  });

  it('ignores unreviewed probabilistic links until accepted', () => {
    // Incident attaches to github account; npm/carol --(probabilistic)--> org:github/carol is used only after review.
    const inc = incidentFor('account:npm/alice', 'INC-2023-0003');
    const data = resolveEntities(syntheticFacts(), { incidents: [inc] });
    // From BAR: carol (1 hop) --email-domain--> alice (probabilistic, 0.5)
    const unreviewed = buildEntityGraph(data, [inc]).entityPathsToIncidents(BAR);
    expect(unreviewed).toEqual([]);
    expect(buildEntityGraph(data, [inc], { includeUnreviewed: true }).entityPathsToIncidents(BAR).length).toBeGreaterThanOrEqual(1);

    const reviewed = applyReviewState(data.links, {
      version: 1,
      decisions: [{ from: 'account:npm/alice', to: 'account:npm/carol', relation: 'linked_to', decision: 'accept' }],
    });
    const paths = buildEntityGraph({ entities: data.entities, links: reviewed.links }, [inc]).entityPathsToIncidents(BAR);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.path).toEqual([BAR, 'account:npm/carol', 'account:npm/alice']);
    expect(paths[0]!.confidence).toBeCloseTo(1 * 0.5 * 0.9);
  });

  it('does not traverse through other packages and handles bad input', () => {
    // alice maintains FOO; incident on carol. From FOO, path via BAR (a package) must not be used.
    const inc = incidentFor('account:npm/carol');
    const facts = [
      ...syntheticFacts().filter((f) => f.kind !== 'maintainers' || f.subject !== BAR),
      makeFact('maintainers', BAR, { maintainers: [{ name: 'alice' }, { name: 'carol' }], count: 2 }, meta),
    ];
    const data = resolveEntities(facts, { incidents: [inc], probabilistic: false });
    const g = buildEntityGraph(data, [inc]);
    expect(g.entityPathsToIncidents(FOO)).toEqual([]);
    expect(g.entityPathsToIncidents(BAR)).toHaveLength(1);
    expect(g.entityPathsToIncidents('not a purl')).toEqual([]);
  });

  it('terminates on cycles', () => {
    const links: EntityLink[] = [
      { from: 'account:npm/a', to: FOO, relation: 'maintains', confidence: 1, evidence: ['https://e'], method: 'deterministic', reviewed: true },
      { from: 'account:npm/a', to: 'org:github/o', relation: 'member_of', confidence: 1, evidence: ['https://e'], method: 'deterministic', reviewed: true },
      { from: 'account:npm/b', to: 'org:github/o', relation: 'member_of', confidence: 1, evidence: ['https://e'], method: 'deterministic', reviewed: true },
      { from: 'account:npm/b', to: 'account:npm/a', relation: 'linked_to', confidence: 0.9, evidence: ['https://e'], method: 'deterministic', reviewed: true },
    ];
    const inc = incidentFor('account:npm/b');
    const paths = buildEntityGraph({ entities: [], links }, [inc]).entityPathsToIncidents(FOO, 3);
    expect(paths.map((p) => p.hops).sort()).toEqual([2, 3]);
    // via the org (3 hops, all links 1.0) ranks above the 0.9 linked_to shortcut (2 hops)
    expect(paths[0]).toMatchObject({ hops: 3, path: [FOO, 'account:npm/a', 'org:github/o', 'account:npm/b'] });
    expect(paths[0]!.confidence).toBeCloseTo(0.9);
    expect(paths[1]!.confidence).toBeCloseTo(0.81);
  });
});

describe('ownershipOf (who is behind a package, incident or not)', () => {
  it('lists accounts and the owner org, then the funders one hop further, without any incident', () => {
    const g = buildEntityGraph(resolveEntities(syntheticFacts(), { incidents: [] }));
    const own = g.ownershipOf(npmPurl('foo', '1.2.3'));
    const pairs = own.map((e) => `${e.from} -${e.relation}-> ${e.entityId}`);
    expect(pairs).toEqual(expect.arrayContaining([`${FOO} -maintains-> account:npm/alice`, `${FOO} -owns-> org:github/acme`, 'org:github/acme -funds-> funder:opencollective/acme-collective']));
    // Nearest first, every entry carries evidence, never a package node, no unreviewed links.
    expect(own.findIndex((e) => e.from !== FOO)).toBeGreaterThan(own.findLastIndex((e) => e.from === FOO));
    for (const e of own) {
      expect(e.evidence!.length).toBeGreaterThan(0);
      expect(e.entityId.startsWith('pkg:')).toBe(false);
      expect(e.reviewed || e.method === 'deterministic').toBe(true);
    }
    expect(g.ownershipOf(npmPurl('foo'), 1).every((e) => e.from === FOO)).toBe(true);
    expect(g.ownershipOf(npmPurl('foo'), 2, 2)).toHaveLength(2);
    expect(g.ownershipOf('not a purl')).toEqual([]);
    expect(g.ownershipOf(npmPurl('foo'))).toEqual(own); // stable
  });
});
