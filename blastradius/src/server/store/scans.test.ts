import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listAudit } from './audit.js';
import { createUser } from './auth.js';
import { all, openStore, StoreError, type Store } from './db.js';
import { createOrg } from './orgs.js';
import {
  classifyTarget,
  createProject,
  deleteProject,
  effectiveTierSettings,
  getProject,
  getProjectRow,
  listProjects,
  orgHome,
  updateProject,
} from './projects.js';
import {
  completeScan,
  enqueueScan,
  failInterruptedScans,
  failScan,
  getScan,
  getScanInventory,
  getScanResult,
  listQueuedScans,
  listReports,
  listScans,
  markScanRunning,
  setScanCommit,
} from './scans.js';
import { makeInventory, makeResult, steppingClock } from './testing.js';

function setup(): { s: Store; actor: string; orgId: string; otherOrgId: string } {
  const s = openStore({ now: steppingClock() });
  const actor = createUser(s, { email: 'a@x', name: 'A' }).id;
  const orgId = createOrg(s, { name: 'Acme' }, actor).id;
  const otherOrgId = createOrg(s, { name: 'Other' }, null).id;
  return { s, actor, orgId, otherOrgId };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof StoreError ? e.code : String(e);
  }
  return 'ok';
};

describe('projects', () => {
  it('creates, validates, updates and deletes', () => {
    const { s, actor, orgId, otherOrgId } = setup();
    const p = createProject(s, orgId, { name: 'web', tier: 'Standard', target: 'https://github.com/acme/web', owner: 'Payments' }, actor);
    expect(p).toMatchObject({ name: 'web', tier: 'Standard', target: 'https://github.com/acme/web', owner: 'Payments', tierOverrides: {} });
    expect(classifyTarget(p.target)).toBe('git');
    expect(classifyTarget('/srv/web')).toBe('local');
    expect(code(() => createProject(s, orgId, { name: 'web', tier: 'Small', target: '/x' }, actor))).toBe('conflict');
    expect(code(() => createProject(s, orgId, { name: 'x', tier: 'Huge' as never, target: '/x' }, actor))).toBe('bad_request');
    expect(code(() => createProject(s, orgId, { name: 'x', tier: 'Small', target: 'a\u0000b' }, actor))).toBe('bad_request');
    expect(code(() => createProject(s, orgId, { name: 'x', tier: 'Small', target: '/x', tierOverrides: { graphNodeCap: -1 } }, actor))).toBe('bad_request');
    expect(code(() => createProject(s, orgId, { name: 'x', tier: 'Small', target: '/x', tierOverrides: { evil: 1 } as never }, actor))).toBe('bad_request');
    // Same name in another org is fine; cross-org reads are null.
    createProject(s, otherOrgId, { name: 'web', tier: 'Small', target: '/x' }, actor);
    expect(getProject(s, otherOrgId, p.id)).toBeNull();

    const u = updateProject(s, orgId, p.id, { tier: 'Large', tierOverrides: { graphNodeCap: 99, dependencyDepth: null } }, actor);
    expect(u.tier).toBe('Large');
    expect(effectiveTierSettings(u)).toMatchObject({ graphNodeCap: 99, dependencyDepth: null, includeDevDependencies: false, retentionDays: 730 });
    expect(listProjects(s, orgId).map((x) => x.name)).toEqual(['web']);
    expect(code(() => updateProject(s, otherOrgId, p.id, { name: 'x' }, actor))).toBe('not_found');

    enqueueScan(s, orgId, p.id, { requestedBy: actor });
    expect(code(() => deleteProject(s, orgId, p.id, actor))).toBe('conflict');
    failInterruptedScans(s);
    deleteProject(s, orgId, p.id, actor);
    expect(getProject(s, orgId, p.id)).toBeNull();
    expect(all(s, 'SELECT * FROM scan WHERE project_id = ?', p.id)).toHaveLength(0);
    const actions = listAudit(s, orgId, { limit: 50 }).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['project.create', 'project.update', 'project.delete', 'scan.create']));
  });
});

