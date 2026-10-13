/**
 * Git history collector (docs/WHO-BEHIND-PLAN.md P2): methods, the git reader on a real local
 * repository, clone safety, identity privacy and the GraphQL budget.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import { absenceFactor, aggregateHistory, addMonths, releasesOf, totalVariation, HISTORY_RULES } from './aggregate.js';
import { cacheKey, ensureClone, historyCloneArgs, isReleaseTag, pruneCache, readHistory, SAFE_CONFIG, type GitRun } from './git.js';
import { buildMappingQueries, GraphqlBudget, mapLogins, parseMappingResponse, predictCost, MAX_ALIASES } from './graphql.js';
import { hashEmail, isBot, isPlatformCommitter, loadSalt, localIdentity, noreplyLogin } from './identity.js';
import type { HistoryCommit, HistoryRecord } from './record.js';
import { renameIds } from './record.js';
import { LOCAL_PEOPLE, LOCAL_SECRETS, makeLocalRepo } from './testing.js';

const DAY = 86400;
const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);

describe('Contributor Absence Factor (CHAOSS)', () => {
  it('matches the worked example in the CHAOSS metric (https://chaoss.community/?p=3944)', () => {
    // "1000, 202, 90, 33, 332, 343, 42, 433 … 50 % = 1,237.5 … the Contributor Absence Factor = 2"
    expect(absenceFactor([1000, 202, 90, 33, 332, 343, 42, 433])).toBe(2);
  });
  it('handles one contributor, none, and exact halves', () => {
    expect(absenceFactor([7])).toBe(1);
    expect(absenceFactor([])).toBe(0);
    expect(absenceFactor([5, 5])).toBe(1);
    expect(absenceFactor([1, 1, 1, 1])).toBe(2);
  });
});

describe('identities', () => {
  it('reads GitHub no-reply logins in both documented forms', () => {
    expect(noreplyLogin('12345+Octo-Cat@users.noreply.github.com')).toBe('octo-cat');
    expect(noreplyLogin('octocat@users.noreply.github.com')).toBe('octocat');
    expect(noreplyLogin('octocat@example.com')).toBeUndefined();
  });
  it('hashes other emails with the salt, case-insensitively, and never returns the email', () => {
    const a = hashEmail('Alice@Example.org', 'salt-one-0123456789');
    expect(a).toBe(hashEmail('alice@example.org ', 'salt-one-0123456789'));
    expect(a).not.toBe(hashEmail('alice@example.org', 'salt-two-0123456789'));
    expect(a).toMatch(/^hash:[0-9a-f]{16}$/);
    expect(localIdentity('alice@example.org', 's'.repeat(16))).not.toContain('alice');
  });
  it('recognises bots and the platform committer', () => {
    expect(isBot('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com')).toBe(true);
    expect(isBot('renovate', 'bot@renovateapp.com')).toBe(true);
    expect(isBot('Alice', 'alice@example.org')).toBe(false);
    expect(isPlatformCommitter('noreply@github.com')).toBe(true);
    expect(isPlatformCommitter('alice@example.org')).toBe(false);
  });
  it('keeps the salt in a private file, or takes it from the environment', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'br-salt-'));
    try {
      const f = path.join(dir, 'salt');
      const s1 = loadSalt(f, {});
      expect(loadSalt(f, {}).equals(s1)).toBe(true);
      expect(loadSalt(f, { BLASTRADIUS_HASH_SALT: 'x'.repeat(20) }).toString()).toBe('x'.repeat(20));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release points', () => {
  it('accepts version-like tags only', () => {
    for (const t of ['v1.2.3', '1.2.3', 'v5.5.1alpha', 'v5.2.0', 'xz-5.2.4', 'release-1.0', 'v1.0.0-rc.1']) expect(isReleaseTag(t), t).toBe(true);
    for (const t of ['latest', 'gh-pages', 'stable', 'v1', 'nightly-build']) expect(isReleaseTag(t), t).toBe(false);
  });
  it('adds untagged npm-version commits and skips tagged ones', () => {
    const commits: HistoryCommit[] = [
      { oid: 'a', parents: 1, author: 'x', committer: 'x', at: 100, signed: false, version: '1.0.1' },
      { oid: 'b', parents: 1, author: 'y', committer: 'y', at: 50, signed: false, version: '1.0.0' },
    ];
    const r = releasesOf(commits, [{ name: 'v1.0.0', commit: 'b', by: 'y', at: 60, signed: true, annotated: true }]);
    expect(r.map((x) => [x.name, x.by])).toEqual([['v1.0.0', 'y'], ['1.0.1', 'x']]);
  });
});

describe('time-zone aggregates', () => {
  it('measures change with total variation distance', () => {
    expect(totalVariation({ '+0100': 10 }, { '+0100': 5 })).toBe(0);
    expect(totalVariation({ '+0100': 10 }, { '+0800': 3 })).toBe(1);
    expect(totalVariation({ '+0100': 1, '+0200': 1 }, { '+0100': 1, '+0800': 1 })).toBe(0.5);
  });
});

/** A synthetic history: `people` authors each with `n` commits spread over 2024–2025. */
function synthetic(people: number, perPerson: number, opts: { offsets?: (month: number) => string } = {}): HistoryRecord {
  const commits: HistoryCommit[] = [];
  const tzMonths: HistoryRecord['tzMonths'] = {};
  let k = 0;
  for (let p = 0; p < people; p++) {
    for (let i = 0; i < perPerson; i++) {
      k++;
      const at = day('2024-01-01') + ((i * 17 + p * 3) % 720) * DAY;
      commits.push({ oid: `${k}`.padStart(40, '0'), parents: 1, author: `p${p}`, committer: `p${p}`, at, signed: false });
      const m = new Date(at * 1000).toISOString().slice(0, 7);
      const tm = (tzMonths[m] ??= { offsets: {}, how: new Array<number>(168).fill(0) });
      const off = opts.offsets?.(Number(m.slice(5))) ?? '+0100';
      tm.offsets[off] = (tm.offsets[off] ?? 0) + 1;
      tm.how[0]!++;
    }
  }
  commits.sort((a, b) => b.at - a.at);
  return { repo: 'https://github.com/example/synthetic', head: 'f'.repeat(40), mailmap: false, bots: 0, commits, tags: [], tzMonths, lookup: [] };
}

