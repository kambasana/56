/**
 * Stability labels through the API (docs/WHO-BEHIND-PLAN.md §4, P3): the dev-seed scan of the e2e
 * fixture repo, replayed offline as of 2018-11-27 with the recorded npm packuments and the P2
 * event-stream history. Maintenance tab (GET /api/projects/:id/stability), Changes page
 * (continuity rows) and Package page (reach response), permissions, and no effect on findings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import type { ChangesResponse, ProjectStabilityResponse } from './api-types.js';
import type { PackageReachResponse } from './api-types-incidents.js';
import type { ScanResult } from '../core/types.js';
import { createServer, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from './serve.js';
import { get, getScanResult } from './store/index.js';

type App = ReturnType<typeof createServer>;

let srv: App;
let projectId: string;
let scanId: string;
const cookies: Record<string, string> = {};

async function call(path: string, as?: string): Promise<Response> {
  return srv.app.request(path, { method: 'GET', headers: as ? { Cookie: `br_session=${cookies[as]}` } : {} });
}

beforeAll(async () => {
  srv = createServer({
    devMode: true,
    offline: true,
    fixturesDir: FIXTURES_DIR,
    asOf: FIXTURE_AS_OF,
    webDir: null,
    scanOptions: {
      http: new HttpClient({ offline: true, fixturesDir: FIXTURES_DIR, cacheDir: false, minIntervalMs: 0, transport: async (r) => Promise.reject(new Error(`network in test: ${r.url}`)) }),
      cacheDir: false,
    },
    log: () => {},
  });
  const seed = await seedDevData(srv.deps);
  projectId = seed.projectId;
  scanId = seed.scanId!;
  await srv.jobs.waitFor(scanId);
  for (const u of ['appsec', 'developer']) {
    const res = await srv.app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'blastradius' }, body: JSON.stringify({ email: `${u}@local`, password: 'blastradius-dev' }) });
    expect(res.status).toBe(200);
    cookies[u] = /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  }
}, 60_000);

afterAll(() => srv.jobs.stop());

describe('stability in the stored scan', () => {
  it('labels every npm package; event-stream is Watch from replayed history; findings are unchanged by it', () => {
    const orgId = get<{ org_id: string }>(srv.store, 'SELECT org_id FROM scan WHERE id = ?', scanId)!.org_id;
    const result: ScanResult = getScanResult(srv.store, orgId, scanId)!.result;
    const s = result.stability!;
    expect(s.asOf).toBe(FIXTURE_AS_OF.toISOString());
    expect(s.packages.map((p) => p.name).sort()).toEqual(['duplexer', 'event-stream', 'flatmap-stream', 'from', 'map-stream', 'ms', 'pause-stream', 'split', 'stream-combiner', 'through']);
    const es = s.packages.find((p) => p.name === 'event-stream')!;
    expect(es).toMatchObject({ label: 'watch', production: true, funding: 'not_assessed' });
    expect(es.rules.map((r) => r.rule)).toEqual(expect.arrayContaining(['watch_single_contributor', 'watch_release_continuity']));
    // Packages without a recorded history say what is missing.
    expect(s.packages.find((p) => p.name === 'ms')).toMatchObject({ label: 'unknown' });
    expect(s.packages.find((p) => p.name === 'ms')!.missing[0]).toMatch(/git history of .* was not read/);
    // Stability is not risk: no finding reason comes from it.
    for (const f of result.findings) for (const r of f.reasons) expect(r.factor).not.toMatch(/stability|fragile|watch/i);
  });
});

describe('GET /api/projects/:id/stability (Maintenance tab)', () => {
  it('returns the newest scan’s labels with counts and the disclaimer', async () => {
    const res = await call(`/api/projects/${projectId}/stability`, 'appsec');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectStabilityResponse;
    expect(body.scanId).toBe(scanId);
    expect(body.funding).toBe('not_assessed');
    expect(body.disclaimer).toMatch(/not a security verdict/);
    expect(body.counts!.watch).toBeGreaterThanOrEqual(1);
    expect(body.entries!.length).toBe(10);
    expect(JSON.stringify(body)).not.toContain('hash:');
  });
  it('needs a session and the findings permission on the project', async () => {
    expect((await call(`/api/projects/${projectId}/stability`)).status).toBe(401);
    expect((await call(`/api/projects/${projectId}/stability`, 'developer')).status).toBe(200);
  });
});

describe('Changes and Package pages', () => {
  it('the Changes response lists S5a observations of the last 12 months (first scan: none marked new)', async () => {
    const body = (await (await call(`/api/changes?project=${projectId}`, 'appsec')).json()) as ChangesResponse;
    const rows = body.continuity!;
    expect(rows.some((r) => r.name === 'event-stream' && r.kind === 'release_by_new_person' && r.release === '3.3.5')).toBe(true);
    expect(rows.every((r) => r.isNew === false && r.date > '2017-11-27')).toBe(true);
  });
  it('the Package reach response carries the label from the newest scan', async () => {
    const body = (await (await call('/api/packages/reach?name=event-stream', 'appsec')).json()) as PackageReachResponse;
    expect(body.stability).toMatchObject({ projectId, scanId, entry: { name: 'event-stream', label: 'watch' } });
    const none = (await (await call('/api/packages/reach?name=left-pad', 'appsec')).json()) as PackageReachResponse;
    expect(none.stability).toBeNull();
  });
});
