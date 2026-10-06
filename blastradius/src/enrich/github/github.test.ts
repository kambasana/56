import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpClient, fixtureKey } from '../../core/http.js';
import type { TransportRequest } from '../../core/http.js';
import type { EnrichContext } from '../../core/plugin.js';
import { factsFor, isFactOf, makeFact, npmPurl } from '../../core/types.js';
import type { Component, Fact, Inventory } from '../../core/types.js';
import {
  OPEN_COLLECTIVE_API,
  createGithubEnricher,
  openCollectiveRequestBody,
  parseFundingYml,
  parseOpenCollective,
  parseRepoResponse,
} from './index.js';
import type { OpenCollectiveFundingValue, OpenCollectiveResponse } from './index.js';

const ROOT = join(import.meta.dirname, '../../../test/fixtures');
const GH = join(ROOT, 'github');
const NOW = '2026-10-01T00:00:00.000Z';

async function envelope<T>(...path: string[]): Promise<{ request: { url: string }; response: T }> {
  return JSON.parse(await readFile(join(...path), 'utf8')) as { request: { url: string }; response: T };
}

/** Offline client over the GitHub fixture dir plus the npm packument envelopes. */
async function offlineClient(fixtures: Record<string, unknown> = {}) {
  const http = new HttpClient({ offline: true, cacheDir: false, fixturesDir: GH, minIntervalMs: 0, fixtures });
  for (const name of ['event-stream', 'ua-parser-js', 'yocto-queue']) {
    const env = await envelope<unknown>(ROOT, 'npm', `${name}.json`);
    http.addFixture(env.request.url, env.response);
  }
  return http;
}

function context(http: HttpClient, offline = true) {
  const warnings: string[] = [];
  const ctx: EnrichContext = { http, now: new Date(NOW), offline, warn: (m) => warnings.push(m) };
  return { ctx, warnings };
}

function npm(name: string, version: string): Component {
  return { purl: npmPurl(name, version), ecosystem: 'npm', name, version };
}

function inv(...components: Component[]): Inventory {
  return { assets: [], components, edges: [] };
}

describe('parseFundingYml', () => {
  it('parses the real ua-parser-js FUNDING.yml (template placeholders ignored)', async () => {
    const env = await envelope<string>(GH, 'raw', 'faisalman_ua-parser-js_HEAD_.github_funding.yml.json');
    expect(parseFundingYml(env.response)).toEqual([
      { platform: 'github', handle: 'faisalman', url: 'https://github.com/sponsors/faisalman' },
      { platform: 'open_collective', handle: 'ua-parser-js', url: 'https://opencollective.com/ua-parser-js' },
      { platform: 'custom', url: 'https://www.paypal.me/faisalman/' },
      { platform: 'custom', url: 'https://uaparser.dev/' },
    ]);
  });

  it('parses lists, tidelift and a bare custom URL', () => {
    const text = 'github: [sindresorhus, Qix-]\nopen_collective: sindresorhus\ntidelift: npm/chalk\ncustom: https://sindresorhus.com/donate\n';
    expect(parseFundingYml(text)).toEqual([
      { platform: 'github', handle: 'sindresorhus', url: 'https://github.com/sponsors/sindresorhus' },
      { platform: 'github', handle: 'Qix-', url: 'https://github.com/sponsors/Qix-' },
      { platform: 'open_collective', handle: 'sindresorhus', url: 'https://opencollective.com/sindresorhus' },
      { platform: 'tidelift', handle: 'npm/chalk', url: 'https://tidelift.com/funding/github/npm/chalk' },
      { platform: 'custom', url: 'https://sindresorhus.com/donate' },
    ]);
  });

  it('rejects hostile values and malformed documents', () => {
    expect(parseFundingYml('github: "../../evil"\ncustom: ["javascript:alert(1)", "file:///etc/passwd"]\nunknown_key: x')).toEqual([]);
    expect(parseFundingYml('github: [unclosed')).toEqual([]);
    expect(parseFundingYml('- just\n- a list')).toEqual([]);
    const bomb = 'a: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\ngithub: ok';
    expect(parseFundingYml(bomb)).toEqual([]);
  });
});

