/**
 * Alerts and incidents over time: a re-mark raises existing alert levels (never lowers them), a
 * closed incident leaves the Overview banner and reopens on a new alert, and the Incidents list
 * aggregates every alert (no 5000-row cut-off). Offline fixture server, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import type { MarkCompromisedResponse } from './api-types-accounts.js';
import type { IncidentDetail, ListIncidentsResponse } from './api-types-incidents.js';
import type { MeResponse, OverviewResponse } from './api-types.js';
import { listIncidents } from './incidents.js';
import { createServer, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from './serve.js';
import { createOrg, createProject, createUser, completeScan, enqueueScan, incidentStates, openStore, recordAlerts, run, setIncidentStatus, tx } from './store/index.js';
import { makeInventory, makeResult, steppingClock } from './store/testing.js';

type App = ReturnType<typeof createServer>;
let srv: App;
let token = '';
let orgId = '';
const ID = 'ACCOUNT-npm-right9ctrl';

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `br_session=${token}`, ...(method !== 'GET' ? { 'X-Requested-With': 'blastradius' } : {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return srv.app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const json = async <T>(r: Promise<Response>): Promise<T> => (await (await r).json()) as T;
const incidentRow = async () => (await json<ListIncidentsResponse>(call('GET', '/api/incidents'))).items.find((i) => i.id === ID);

beforeAll(async () => {
  const offline = new HttpClient({
    offline: true,
    fixturesDir: FIXTURES_DIR,
    cacheDir: false,
    minIntervalMs: 0,
    transport: async (req) => {
      throw new Error(`network access attempted in test: ${req.url}`);
    },
  });
  srv = createServer({
    devMode: true,
    localRoots: [],
    offline: true,
    fixturesDir: FIXTURES_DIR,
    asOf: FIXTURE_AS_OF,
    webDir: null,
    scanOptions: { http: offline, cacheDir: false },
    alerts: { packPath: undefined, webhookUrl: undefined },
    log: () => {},
  });
  const seed = await seedDevData(srv.deps);
  await srv.jobs.waitFor(seed.scanId!);
  await srv.deps.accounts.idle();
  const res = await srv.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'X-Requested-With': 'blastradius', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@local', password: 'blastradius-dev' }),
  });
  token = /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  orgId = (await json<MeResponse>(call('GET', '/api/me'))).org!.id;
}, 60_000);

afterAll(() => srv.jobs.stop());

describe('account incident updates', () => {
  it('raises existing alerts to critical when re-marked with a window, and never lowers them', async () => {
    const first = await json<MarkCompromisedResponse>(call('POST', '/api/accounts/npm/right9ctrl/compromise', {}));
    expect(first).toMatchObject({ incidentId: ID, created: true, added: 1, raised: 0 });
    expect((await incidentRow())?.level).toBe('high');

    // event-stream 3.3.6 was published by right9ctrl inside this window: now the likely bad release.
    const update = await json<MarkCompromisedResponse>(call('POST', '/api/accounts/npm/right9ctrl/compromise', { since: '2018-09-01T00:00:00Z' }));
    expect(update).toMatchObject({ incidentId: ID, created: false, added: 0, raised: 1 });
    expect(update.exposure.incident).toMatchObject({ id: ID, since: '2018-09-01T00:00:00.000Z' });
    expect((await incidentRow())?.level).toBe('critical');

    // Dropping the window again does not downgrade what was raised.
    const again = await json<MarkCompromisedResponse>(call('POST', '/api/accounts/npm/right9ctrl/compromise', {}));
    expect(again).toMatchObject({ added: 0, raised: 0 });
    expect((await incidentRow())?.level).toBe('critical');
  });
});

describe('closed incidents', () => {
  it('leave the Overview banner, and a new alert reopens them with a timeline event', async () => {
    const banner = async () => (await json<OverviewResponse>(call('GET', '/api/overview?range=all'))).incident;
    expect((await banner())?.advisoryId).toBe(ID);

    expect((await call('PATCH', `/api/incidents/${ID}`, { status: 'closed' })).status).toBe(200);
    expect((await incidentRow())?.status).toBe('closed');
    expect((await incidentRow())?.closedAt).toEqual(expect.any(String));
    expect(await banner()).toBeNull();

    // A re-check that only re-confirms existing alerts does not reopen it.
    await call('POST', '/api/accounts/npm/right9ctrl/compromise', { since: '2018-09-01T00:00:00Z' });
    expect((await incidentRow())?.status).toBe('closed');

    // A new exposure (another package in the project) does.
    const projectId = (await json<IncidentDetail>(call('GET', `/api/incidents/${ID}`))).hits[0]!.projectId;
    const created = recordAlerts(srv.store, orgId, [
      { projectId, projectName: 'payments-platform', purl: 'pkg:npm/flatmap-stream@0.1.1', name: 'flatmap-stream', version: '0.1.1', advisoryId: ID, level: 'high', production: true, reachText: 'Brought in by event-stream', assets: [] },
    ]).created;
    expect(created).toHaveLength(1);
    const row = await incidentRow();
    expect(row).toMatchObject({ status: 'investigating', closedAt: null });
    const d = await json<IncidentDetail>(call('GET', `/api/incidents/${ID}`));
    const reopened = d.timeline.filter((e) => e.kind === 'status').at(-1)!;
    expect(reopened).toMatchObject({ from: 'closed', to: 'investigating', title: 'Reopened: a new alert arrived after it was closed' });
    expect(reopened.detail).toContain('flatmap-stream@0.1.1 in payments-platform');
    expect((await banner())?.advisoryId).toBe(ID);
  });
});

describe('incident list aggregation', () => {
  it('keeps every incident and its full counts past 5000 alerts, with close times in one pass', () => {
    const s = openStore({ now: steppingClock() });
    const actor = createUser(s, { email: 'a@x', name: 'A' }).id;
    const org = createOrg(s, { name: 'Big' }, actor).id;
    const p1 = createProject(s, org, { name: 'one', tier: 'Small', target: '/srv/one' }, actor);
    const p2 = createProject(s, org, { name: 'two', tier: 'Small', target: '/srv/two' }, actor);
    const inv = { ...makeInventory(), components: [{ purl: 'pkg:npm/old@1.0.0', name: 'old', version: '1.0.0', ecosystem: 'npm' }] } as unknown as ReturnType<typeof makeInventory>;
    completeScan(s, enqueueScan(s, org, p1.id, { requestedBy: actor }).id, { result: makeResult([]), inventory: inv });
    // The oldest incident: one alert in each project; "old" is still in p1's latest inventory.
    recordAlerts(s, org, [
      { projectId: p1.id, projectName: 'one', purl: 'pkg:npm/old@1.0.0', name: 'old', version: '1.0.0', advisoryId: 'GHSA-old', level: 'medium', production: true, reachText: 'r', assets: [] },
      { projectId: p2.id, projectName: 'two', purl: 'pkg:npm/old@1.0.0', name: 'old', version: '1.0.0', advisoryId: 'GHSA-old', production: false, reachText: 'r', assets: [] },
    ]);
    setIncidentStatus(s, org, 'GHSA-old', 'closed', { id: actor, name: 'A' });
    // 5200 newer alerts of another advisory.
    tx(s, () => {
      for (let i = 0; i < 5200; i++) {
        run(
          s,
          `INSERT INTO alert (id, org_id, project_id, scan_id, purl, advisory_id, production, reach_text, created_at, level) VALUES (?, ?, ?, NULL, ?, 'GHSA-big', 0, 'r', ?, 'low')`,
          `alr_big_${i}`,
          org,
          i % 2 ? p1.id : p2.id,
          `pkg:npm/big-${i}@1.0.0`,
          `2026-06-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        );
      }
    });
    const rows = listIncidents({ store: s, orgId: org, projectIds: null });
    expect(rows.map((r) => r.id)).toEqual(['GHSA-big', 'GHSA-old']);
    const [big, old] = rows as [(typeof rows)[number], (typeof rows)[number]];
    expect(big).toMatchObject({ affected: 2, level: 'low', status: 'investigating', fixed: 2 });
    expect(big.packages).toHaveLength(5200);
    expect(old).toMatchObject({ affected: 2, production: 1, fixed: 1, level: 'medium', status: 'closed', projects: ['one', 'two'] });
    expect(old.closedAt).toEqual(expect.any(String));
    expect(incidentStates(s, org).get('GHSA-old')?.status).toBe('closed');
    // Scoped to one project: only what that project sees.
    const mine = listIncidents({ store: s, orgId: org, projectIds: [p1.id] });
    expect(mine.find((r) => r.id === 'GHSA-big')?.packages).toHaveLength(2600);
    expect(mine.find((r) => r.id === 'GHSA-old')).toMatchObject({ affected: 1, fixed: 0 });
  });
});
