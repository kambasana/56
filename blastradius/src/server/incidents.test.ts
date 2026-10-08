/**
 * Incidents, package reach, "who's behind it" and alert rules through the API, on the offline e2e
 * fixture (event-stream 3.3.6 → flatmap-stream), plus the watcher honouring stored rules.
 */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import type { Inventory } from '../core/types.js';
import type {
  AlertRule,
  IncidentDetail,
  ListAlertRulesResponse,
  ListIncidentsResponse,
  PackageBehindResponse,
  PackageReachResponse,
  PreviewAlertRuleResponse,
} from './api-types-incidents.js';
import { createServer, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from './serve.js';
import { createUser } from './store/auth.js';
import { openStore } from './store/db.js';
import { createAlertRule, incidentEvents, listAlertRules, ruleMatches } from './store/index.js';
import { createOrg } from './store/orgs.js';
import { createProject } from './store/projects.js';
import { completeScan, enqueueScan, markScanRunning } from './store/scans.js';
import { makeResult, steppingClock } from './store/testing.js';
import { AlertWatcher } from './watch.js';
import { pathsTo, purlLabel, viaOf } from './reach.js';

type App = ReturnType<typeof createServer>;
let srv: App;
const cookies: Record<string, string> = {};
const XRW = { 'X-Requested-With': 'blastradius' };

async function call(method: string, path: string, opts: { as?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? XRW : {}) };
  if (opts.as) headers.Cookie = `br_session=${cookies[opts.as]}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return srv.app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}
const json = async <T>(r: Response | Promise<Response>): Promise<T> => (await (await r).json()) as T;

const advisory = JSON.parse(readFileSync(join(process.cwd(), 'test/replay/data/advisories/GHSA-mh6f-8j2x-4483.json'), 'utf8')) as unknown;
const ID = 'GHSA-mh6f-8j2x-4483';

beforeAll(async () => {
  srv = createServer({
    devMode: true,
    localRoots: [],
    offline: true,
    fixturesDir: FIXTURES_DIR,
    asOf: FIXTURE_AS_OF,
    webDir: null,
    scanOptions: {
      http: new HttpClient({
        offline: true,
        fixturesDir: FIXTURES_DIR,
        cacheDir: false,
        minIntervalMs: 0,
        transport: async (req) => {
          throw new Error(`network access attempted in test: ${req.url}`);
        },
      }),
      cacheDir: false,
    },
    alerts: { packPath: undefined, webhookUrl: undefined },
    log: () => {},
  });
  const seed = await seedDevData(srv.deps);
  await srv.jobs.waitFor(seed.scanId!);
  for (const u of ['admin', 'appsec', 'developer', 'auditor']) {
    const res = await call('POST', '/api/auth/login', { body: { email: `${u}@local`, password: 'blastradius-dev' } });
    cookies[u] = /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  }
}, 60_000);

afterAll(() => srv.jobs.stop());

describe('incidents', () => {
  it('lists nothing before an advisory hits, then one incident per advisory', async () => {
    expect((await json<ListIncidentsResponse>(call('GET', '/api/incidents', { as: 'admin' }))).items).toEqual([]);
    // AppSec runs incidents, so it may re-check stored inventories (no scan).
    expect((await call('POST', '/api/alerts/check', { as: 'appsec', body: { advisories: [advisory] } })).status).toBe(200);
    const list = await json<ListIncidentsResponse>(call('GET', '/api/incidents', { as: 'auditor' }));
    expect(list.items).toHaveLength(1);
    const row = list.items[0]!;
    expect(row).toMatchObject({ id: ID, level: 'critical', status: 'investigating', affected: 1, fixed: 0, closedAt: null, projects: ['payments-platform'] });
    expect(row.packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual(['event-stream@3.3.6', 'flatmap-stream@0.1.1']);
    expect(row.summary).toMatch(/event-stream/);
  });

  it('shows where it is, who brought it in, and a typed timeline', async () => {
    const d = await json<IncidentDetail>(call('GET', `/api/incidents/${ID}`, { as: 'developer' }));
    expect(d.hits).toHaveLength(2);
    const flat = d.hits.find((h) => h.name === 'flatmap-stream')!;
    expect(flat.broughtInBy).toEqual(['event-stream@3.3.6']);
    expect(flat.fixed).toBe(false);
    expect(flat.findingId).toEqual(expect.any(String));
    const es = d.hits.find((h) => h.name === 'event-stream')!;
    expect(es.direct).toBe(true);
    expect(d.timeline.map((e) => e.kind)).toEqual(['alert', 'check']);
    expect(d.timeline[1]!.title).toBe('1 project checked');
    expect(d.checked).toMatchObject({ projects: 1, source: 'advisories' });
    expect(d.actions.recheck).toMatchObject({ available: false, reason: expect.stringMatching(/BLASTRADIUS_PACK/) });
    expect(d.actions.notify).toMatchObject({ available: false, reason: expect.stringMatching(/BLASTRADIUS_ALERT_WEBHOOK/) });
    expect((await call('GET', '/api/incidents/GHSA-none', { as: 'admin' })).status).toBe(404);
  });

  it('moves through Investigating › Fixing › Monitoring › Closed with a recorded event', async () => {
    expect((await call('PATCH', `/api/incidents/${ID}`, { as: 'auditor', body: { status: 'fixing' } })).status).toBe(403);
    expect((await call('PATCH', `/api/incidents/${ID}`, { as: 'appsec', body: { status: 'nope' } })).status).toBe(400);
    expect((await call('PATCH', '/api/incidents/GHSA-none', { as: 'appsec', body: { status: 'fixing' } })).status).toBe(404);
    const d = await json<IncidentDetail>(call('PATCH', `/api/incidents/${ID}`, { as: 'appsec', body: { status: 'fixing' } }));
    expect(d.status).toBe('fixing');
    const ev = d.timeline.find((e) => e.kind === 'status')!;
    expect(ev).toMatchObject({ from: 'investigating', to: 'fixing', detail: 'Status: Investigating → Fixing' });
    const closed = await json<IncidentDetail>(call('PATCH', `/api/incidents/${ID}`, { as: 'appsec', body: { status: 'closed' } }));
    expect(closed.closedAt).toEqual(expect.any(String));
    await call('PATCH', `/api/incidents/${ID}`, { as: 'appsec', body: { status: 'investigating' } });
  });

  it('refuses to notify without a webhook, and needs a sending permission', async () => {
    expect((await call('POST', `/api/incidents/${ID}/notify`, { as: 'auditor' })).status).toBe(403);
    const r = await call('POST', `/api/incidents/${ID}/notify`, { as: 'admin' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/BLASTRADIUS_ALERT_WEBHOOK/);
  });
});

describe('package reach and who is behind it', () => {
  it('reports projects, flows and paths for one version, production first', async () => {
    const r = await json<PackageReachResponse>(call('GET', '/api/packages/reach?name=flatmap-stream&version=0.1.1', { as: 'auditor' }));
    expect(r.query).toEqual({ name: 'flatmap-stream', version: '0.1.1' });
    expect(r.projectsSearched).toBe(1);
    expect(r.level).toBe('critical');
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]!.via).toContain('event-stream@3.3.6');
    expect(r.flows.every((f) => f.via === 'event-stream@3.3.6' && f.assets > 0)).toBe(true);
    expect(r.paths.length).toBeGreaterThan(0);
    expect(r.paths[0]!.nodes.at(-1)!.label).toBe('flatmap-stream@0.1.1');
    expect(r.paths[0]!.scopes).toHaveLength(r.paths[0]!.nodes.length - 1);
    expect(r.advisories).toEqual([{ id: ID, published: '2018-11-26T23:58:21Z', status: 'investigating', fixedIn: null }]);
    expect(r.lifecycle.advisory).toEqual({ id: ID, at: '2018-11-26T23:58:21Z' });
    expect(r.lifecycle.fixed).toEqual({ fixed: 0, of: 1 });
    expect(r.lifecycle.firstWarning).toEqual(expect.any(String));
    const es = await json<PackageReachResponse>(call('GET', '/api/packages/reach?name=event-stream', { as: 'admin' }));
    expect(es.advisories[0]!.fixedIn).toBe('4.0.0');
    const none = await json<PackageReachResponse>(call('GET', '/api/packages/reach?name=left-pad', { as: 'admin' }));
    expect(none).toMatchObject({ projects: [], flows: [], paths: [], level: null, advisories: [], lifecycle: { advisory: null, fixed: null } });
    expect((await call('GET', '/api/packages/reach', { as: 'admin' })).status).toBe(400);
  });

  it('merges documented links for a package, without the incident hop', async () => {
    const b = await json<PackageBehindResponse>(call('GET', '/api/packages/behind?name=event-stream', { as: 'auditor' }));
    expect(b.name).toBe('event-stream');
    expect(b.usedIn).toBe(1);
    expect(b.links.every((l) => l.relation !== ('incident' as string) && l.evidence.length > 0)).toBe(true);
    const keys = b.links.map((l) => `${l.from} ${l.entityId} ${l.relation}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('alert rules', () => {
  it('starts on the default rule and reports the webhook honestly', async () => {
    const r = await json<ListAlertRulesResponse>(call('GET', '/api/alert-rules', { as: 'developer' }));
    expect(r).toMatchObject({ items: [], usingDefault: true, webhook: { configured: false }, email: { configured: false } });
  });

  it('previews what a rule would have sent in the last 30 days', async () => {
    const all = await json<PreviewAlertRuleResponse>(call('POST', '/api/alert-rules/preview', { as: 'auditor', body: { minLevel: 'low' } }));
    expect(all.count).toBe(2);
    expect(all.mostRecent?.advisoryId).toBe(ID);
    const crit = await json<PreviewAlertRuleResponse>(call('POST', '/api/alert-rules/preview', { as: 'auditor', body: { minLevel: 'critical', productionOnly: true } }));
    expect(crit.count).toBeLessThanOrEqual(2);
  });

  it('creates, edits and deletes rules with manage_alert_rules only', async () => {
    const body = { name: 'Critical in production', minLevel: 'critical', productionOnly: true, channel: 'Security' };
    expect((await call('POST', '/api/alert-rules', { as: 'auditor', body })).status).toBe(403);
    expect((await call('POST', '/api/alert-rules', { as: 'developer', body })).status).toBe(403);
    expect((await call('POST', '/api/alert-rules', { as: 'appsec', body: { ...body, channel: 'no spaces' } })).status).toBe(400);
    expect((await call('POST', '/api/alert-rules', { as: 'appsec', body: { ...body, extra: 1 } })).status).toBe(400);
    const res = await call('POST', '/api/alert-rules', { as: 'appsec', body });
    expect(res.status).toBe(201);
    const rule = (await res.json()) as AlertRule;
    expect(rule).toMatchObject({ name: 'Critical in production', channel: '#security', enabled: true, emailOwners: false });
    expect(rule.lastThirtyDays).toBeGreaterThanOrEqual(0);
    expect((await call('POST', '/api/alert-rules', { as: 'appsec', body })).status).toBe(409);
    const list = await json<ListAlertRulesResponse>(call('GET', '/api/alert-rules', { as: 'admin' }));
    expect(list.usingDefault).toBe(false);
    const off = await json<AlertRule>(call('PATCH', `/api/alert-rules/${rule.id}`, { as: 'appsec', body: { enabled: false, minLevel: 'high' } }));
    expect(off).toMatchObject({ enabled: false, minLevel: 'high', channel: '#security' });
    expect((await call('POST', '/api/alert-rules/test', { as: 'appsec', body: { channel: '#security' } })).status).toBe(400);
    expect((await call('DELETE', `/api/alert-rules/${rule.id}`, { as: 'auditor' })).status).toBe(403);
    expect((await call('DELETE', `/api/alert-rules/${rule.id}`, { as: 'appsec' })).status).toBe(200);
    expect((await call('DELETE', `/api/alert-rules/${rule.id}`, { as: 'appsec' })).status).toBe(404);
  });
});

describe('the watcher honours stored rules', () => {
  const posts: { text: string; channel?: string }[] = [];
  let hookUrl = '';
  const hook = createHttpServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      posts.push(JSON.parse(body) as { text: string; channel?: string });
      res.end('ok');
    });
  });
  beforeAll(async () => {
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => hook.close(() => r())));

  const purl = (n: string, v: string) => `pkg:npm/${n}@${v}`;
  function setup() {
    const s = openStore({ now: steppingClock() });
    const actor = createUser(s, { email: 'a@x', name: 'A' }).id;
    const orgId = createOrg(s, { name: 'Acme' }, actor).id;
    const projectId = createProject(s, orgId, { name: 'payments', tier: 'Small', target: '/srv/app' }, actor).id;
    const inv: Inventory = {
      assets: [
        { id: 'repo:app', kind: 'repo', name: 'app', environment: 'prod', criticality: 5, sourceFile: 'package.json' },
      ],
      components: [
        { purl: purl('chalk', '5.6.1'), name: 'chalk', version: '5.6.1', ecosystem: 'npm' },
        { purl: purl('karma', '6.0.0'), name: 'karma', version: '6.0.0', ecosystem: 'npm' },
      ],
      edges: [
        { from: 'repo:app', to: purl('chalk', '5.6.1'), scope: 'runtime', direct: true },
        { from: 'repo:app', to: purl('karma', '6.0.0'), scope: 'dev', direct: true },
      ],
    };
    const q = enqueueScan(s, orgId, projectId, { requestedBy: actor, offline: true });
    markScanRunning(s, q.id);
    completeScan(s, q.id, { result: makeResult([{ name: 'lodash', score: 10 }]), inventory: inv });
    return { s, orgId, actor, inv };
  }
  const adv = (id: string, name: string, version: string, severity: string) => ({ id, database_specific: { severity }, affected: [{ package: { name, ecosystem: 'npm' }, versions: [version] }] });

  it('posts only what each enabled rule matches, naming its channel, and records it on the timeline', async () => {
    const { s, orgId, actor } = setup();
    createAlertRule(s, orgId, { name: 'Critical in production', minLevel: 'critical', productionOnly: true, channel: 'security' }, actor);
    createAlertRule(s, orgId, { name: 'Off', minLevel: 'low', channel: 'noise', enabled: false }, actor);
    const w = new AlertWatcher(s, { webhookUrl: hookUrl });
    const r = await w.checkOrg(orgId, { advisories: [adv('GHSA-a', 'chalk', '5.6.1', 'CRITICAL'), adv('GHSA-b', 'karma', '6.0.0', 'CRITICAL'), adv('GHSA-c', 'chalk', '5.6.1', 'LOW')] });
    expect(r.created.map((a) => `${a.advisoryId} ${a.level} ${a.production}`).sort()).toEqual(['GHSA-a critical true', 'GHSA-b critical false', 'GHSA-c low true']);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe('#security');
    expect(posts[0]!.text).toMatch(/chalk@5\.6\.1` \(GHSA-a\)/);
    expect(posts[0]!.text).not.toMatch(/GHSA-b|GHSA-c/);
    expect(posts[0]!.text).toMatch(/_Alert rule: Critical in production_$/);
    expect(incidentEvents(s, orgId, 'GHSA-a').map((e) => e.title)).toEqual(['Slack #security notified']);
    expect(incidentEvents(s, orgId, 'GHSA-b')).toEqual([]);
    expect(listAlertRules(s, orgId)).toHaveLength(2);
  });

  it('matches unknown severities, and production only when asked', () => {
    expect(ruleMatches({ minLevel: 'critical', productionOnly: false }, { level: null, production: false })).toBe(true);
    expect(ruleMatches({ minLevel: 'critical', productionOnly: true }, { level: null, production: false })).toBe(false);
    expect(ruleMatches({ minLevel: 'high', productionOnly: false }, { level: 'medium', production: true })).toBe(false);
    expect(ruleMatches({ minLevel: 'high', productionOnly: false }, { level: 'critical', production: true })).toBe(true);
  });

  it('labels dependency paths with their scopes and introducers', () => {
    const { inv } = setup();
    const p = pathsTo(inv, purl('karma', '6.0.0'));
    expect(p).toEqual([expect.objectContaining({ assetName: 'app', production: false, scopes: ['dev'], nodes: ['repo:app', purl('karma', '6.0.0')] })]);
    expect(viaOf(p[0]!)).toBe('(direct)');
    expect(viaOf({ nodes: ['repo:app', purl('a', '1.0.0'), purl('b', '2.0.0')] })).toBe('a@1.0.0');
    expect(purlLabel('pkg:npm/%40scope/x@1.0.0')).toBe('@scope/x@1.0.0');
  });
});