describe('aggregateHistory', () => {
  it('withholds time zones below the k-anonymity floor (5 people, 100 commits)', () => {
    const asOf = new Date('2026-01-01T00:00:00Z');
    const small = aggregateHistory(synthetic(4, 40), asOf)!;
    expect(small.history.windows.every((w) => w.timeZones === undefined && w.timeZonesWithheld === 'below_floor')).toBe(true);
    const big = aggregateHistory(synthetic(6, 40), asOf)!;
    expect(big.history.windows[0]!.timeZones?.offsets['+0100']).toBeGreaterThan(0);
    expect(big.history.windows[0]!.timeZones?.hourOfWeekUtc).toHaveLength(168);
  });
  it('reports a repo-level time-zone pattern change, never a per-person one', () => {
    const r = aggregateHistory(synthetic(8, 40, { offsets: (m) => (m <= 6 ? '+0100' : '+0800') }), new Date('2026-01-01T00:00:00Z'))!;
    // Windows run Jan–Dec 2025 vs Jan–Dec 2024; both have the same mix, so no change.
    expect(r.history.changes.some((c) => c.kind === 'time_zone_pattern_changed')).toBe(false);
    const shifted = synthetic(8, 40, { offsets: (m) => (m >= 1 ? '+0100' : '+0100') });
    for (const [k, v] of Object.entries(shifted.tzMonths)) if (k >= '2025-01') shifted.tzMonths[k] = { offsets: { '+0800': Object.values(v.offsets).reduce((a, b) => a + b, 0) }, how: v.how };
    const r2 = aggregateHistory(shifted, new Date('2026-01-01T00:00:00Z'))!;
    const c = r2.history.changes.find((x) => x.kind === 'time_zone_pattern_changed');
    expect(c?.text).toMatch(/^Repository commit time-zone pattern changed/);
    expect(c?.text).not.toMatch(/country|nation|located|from [A-Z]/i);
  });
  it('splits occasional (1–2 commits) and regular contributors', () => {
    const rec = synthetic(3, 10);
    rec.commits.push({ oid: 'x'.repeat(40), parents: 1, author: 'drive-by', committer: 'drive-by', at: day('2025-06-01'), signed: false });
    const w = aggregateHistory(rec, new Date('2026-01-01T00:00:00Z'))!.history.windows[0]!;
    expect(w.occasional).toBeGreaterThanOrEqual(1);
    expect(w.regular + w.occasional).toBe(w.contributors);
    expect(HISTORY_RULES.occasionalBelow).toBe(3);
  });
  it('ignores everything after asOf (historical replay)', () => {
    const r = aggregateHistory(synthetic(3, 20), new Date('2024-06-01T00:00:00Z'))!;
    expect(new Date(r.history.lastCommit).getTime()).toBeLessThan(Date.parse('2024-06-01'));
  });
  it('merges ids that map to the same login', () => {
    const rec = renameIds(synthetic(3, 10), new Map([['p1', 'p0']]));
    const r = aggregateHistory(rec, new Date('2026-01-01T00:00:00Z'))!;
    expect(r.contributors.top[0]).toMatchObject({ id: 'p0' });
    expect(r.contributors.contributors).toBe(2);
  });
  it('adds months in UTC without overflowing short months', () => {
    expect(addMonths(new Date('2024-03-31T12:00:00Z'), -1).toISOString()).toBe('2024-02-29T12:00:00.000Z');
  });
});