describe('parseOpenCollective', () => {
  it('keeps organisation backers by default, de-duplicated and sorted by donations', async () => {
    const env = await envelope<OpenCollectiveResponse>(GH, 'opencollective-ua-parser-js.json');
    expect(parseOpenCollective(env.response, 'ua-parser-js')).toEqual({
      via: 'opencollective',
      collective: 'ua-parser-js',
      host: 'opensource',
      totalBackers: 4,
      sources: [
        { platform: 'open_collective', handle: 'example-hosting-co', url: 'https://opencollective.com/example-hosting-co' },
        { platform: 'open_collective', handle: 'example-tools-inc', url: 'https://opencollective.com/example-tools-inc' },
      ],
    });
    const all = parseOpenCollective(env.response, 'ua-parser-js', { includeIndividuals: true, maxBackers: 2 })!;
    expect(all.sources.map((s) => s.handle)).toEqual(['example-hosting-co', 'example-person']);
  });

  it('returns undefined for an unknown collective and rejects bad slugs', () => {
    expect(parseOpenCollective({ data: { account: null }, errors: [{ message: 'not found' }] }, 'nope')).toBeUndefined();
    expect(() => openCollectiveRequestBody('../x')).toThrow();
  });
});

describe('parseRepoResponse', () => {
  it('validates owner, type and URLs', () => {
    expect(parseRepoResponse({ name: 'r', owner: { login: 'o', type: 'Bot' } })).toBeUndefined();
    expect(parseRepoResponse({ name: 'r', owner: { login: 'bad login', type: 'User' } })).toBeUndefined();
    expect(parseRepoResponse({ name: 'r', owner: { login: 'o', type: 'User' }, html_url: 'javascript:x', pushed_at: 'nope' })).toEqual({
      owner: 'o',
      ownerType: 'User',
      name: 'r',
      htmlUrl: 'https://github.com/o/r',
      archived: false,
    });
  });
});