describe('scans', () => {
  it('runs the lifecycle and stores result, hash, summary and rows', () => {
    const { s, actor, orgId, otherOrgId } = setup();
    const p = createProject(s, orgId, { name: 'app', tier: 'Small', target: '/srv/app' }, actor);
    const q = enqueueScan(s, orgId, p.id, { requestedBy: actor, offline: true });
    expect(q).toMatchObject({ status: 'queued', target: '/srv/app', offline: true, summary: null, startedAt: null });
    expect(code(() => enqueueScan(s, orgId, p.id, { requestedBy: actor }))).toBe('conflict');
    expect(code(() => enqueueScan(s, otherOrgId, p.id, { requestedBy: actor }))).toBe('not_found');
    expect(listQueuedScans(s).map((x) => x.id)).toEqual([q.id]);

    expect(markScanRunning(s, q.id).status).toBe('running');
    expect(code(() => markScanRunning(s, q.id))).toBe('conflict');
    const result = makeResult([
      { name: 'evil', score: 92, factors: ['malware'] },
      { name: 'lodash', score: 40 },
    ]);
    const done = completeScan(s, q.id, { result, inventory: makeInventory(), commit: 'abc1234' });
    expect(done.status).toBe('succeeded');
    expect(done.commit).toBe('abc1234');
    expect(done.schemaVersion).toBe('1');
    expect(done.summary).toMatchObject({ findings: 2, counts: { critical: 1, high: 0, medium: 1, low: 0 } });
    expect(code(() => completeScan(s, q.id, { result }))).toBe('conflict');

    const stored = getScanResult(s, orgId, q.id)!;
    expect(stored.result).toEqual(result);
    expect(stored.sha256).toBe(createHash('sha256').update(JSON.stringify(result)).digest('hex'));
    expect(getScanResult(s, otherOrgId, q.id)).toBeNull();
    expect(getScanInventory(s, orgId, q.id)?.assets).toHaveLength(2);
    expect(getScan(s, otherOrgId, q.id)).toBeNull();

    // Next scan can be queued; failures store a one-line error.
    const q2 = enqueueScan(s, orgId, p.id, { requestedBy: actor });
    const f = failScan(s, q2.id, 'clone failed:\n  timeout');
    expect(f).toMatchObject({ status: 'failed', error: 'clone failed: timeout', summary: null });
    expect(listScans(s, orgId, p.id).items.map((x) => x.id)).toEqual([q2.id, q.id]);
    expect(code(() => setScanCommit(s, q2.id, 'not-a-sha; rm -rf'))).toBe('bad_request');
  });

  it('fails interrupted scans on restart', () => {
    const { s, actor, orgId } = setup();
    const p = createProject(s, orgId, { name: 'app', tier: 'Small', target: '/srv/app' }, actor);
    const q = enqueueScan(s, orgId, p.id, { requestedBy: actor });
    expect(failInterruptedScans(s)).toBe(1);
    expect(getScan(s, orgId, q.id)?.status).toBe('failed');
  });

  it('builds project rows, org home and reports', () => {
    const { s, actor, orgId } = setup();
    const p = createProject(s, orgId, { name: 'app', tier: 'Small', target: '/srv/app' }, actor);
    const scanWith = (specs: Parameters<typeof makeResult>[0]) => {
      const q = enqueueScan(s, orgId, p.id, { requestedBy: actor });
      return completeScan(s, q.id, { result: makeResult(specs), inventory: makeInventory() });
    };
    expect(getProjectRow(s, orgId, p.id)).toMatchObject({ lastScan: null, assets: 0, trend: [], toReview: 0 });
    const s1 = scanWith([{ name: 'a', score: 85 }]);
    const s2 = scanWith([
      { name: 'a', score: 85 },
      { name: 'b', score: 65 },
      { name: 'c', score: 10 },
    ]);
    const failed = enqueueScan(s, orgId, p.id, { requestedBy: actor });
    failScan(s, failed.id, 'x');

    const row = getProjectRow(s, orgId, p.id)!;
    expect(row.lastScan?.id).toBe(failed.id);
    expect(row.assets).toBe(2);
    expect(row.components).toBe(3);
    expect(row.counts).toEqual({ critical: 1, high: 1, medium: 0, low: 1 });
    expect(row.trend).toEqual([1, 2]);
    expect(row.toReview).toBe(3);

    const home = orgHome(s, orgId);
    expect(home.totals).toMatchObject({ projects: 1, assets: 2, components: 3, toReview: 3 });
    expect(home.recentScans.map((x) => x.id)).toEqual([failed.id, s2.id, s1.id]);
    expect(orgHome(s, orgId, []).totals.projects).toBe(0);

    const reports = listReports(s, orgId, { limit: 1 });
    expect(reports.total).toBe(2);
    expect(reports.items[0]).toMatchObject({ scanId: s2.id, project: { id: p.id, name: 'app' }, counts: { critical: 1 } });
    expect(reports.items[0]!.downloads).toEqual({
      html: `/api/reports/${s2.id}.html`,
      json: `/api/reports/${s2.id}.json`,
      sarif: `/api/reports/${s2.id}.sarif`,
    });
    expect(reports.items[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const page2 = listReports(s, orgId, { limit: 1, cursor: reports.nextCursor! });
    expect(page2.items[0]!.scanId).toBe(s1.id);
    expect(page2.nextCursor).toBeNull();
    expect(listReports(s, orgId, { projectIds: [] }).total).toBe(0);
  });
});