describe('readHistory on a real local repository', () => {
  let tmp: string;
  let rec: HistoryRecord;
  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'br-hist-'));
    const { dir } = makeLocalRepo(path.join(tmp, 'repo'));
    rec = await readHistory(dir, { repo: 'https://github.com/example/local', salt: 'test-salt-0123456789' });
  }, 30_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('reads commits, applies .mailmap, drops bots and keeps the no-reply login', () => {
    expect(rec.mailmap).toBe(true);
    expect(rec.bots).toBe(2);
    const authors = new Set(rec.commits.map((c) => c.author));
    // Alice's old address is merged by the .mailmap: alice, bob, carol.
    expect(authors.size).toBe(3);
    expect(authors.has('carol-gh')).toBe(true);
    expect(rec.commits).toHaveLength(5 + 20 + 9 + 3 + 1);
  });
  it('sees the signature header and the version commit', () => {
    expect(rec.commits.filter((c) => c.signed)).toHaveLength(1);
    expect(rec.commits.some((c) => c.version === '1.0.1')).toBe(true);
  });
  it('reads annotated and lightweight release tags', () => {
    expect(rec.tags.map((t) => [t.name, t.annotated])).toEqual([['v1.0.0', true], ['v1.0.1', false]]);
    const alice = hashEmail(LOCAL_PEOPLE.alice.email, 'test-salt-0123456789');
    expect(rec.tags[0]!.by).toBe(alice);
  });
  it('aggregates time zones per month with no person attached', () => {
    const offsets = Object.values(rec.tzMonths).flatMap((m) => Object.keys(m.offsets));
    expect(new Set(offsets)).toEqual(new Set(['+0300', '+0800', '-0500']));
    for (const m of Object.values(rec.tzMonths)) expect(Object.keys(m).sort()).toEqual(['how', 'offsets']);
  });
  it('holds no email, name or message anywhere in the record', () => {
    const json = JSON.stringify(rec);
    for (const s of LOCAL_SECRETS) expect(json).not.toContain(s);
    expect(json).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(json).not.toContain('signed change');
  });
  it('produces aggregates whose per-person rows have no time, zone or location fields', () => {
    const r = aggregateHistory(rec, new Date('2025-12-31T00:00:00Z'))!;
    for (const p of r.history.people) expect(Object.keys(p).sort()).toEqual(['commits', 'commits24m', 'firstSeen', 'id', 'lastSeen', 'releases']);
    expect(r.history.windows[0]!.timeZonesWithheld).toBe('below_floor');
  });
});