describe('createGithubEnricher (offline fixtures)', () => {
  it('emits repo_owner, archived and funding facts for npm packages', async () => {
    const http = await offlineClient();
    const { ctx, warnings } = context(http);
    const facts = await createGithubEnricher({ token: '' }).enrich(
      inv(npm('event-stream', '3.3.6'), npm('ua-parser-js', '0.7.29'), npm('yocto-queue', '1.2.2')),
      ctx,
    );
    expect(warnings).toEqual([]);
    expect(http.requestCount).toBe(0);

    const es = 'pkg:npm/event-stream';
    expect(factsFor(facts, es, 'repo_owner')[0]!.value).toEqual({
      repo: 'github.com/dominictarr/event-stream',
      owner: 'dominictarr',
      ownerType: 'User',
      url: 'https://github.com/dominictarr/event-stream',
    });
    expect(factsFor(facts, es, 'archived')[0]!.value).toEqual({ archived: true, lastPushAt: '2018-11-27T03:02:39.000Z' });
    expect(factsFor(facts, es, 'repo_transfer')).toEqual([]);
    expect(factsFor(facts, es, 'funding')).toEqual([]);

    const ua = factsFor(facts, 'pkg:npm/ua-parser-js', 'funding');
    expect(ua.map((f) => f.value.via).sort()).toEqual(['FUNDING.yml', 'opencollective']);
    const yml = ua.find((f) => f.value.via === 'FUNDING.yml')!;
    expect(yml.evidence).toEqual(['https://github.com/faisalman/ua-parser-js/blob/HEAD/.github/funding.yml']);
    const oc = ua.find((f) => f.value.via === 'opencollective')!.value as OpenCollectiveFundingValue;
    expect(oc.collective).toBe('ua-parser-js');
    expect(oc.sources.every((s) => !s.handle?.includes('person'))).toBe(true);

    expect(factsFor(facts, 'pkg:npm/yocto-queue', 'archived')[0]!.value.archived).toBe(false);
    expect(facts.every((f) => f.source === 'github' && f.fetchedAt === NOW && (f.evidence?.length ?? 0) > 0)).toBe(true);
  });

  it('detects a transfer when the canonical owner differs from the declared repository', async () => {
    const http = new HttpClient({
      offline: true,
      cacheDir: false,
      minIntervalMs: 0,
      fixtures: {
        'https://api.github.com/repos/old-owner/widget': {
          name: 'widget',
          full_name: 'new-org/widget',
          html_url: 'https://github.com/new-org/widget',
          owner: { login: 'new-org', type: 'Organization' },
          archived: false,
          pushed_at: '2026-09-01T00:00:00Z',
        },
      },
    });
    const { ctx, warnings } = context(http);
    const subject = 'pkg:npm/widget';
    const facts = await createGithubEnricher({
      fundingYml: false,
      resolveTargets: async () => [{ subject, owner: 'old-owner', repo: 'widget', declaredUrl: 'https://github.com/old-owner/widget' }],
    }).enrich(inv(npm('widget', '1.0.0')), ctx);
    expect(warnings).toEqual([]);
    const transfer = facts.find(isFactOf('repo_transfer'))!;
    expect(transfer.subject).toBe(subject);
    expect(transfer.value).toEqual({ repo: 'github.com/new-org/widget', fromOwner: 'old-owner', toOwner: 'new-org', detectedAt: NOW });
    expect(transfer.evidence).toEqual(['https://github.com/old-owner/widget', 'https://github.com/new-org/widget']);
    expect(facts.find(isFactOf('repo_owner'))!.value.ownerType).toBe('Organization');

    // Regression: replays (--as-of) must not report today's redirect as a transfer seen at `now`.
    const historical = context(http);
    historical.ctx.historical = true;
    const replayFacts = await createGithubEnricher({
      fundingYml: false,
      resolveTargets: async () => [{ subject, owner: 'old-owner', repo: 'widget', declaredUrl: 'https://github.com/old-owner/widget' }],
    }).enrich(inv(npm('widget', '1.0.0')), historical.ctx);
    expect(replayFacts.filter(isFactOf('repo_transfer'))).toEqual([]);
    expect(replayFacts.find(isFactOf('repo_owner'))).toBeDefined();
  });

  it('covers GitHub Actions components by owner/repo', async () => {
    const http = new HttpClient({
      offline: true,
      cacheDir: false,
      minIntervalMs: 0,
      fixtures: {
        'https://api.github.com/repos/actions/checkout': { name: 'checkout', html_url: 'https://github.com/actions/checkout', owner: { login: 'actions', type: 'Organization' } },
      },
    });
    const { ctx } = context(http);
    const action: Component = { purl: 'pkg:githubactions/actions/checkout@v4', ecosystem: 'githubactions', name: 'actions/checkout', version: 'v4' };
    const facts = await createGithubEnricher({ fundingYml: false }).enrich(inv(action), ctx);
    expect(facts.find(isFactOf('repo_owner'))).toMatchObject({ subject: 'pkg:githubactions/actions/checkout', value: { owner: 'actions', ownerType: 'Organization' } });
  });

  it('uses repo/funding facts from earlier enrichers when supplied', async () => {
    const http = await offlineClient({
      [fixtureKey(OPEN_COLLECTIVE_API, 'POST', openCollectiveRequestBody('some-collective'))]: { data: { account: null } },
    });
    const { ctx, warnings } = context(http);
    const meta = { source: 'npm', fetchedAt: NOW };
    const prior: Fact[] = [
      makeFact('repo', 'pkg:npm/yocto-queue', { url: 'https://github.com/sindresorhus/yocto-queue', host: 'github', owner: 'sindresorhus', name: 'yocto-queue', via: 'npm.repository' }, meta),
      makeFact('funding', 'pkg:npm/yocto-queue', { via: 'package.json#funding', sources: [{ platform: 'open_collective', handle: 'some-collective' }] }, meta),
      makeFact('repo', 'pkg:npm/not-in-inventory', { url: 'https://github.com/x/y', host: 'github', owner: 'x', name: 'y', via: 'npm.repository' }, meta),
    ];
    const facts = await createGithubEnricher({ repoFacts: () => prior }).enrich(inv(npm('yocto-queue', '1.2.2')), ctx);
    expect(warnings).toEqual([]);
    expect([...new Set(facts.map((f) => f.subject))]).toEqual(['pkg:npm/yocto-queue']);
    expect(facts.filter(isFactOf('funding'))).toEqual([]); // collective unknown → no fact
  });

  it('warns on 404 and stops calling the API after a 403', async () => {
    const http = new HttpClient({
      offline: true,
      cacheDir: false,
      minIntervalMs: 0,
      fixtures: {
        'https://api.github.com/repos/a/gone': { status: 404, response: { message: 'Not Found' } },
        'https://api.github.com/repos/b/limited': { status: 403, response: { message: 'API rate limit exceeded' } },
      },
    });
    const { ctx, warnings } = context(http);
    const t = (owner: string, repo: string) => ({ subject: `pkg:npm/${repo}`, owner, repo, declaredUrl: `https://github.com/${owner}/${repo}` });
    const facts = await createGithubEnricher({
      fundingYml: false,
      openCollective: false,
      concurrency: 1,
      token: '',
      resolveTargets: async () => [t('a', 'gone'), t('b', 'limited'), t('c', 'never-called')],
    }).enrich(inv(), ctx);
    expect(facts).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining('a/gone not found'),
      expect.stringMatching(/API returned 403 .*set GITHUB_TOKEN/),
    ]);
  });

  it('reports fixture misses offline as one summary warning', async () => {
    const http = new HttpClient({ offline: true, cacheDir: false, minIntervalMs: 0 });
    const { ctx, warnings } = context(http);
    await createGithubEnricher({
      resolveTargets: async () => [{ subject: 'pkg:npm/x', owner: 'o', repo: 'x', declaredUrl: 'https://github.com/o/x' }],
    }).enrich(inv(), ctx);
    expect(warnings.at(-1)).toMatch(/github: 2 request\(s\) missing/);
  });
});

