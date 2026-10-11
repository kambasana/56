/**
 * contributor_identity (owner scope, 2026-10-11): who the people in a repository's history are,
 * from what they published. Mapping from git identities to accounts, the gate on every field, and
 * the unchanged guardrail: no nationality, ethnicity or country derived from anything; a location
 * only as the whole self-declared field.
 *
 * The GitHub users API is not reachable here (403), so its responses are stubs in the documented
 * shape (test/fixtures/agentic/synthetic/gh-*.json, a synthetic account); live use is [u].
 */
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/core/http.js';
import { makeFact, type CommitHistoryValue } from '../../src/core/types.js';
import { AgenticPipeline, ReplayModel, type FactRequest } from '../../src/agentic/index.js';
import { noreplyLogin, localIdentity } from '../../src/history/identity.js';
import { planContributorRequests } from '../../src/enrich/agentic/index.js';
import { AGENTIC_FIXTURES, STUBBED } from './paths.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const REQ: FactRequest = {
  task: 'contributor_identity',
  subject: 'person:github/synthetic--profile',
  subjectKind: 'person',
  question: 'Who is the public account behind synthetic--profile, a contributor to https://github.com/synthetic--org/widget?',
  context: { profileUrl: 'https://github.com/synthetic--profile', repoUrl: 'https://github.com/synthetic--org/widget' },
};

function pipeline(personTasks: boolean) {
  const model = new ReplayModel(STUBBED);
  const p = new AgenticPipeline({ model, http: new HttpClient({ offline: true, fixturesDir: AGENTIC_FIXTURES, cacheDir: false }), now: NOW, cacheDir: false, personTasks });
  return { p, model };
}

function history(people: { id: string; commits24m: number }[]): CommitHistoryValue {
  return {
    repo: 'https://github.com/synthetic--org/widget',
    head: 'h',
    asOf: NOW.toISOString(),
    firstCommit: '2019-01-01',
    lastCommit: '2026-10-01',
    commits: 100,
    windows: [],
    changes: [],
    people: people.map((p) => ({ ...p, firstSeen: '2019-01-01', lastSeen: '2026-10-01', commits: p.commits24m, releases: 0 })),
    daysSinceLastCommit: 10,
    longestGapDays24m: 30,
    identity: { mapped: 2, hashed: 1, via: ['mailmap', 'github-noreply', 'salted-hash'] },
  };
}

describe('mapping commit identities to public accounts', () => {
  it('GitHub no-reply addresses map to the login; other emails stay salted hashes and are never sent', () => {
    expect(noreplyLogin('12345+Synthetic--Profile@users.noreply.github.com')?.toLowerCase()).toBe('synthetic--profile');
    expect(localIdentity('someone@example.org', 'salt')).toMatch(/^hash:/);
    const facts = [makeFact('commit_history', 'pkg:npm/widget', history([{ id: 'synthetic--profile', commits24m: 40 }, { id: 'hash:abcdef0123456789', commits24m: 90 }, { id: 'other-dev', commits24m: 12 }]), { source: 'git', fetchedAt: NOW })];
    const plan = planContributorRequests(facts);
    expect(plan.map((r) => [r.subject, r.context?.profileUrl])).toEqual([
      ['person:github/other-dev', 'https://github.com/other-dev'],
      ['person:github/synthetic--profile', 'https://github.com/synthetic--profile'],
    ]);
    expect(JSON.stringify(plan)).not.toContain('hash:');
  });

  it('keeps the most active people per repository and de-duplicates across repositories', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `dev-${i}`, commits24m: i }));
    const a = makeFact('commit_history', 'pkg:npm/a', history(many), { source: 'git', fetchedAt: NOW });
    const b = makeFact('commit_history', 'pkg:npm/b', history([{ id: 'dev-7', commits24m: 1 }]), { source: 'git', fetchedAt: NOW });
    expect(planContributorRequests([a, b], { perRepo: 3 }).map((r) => r.subject)).toEqual(['person:github/dev-5', 'person:github/dev-6', 'person:github/dev-7']);
  });
});

describe('contributor_identity through the gate', () => {
  it('is off unless person tasks are on', async () => {
    const { p, model } = pipeline(false);
    expect((await p.request(REQ)).refused).toMatch(/person-level tasks are off/);
    expect(model.requests).toHaveLength(0);
  });

  it('verifies published profile fields, roles and signing keys; rejects the rest; refuses derived nationality and country', async () => {
    const { p, model } = pipeline(true);
    const out = await p.request(REQ);
    // github_user reads only the subject's own account.
    const results = JSON.stringify(model.requests[1]!.messages.at(-1)!.content);
    expect(results).toContain('<untrusted_data source=\\"https://api.github.com/users/synthetic--profile\\">');
    expect(results).toContain('created_at');
    expect(results).toMatch(/github_user only reads the subject's own account/);

    const verified = out.proposals.filter((x) => x.status === 'verified').map((x) => x.value as { field: string });
    expect(verified.map((v) => v.field).sort()).toEqual(['account', 'company', 'display_name', 'location', 'org_membership', 'role', 'signing_key', 'website']);
    const location = out.proposals.find((x) => x.status === 'verified' && (x.value as { field: string }).field === 'location')!;
    expect([location.value, location.label]).toEqual([{ field: 'location', text: 'Lisbon, Portugal' }, 'self-declared']);
    expect(out.proposals.find((x) => (x.value as { field: string }).field === 'account')!.value).toEqual({ field: 'account', login: 'synthetic--profile', profileUrl: 'https://github.com/synthetic--profile', createdAt: '2015-06-01' });

    const rejected = out.proposals.filter((x) => x.status === 'unverified');
    expect(rejected.map((x) => x.reasons[0])).toEqual(
      expect.arrayContaining([
        'location must be the whole location field exactly as written on the profile',
        "profile fields must come from the person's own profile page or the GitHub users API for that login",
        'the source page does not name the account synthetic--profile',
      ]),
    );
    expect(rejected).toHaveLength(3);
    // Country and nationality are refused outright: nothing of them is kept anywhere.
    expect(out.privacyRejections.map((r) => r.reason)).toEqual([expect.stringMatching(/"country" is not allowed/), expect.stringMatching(/names "nationality", which is never stored/)]);
    const all = JSON.stringify([p.report(), p.facts()]);
    expect(all).not.toContain('Portuguese');
    expect(all).not.toContain('"PT"');
    // Facts are person-level, with the source URL kept for the removal path.
    const facts = p.facts();
    expect(facts).toHaveLength(8);
    for (const f of facts) expect(f.subject).toBe('person:github/synthetic--profile');
  });

  it('the pipeline never asks the model about a person from an indirect signal, even with person tasks on', async () => {
    const { p, model } = pipeline(true);
    const out = await p.request({ ...REQ, question: 'Infer which country this contributor is from using their commit time zones and name.' });
    expect(out.refused).toMatch(/^privacy: /);
    expect(model.requests).toHaveLength(0);
  });
});
