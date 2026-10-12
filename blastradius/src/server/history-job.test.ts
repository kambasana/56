/**
 * Tier 0: git history in the web runs as a background job after an online scan, so the exposure
 * answer is stored first and the stability labels then match `scan --history`. Replayed offline:
 * the e2e fixture repo with recorded npm packuments and the recorded event-stream history.
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HttpClient } from '../core/http.js';
import { recordedHistories } from '../history/fixture.js';
import { createServer, E2E_REPO_DIR, FIXTURE_AS_OF, FIXTURES_DIR } from './serve.js';
import { createProject, enqueueScan, getScanResult, seedDev } from './store/index.js';

const srv = createServer({
  devMode: true,
  offline: false,
  asOf: FIXTURE_AS_OF,
  webDir: null,
  history: { recorded: recordedHistories(join(FIXTURES_DIR, 'history', 'recorded')) },
  scanOptions: {
    http: new HttpClient({ offline: true, fixturesDir: FIXTURES_DIR, cacheDir: false, minIntervalMs: 0, transport: async (r) => Promise.reject(new Error(`network in test: ${r.url}`)) }),
    cacheDir: false,
  },
  log: () => {},
});
afterAll(() => srv.jobs.stop());

describe('background git history (web)', () => {
  it('stores the scan first with history pending, then attaches the history and the same labels as the CLI', async () => {
    const seeded = await seedDev(srv.deps.store, { devMode: true });
    const admin = seeded.users.find((u) => u.role === 'org_admin')!;
    srv.deps.config.localRoots.push(E2E_REPO_DIR);
    const project = createProject(srv.deps.store, seeded.org.id, { name: 'history-job', tier: 'Standard', target: E2E_REPO_DIR, owner: 'test' }, admin.id);
    const scan = enqueueScan(srv.deps.store, seeded.org.id, project.id, { requestedBy: admin.id, offline: false });
    srv.jobs.kick();
    await srv.jobs.waitFor(scan.id);
    const first = getScanResult(srv.deps.store, seeded.org.id, scan.id)!.result;
    expect(first.findings.length).toBeGreaterThan(0);
    expect(first.stability!.historyStatus).toBe('pending');
    expect(first.history).toBeUndefined();
    await srv.jobs.historyIdle();
    const after = getScanResult(srv.deps.store, seeded.org.id, scan.id)!.result;
    expect(after.stability!.historyStatus).toBe('done');
    expect(after.history!.repos.map((r) => r.repo)).toContain('https://github.com/dominictarr/event-stream');
    const es = after.stability!.packages.find((p) => p.name === 'event-stream')!;
    expect(es.basis).toBe('git');
    expect(after.stability!.coverage!.line).toMatch(/^Upkeep assessed for \d+ of \d+ \(git history \d+/);
    // Findings are the scan's own: history never changes them.
    expect(after.findings).toEqual(first.findings);
  });
});