describe('createGithubEnricher (online transport)', () => {
  it('sends GITHUB_TOKEN only to the API host', async () => {
    const seen: TransportRequest[] = [];
    const http = new HttpClient({
      offline: false,
      cacheDir: false,
      minIntervalMs: 0,
      transport: async (req) => {
        seen.push(req);
        if (req.url.startsWith('https://api.github.com/')) {
          return { status: 200, body: JSON.stringify({ name: 'r', html_url: 'https://github.com/o/r', owner: { login: 'o', type: 'User' } }) };
        }
        return { status: 404, body: 'Not Found' };
      },
    });
    const { ctx } = context(http, false);
    await createGithubEnricher({
      token: 'test-token',
      resolveTargets: async () => [{ subject: 'pkg:npm/r', owner: 'o', repo: 'r', declaredUrl: 'https://github.com/o/r' }],
    }).enrich(inv(), ctx);
    const api = seen.filter((r) => r.url.startsWith('https://api.github.com/'));
    const others = seen.filter((r) => !r.url.startsWith('https://api.github.com/'));
    expect(api).toHaveLength(1);
    expect(api[0]!.headers.authorization).toBe('Bearer test-token');
    expect(others.length).toBe(4); // FUNDING.yml candidates
    expect(others.every((r) => r.headers.authorization === undefined)).toBe(true);
  });
});