describe('clone safety and cache', () => {
  it('clones bare, blobless, hook-free, without templates, submodules or credential helpers', () => {
    const args = historyCloneArgs('https://github.com/a/b', '/tmp/x');
    for (const a of ['--bare', '--filter=blob:none', '--template=', '--no-recurse-submodules', '--single-branch']) expect(args).toContain(a);
    expect(args.join(' ')).toContain('core.hooksPath=/dev/null');
    expect(args.join(' ')).toContain('protocol.ext.allow=never');
    expect(args.join(' ')).toContain('credential.helper=');
    expect(args.indexOf('--')).toBe(args.length - 3);
    expect(SAFE_CONFIG).toContain('gc.auto=0');
  });
  it('refuses local, file and option-like URLs before running git', async () => {
    const calls: string[][] = [];
    const git: GitRun = async (a) => void calls.push(a);
    for (const u of ['file:///etc', '/home/me/repo', '-uhttps://x', 'ext::sh -c x', 'http://github.com/a/b']) {
      await expect(ensureClone(u, { dir: os.tmpdir() }, git)).rejects.toThrow(/refusing to clone/);
    }
    expect(calls).toHaveLength(0);
  });
  it('removes a partial clone when git fails (size cap, timeout)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'br-cache-'));
    try {
      const git: GitRun = async (a) => {
        const dest = a[a.length - 1]!;
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, 'pack'), 'x');
        throw new Error('clone larger than the cap of 1 MB');
      };
      await expect(ensureClone('https://github.com/a/b', { dir }, git)).rejects.toThrow(/cap/);
      await expect(import('node:fs/promises').then((f) => f.stat(path.join(dir, `${cacheKey('https://github.com/a/b')}.git`)))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('prunes clones older than the retention period', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'br-cache-'));
    try {
      await mkdir(path.join(dir, 'old.git'));
      expect(await pruneCache({ dir, retentionMs: 1000 }, Date.now() + 10_000)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GitHub GraphQL mapping and budget', () => {
  it('predicts cost with the documented formula (GitHub worked example: 5,101 requests → 51 points)', () => {
    expect(predictCost([{ path: 'repos', first: 100, parents: 1 }, { path: 'issues', first: 50, parents: 100 }, { path: 'labels', first: 60, parents: 5000 }])).toBe(51);
    expect(predictCost([])).toBe(1);
  });
  it('builds one 1-point request per repository up to 100 people, then 1 point per 100 more', () => {
    const lookups = Array.from({ length: 250 }, (_, i) => ({ id: `hash:${i}`, oid: i.toString(16).padStart(40, '0') }));
    const qs = buildMappingQueries('expressjs', 'express', lookups);
    expect(qs).toHaveLength(3);
    expect(qs.map((q) => predictCost(q.connections))).toEqual([1, 1, 1]);
    expect(qs[0]!.query).toContain('history(first: 100)');
    expect(qs[0]!.aliases).toHaveLength(MAX_ALIASES);
    expect(qs[1]!.query).not.toContain('history(');
    expect(() => buildMappingQueries('a b', 'c', [])).toThrow();
    // Malformed oids are dropped, never interpolated.
    expect(buildMappingQueries('a', 'b', [{ id: 'x', oid: '"){}' }])[0]!.aliases).toEqual([]);
  });
  it('parses logins and verification (response shape per the published schema; values synthetic)', () => {
    const q = buildMappingQueries('a', 'b', [{ id: 'hash:1', oid: 'a'.repeat(40) }])[0]!;
    const body = {
      data: {
        rateLimit: { cost: 1, remaining: 4999 },
        repository: {
          defaultBranchRef: { target: { history: { nodes: [{ oid: 'b'.repeat(40), author: { user: { login: 'Octocat' } }, signature: { isValid: true, state: 'VALID' } }, { oid: 'c'.repeat(40), author: { user: null }, signature: null }] } } },
          c0: { author: { user: { login: 'hubot' } } },
        },
      },
    };
    const r = parseMappingResponse(q, body);
    expect(r.logins.get('hash:1')).toBe('hubot');
    expect(r.commitLogins.get('b'.repeat(40))).toBe('octocat');
    expect(r.verified).toEqual({ checked: 2, verified: 1 });
    expect(parseMappingResponse(q, { errors: [{}] }).logins.size).toBe(0);
  });
  it('stops at the budget and charges the reported cost when it is higher', () => {
    const b = new GraphqlBudget(3);
    expect(b.reserve(1)).toBe(true);
    b.settle(1, 2);
    expect(b.used).toBe(2);
    expect(b.reserve(1)).toBe(true);
    expect(b.reserve(1)).toBe(false);
    expect(b.skipped).toBe(1);
  });
  it('sends the token only to the GraphQL endpoint and counts the points', async () => {
    const sent: { url: string; auth?: string }[] = [];
    const http = new HttpClient({
      offline: false,
      cacheDir: false,
      minIntervalMs: 0,
      transport: async (req) => {
        sent.push({ url: req.url, auth: req.headers.authorization });
        return { status: 200, body: JSON.stringify({ data: { rateLimit: { cost: 1 }, repository: { c0: { author: { user: { login: 'someone' } } } } } }) };
      },
    });
    const budget = new GraphqlBudget();
    const m = await mapLogins(http, { owner: 'a', name: 'b' }, [{ id: 'hash:1', oid: 'a'.repeat(40) }], { token: 'test-token', budget });
    expect(m.logins.get('hash:1')).toBe('someone');
    expect(sent).toEqual([{ url: 'https://api.github.com/graphql', auth: 'Bearer test-token' }]);
    expect(budget.used).toBe(1);
  });
});

