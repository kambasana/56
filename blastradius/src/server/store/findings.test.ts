import { describe, expect, it } from 'vitest';
import { listAudit } from './audit.js';
import { createUser } from './auth.js';
import { diffScans } from './changes.js';
import { openStore, StoreError, type Store } from './db.js';
import { exposureMatrix } from './exposure.js';
import {
  deriveFinding,
  fallbackAssetMeta,
  getFindingDetail,
  getFindingRow,
  listFindings,
  parseLevelList,
  parseStatusList,
  updateFindingStatus,
} from './findings.js';
import { createOrg } from './orgs.js';
import { createProject, getProjectRow } from './projects.js';
import { completeScan, enqueueScan } from './scans.js';
import { makeFinding, makeInventory, makeResult, steppingClock, type FindingSpec } from './testing.js';

function setup() {
  const s = openStore({ now: steppingClock() });
  const actor = createUser(s, { email: 'a@x', name: 'A' }).id;
  const orgId = createOrg(s, { name: 'Acme' }, actor).id;
  const otherOrgId = createOrg(s, { name: 'Other' }, null).id;
  const project = createProject(s, orgId, { name: 'app', tier: 'Small', target: '/srv/app' }, actor);
  const scan = (specs: FindingSpec[], projectId = project.id, org = orgId) => {
    const q = enqueueScan(s, org, projectId, { requestedBy: actor });
    return completeScan(s, q.id, { result: makeResult(specs), inventory: makeInventory() });
  };
  return { s, actor, orgId, otherOrgId, project, scan };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof StoreError ? e.code : String(e);
  }
  return 'ok';
};

const SPECS: FindingSpec[] = [
  { name: 'event-stream', version: '3.3.6', score: 95, factors: ['malware', 'entity_incident'], incident: 'INC-2018-0001', assets: { 'repo:app': 1, 'workflow:.github/workflows/ci.yml': 0.5 } },
  { name: '@babel/core', version: '7.24.0', score: 62, factors: ['vuln'] },
  { name: 'left-pad', score: 35, factors: ['single_maintainer', 'abandoned'] },
  { name: 'percent%name', score: 12, factors: ['no_provenance'] },
];

describe('deriveFinding', () => {
  it('denormalises an engine finding', () => {
    const f = makeFinding(SPECS[0]!);
    const d = deriveFinding(f, (id) => (id === 'repo:app' ? { ...fallbackAssetMeta(id), environment: 'prod' } : fallbackAssetMeta(id)));
    expect(d).toMatchObject({
      name: 'event-stream',
      version: '3.3.6',
      ecosystem: 'npm',
      level: 'critical',
      assets: 2,
      prodAssets: 1,
      paths: 2,
      mainReason: { factor: 'malware' },
      factors: ['malware', 'entity_incident'],
      behind: { entityId: 'INC-2018-0001', relation: 'incident', confidence: 1 },
    });
    expect(d.reachText).toMatch(/used by 2 parts of this project \(app, \.github\/workflows\/ci\.yml\) \(1 in production\)$/);
    expect(deriveFinding(makeFinding({ name: '@babel/core', score: 1 })).name).toBe('@babel/core');
    expect(deriveFinding({ ...f, purl: 'garbage' }).name).toBe('garbage');
    expect(fallbackAssetMeta('workflow:x.yml')).toMatchObject({ kind: 'workflow', name: 'x.yml', environment: 'ci' });
  });
});

describe('listFindings', () => {
  it('returns the latest succeeded scan by default, filtered, sorted and paged', () => {
    const { s, orgId, project, scan } = setup();
    expect(listFindings(s, orgId, { projectId: project.id })).toEqual({ items: [], total: 0, nextCursor: null, scan: null });
    const first = scan(SPECS.slice(0, 2));
    const second = scan(SPECS);
    const all = listFindings(s, orgId, { projectId: project.id });
    expect(all.scan?.id).toBe(second.id);
    expect(all.total).toBe(4);
    expect(all.items.map((r) => r.name)).toEqual(['event-stream', '@babel/core', 'left-pad', 'percent%name']);
    expect(all.items[0]).toMatchObject({ reach: { assets: 2, prodAssets: 1, paths: 2 }, status: 'new', ecosystem: 'npm' });
    expect(all.items[0]!.reachText).toMatch(/used by 2 parts of this project/);

    expect(listFindings(s, orgId, { projectId: project.id, scanId: first.id }).total).toBe(2);
    expect(listFindings(s, orgId, { projectId: project.id, levels: ['critical', 'high'] }).total).toBe(2);
    expect(listFindings(s, orgId, { projectId: project.id, sort: 'score' }).items[0]!.name).toBe('percent%name');
    expect(listFindings(s, orgId, { projectId: project.id, sort: 'name' }).items.map((r) => r.name)[0]).toBe('@babel/core');
    expect(listFindings(s, orgId, { projectId: project.id, sort: 'reach' }).items[0]!.name).toBe('event-stream');

    // q matches name, purl and reason detail; LIKE wildcards are literal.
    expect(listFindings(s, orgId, { projectId: project.id, q: 'BABEL' }).total).toBe(1);
    expect(listFindings(s, orgId, { projectId: project.id, q: 'abandoned detail' }).items[0]!.name).toBe('left-pad');
    expect(listFindings(s, orgId, { projectId: project.id, q: '%' }).items.map((r) => r.name)).toEqual(['@babel/core', 'percent%name']); // purl has %40
    expect(listFindings(s, orgId, { projectId: project.id, q: 'left_pad' }).total).toBe(0); // '_' is not a wildcard

    const p1 = listFindings(s, orgId, { projectId: project.id, limit: 3 });
    expect(p1.items).toHaveLength(3);
    const p2 = listFindings(s, orgId, { projectId: project.id, limit: 3, cursor: p1.nextCursor! });
    expect(p2.items.map((r) => r.name)).toEqual(['percent%name']);
    expect(p2.nextCursor).toBeNull();
    expect(listFindings(s, orgId, { projectId: project.id, limit: 2, offset: 1 }).items[0]!.name).toBe('@babel/core');
  });

  it('is org-scoped and validates filters', () => {
    const { s, orgId, otherOrgId, project, scan } = setup();
    const sc = scan(SPECS);
    expect(code(() => listFindings(s, otherOrgId, { projectId: project.id }))).toBe('not_found');
    expect(code(() => listFindings(s, orgId, { projectId: project.id, scanId: 'scan_missing' }))).toBe('not_found');
    const row = listFindings(s, orgId, { projectId: project.id }).items[0]!;
    expect(row.scanId).toBe(sc.id);
    expect(getFindingRow(s, otherOrgId, row.id)).toBeNull();
    expect(getFindingDetail(s, otherOrgId, row.id)).toBeNull();
    expect(parseLevelList('critical, high')).toEqual(['critical', 'high']);
    expect(parseLevelList('')).toBeUndefined();
    expect(code(() => parseLevelList('severe'))).toBe('bad_request');
    expect(parseStatusList('new,accepted_risk')).toEqual(['new', 'accepted_risk']);
    expect(code(() => parseStatusList('closed'))).toBe('bad_request');
  });
});

describe('finding status and detail', () => {
  it('carries status across scans, records history and audit', () => {
    const { s, actor, orgId, otherOrgId, project, scan } = setup();
    scan(SPECS);
    const row = listFindings(s, orgId, { projectId: project.id }).items[0]!;
    expect(code(() => updateFindingStatus(s, otherOrgId, row.id, { status: 'reviewed' }, actor))).toBe('not_found');
    expect(code(() => updateFindingStatus(s, orgId, row.id, { status: 'closed' as never }, actor))).toBe('bad_request');
    const updated = updateFindingStatus(s, orgId, row.id, { status: 'accepted_risk', note: 'pinned and sandboxed' }, actor);
    expect(updated.status).toBe('accepted_risk');
    expect(getProjectRow(s, orgId, project.id)!.toReview).toBe(3);
    expect(listFindings(s, orgId, { projectId: project.id, statuses: ['accepted_risk'] }).items.map((r) => r.id)).toEqual([row.id]);
    expect(listFindings(s, orgId, { projectId: project.id, statuses: ['new'] }).total).toBe(3);

    // A later scan with the same purl inherits the status; firstSeenAt stays at the first scan.
    scan(SPECS);
    const later = listFindings(s, orgId, { projectId: project.id }).items[0]!;
    expect(later.id).not.toBe(row.id);
    expect(later.status).toBe('accepted_risk');
    expect(later.firstSeenAt).toBe(row.firstSeenAt);

    updateFindingStatus(s, orgId, later.id, { status: 'reviewed' }, actor);
    const detail = getFindingDetail(s, orgId, later.id)!;
    expect(detail.statusHistory.map((h) => [h.from, h.to])).toEqual([
      ['accepted_risk', 'reviewed'],
      ['new', 'accepted_risk'],
    ]);
    expect(detail.statusHistory[1]!.note).toBe('pinned and sandboxed');
    expect(detail.history).toEqual([{ scanId: row.scanId, at: expect.any(String), score: 95, level: 'critical' }]);
    expect(detail.assets.map((a) => [a.assetId, a.assetName, a.environment, a.criticality])).toEqual([
      ['repo:app', 'app', 'prod', 5],
      ['workflow:.github/workflows/ci.yml', 'ci', 'ci', 3],
    ]);
    expect(detail.entityChain[0]!.entityId).toBe('INC-2018-0001');
    expect(detail.finding.purl).toBe(later.purl);
    expect(detail.reasons.map((r) => r.factor)).toEqual(['malware', 'entity_incident']);
    expect(listAudit(s, orgId, { action: 'finding.status' }).total).toBe(2);
  });
});

describe('exposure matrix', () => {
  it('builds an asset x component matrix for a project', () => {
    const { s, orgId, otherOrgId, project, scan } = setup();
    expect(exposureMatrix(s, orgId, { projectId: project.id })).toEqual({ axis: 'asset', rows: [], columns: [], cells: [], truncated: false });
    scan(SPECS);
    const m = exposureMatrix(s, orgId, { projectId: project.id });
    expect(m.axis).toBe('asset');
    expect(m.columns.map((c) => c.name)).toEqual(['event-stream', '@babel/core', 'left-pad']); // >= medium
    expect(m.columns[0]!.reach).toBe(2);
    expect(m.rows.map((r) => r.key)).toEqual(['repo:app', 'workflow:.github/workflows/ci.yml']);
    expect(m.rows[0]).toMatchObject({ label: 'app', environment: 'prod', criticality: 5 });
    expect(m.cells).toContainEqual({ row: 1, col: 0, exposure: 0.5, pathCount: 1 });
    expect(m.cells.filter((c) => c.row === 0)).toHaveLength(3);
    expect(exposureMatrix(s, orgId, { projectId: project.id, minLevel: 'low' }).columns).toHaveLength(4);
    const cut = exposureMatrix(s, orgId, { projectId: project.id, limit: 1 });
    expect(cut.columns).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    expect(code(() => exposureMatrix(s, otherOrgId, { projectId: project.id }))).toBe('not_found');
    expect(code(() => exposureMatrix(s, orgId, { minLevel: 'severe' as never }))).toBe('bad_request');
  });

  it('builds a project x component matrix org-wide', () => {
    const { s, actor, orgId, project, scan } = setup();
    const p2 = createProject(s, orgId, { name: 'api', tier: 'Small', target: '/srv/api' }, actor);
    scan(SPECS);
    scan([{ name: 'event-stream', version: '3.3.6', score: 90, factors: ['malware'] }, { name: 'only-api', score: 70 }], p2.id);
    const m = exposureMatrix(s, orgId);
    expect(m.axis).toBe('project');
    expect(m.rows.map((r) => r.label).sort()).toEqual(['api', 'app']);
    const es = m.columns.findIndex((c) => c.name === 'event-stream');
    expect(m.columns[es]).toMatchObject({ score: 95, projectId: project.id, reach: 2 });
    expect(m.cells.filter((c) => c.col === es)).toHaveLength(2);
    expect(exposureMatrix(s, orgId, { projectIds: [p2.id] }).rows.map((r) => r.label)).toEqual(['api']);
  });
});

describe('changes', () => {
  it('diffs the two latest succeeded scans by purl', () => {
    const { s, orgId, otherOrgId, project, scan } = setup();
    expect(diffScans(s, orgId, project.id)).toMatchObject({ fromScan: null, toScan: null, items: [] });
    const a = scan([
      { name: 'stays', score: 40, factors: ['vuln'] },
      { name: 'rises', score: 40 },
      { name: 'falls', score: 70 },
      { name: 'gone', score: 50 },
      { name: 'bumped', version: '1.0.0', score: 50 },
    ]);
    const only = diffScans(s, orgId, project.id);
    expect(only.fromScan).toBeNull();
    expect(only.counts.new_finding).toBe(5);

    const b = scan([
      { name: 'stays', score: 45, factors: ['vuln', 'maintainer_change'] },
      { name: 'rises', score: 85, factors: ['vuln', 'malware'] },
      { name: 'falls', score: 20 },
      { name: 'bumped', version: '1.0.1', score: 50 },
      { name: 'fresh', score: 61 },
    ]);
    const d = diffScans(s, orgId, project.id);
    expect(d.fromScan?.id).toBe(a.id);
    expect(d.toScan?.id).toBe(b.id);
    expect(d.counts).toEqual({ new_finding: 2, resolved: 2, risk_up: 1, risk_down: 1, new_reason: 1 });
    const byId = new Map(d.items.map((c) => [c.id, c]));
    const up = d.items.find((c) => c.type === 'risk_up')!;
    expect(up).toMatchObject({ name: 'rises', from: { level: 'medium' }, to: { level: 'critical' }, addedFactors: ['malware'] });
    expect(up.detail).toContain('Risk rose from medium (40) to critical (85)');
    expect(d.items.find((c) => c.type === 'new_reason')).toMatchObject({ name: 'stays', addedFactors: ['maintainer_change'] });
    expect(byId.get('resolved:pkg:npm/gone@1.0.0')).toMatchObject({ to: null, findingId: null });
    expect(byId.has('resolved:pkg:npm/bumped@1.0.0')).toBe(true);
    expect(byId.get('new_finding:pkg:npm/bumped@1.0.1')?.findingId).toMatch(/^fnd_/);
    // Ordered by change type.
    expect(d.items.map((c) => c.type)).toEqual(['new_finding', 'new_finding', 'resolved', 'resolved', 'risk_up', 'risk_down', 'new_reason']);

    // Explicit scans, reversed direction, same-scan and cross-org errors.
    const rev = diffScans(s, orgId, project.id, { from: b.id, to: a.id });
    expect(rev.counts.resolved).toBe(2);
    expect(diffScans(s, orgId, project.id, { to: a.id }).fromScan).toBeNull();
    expect(diffScans(s, orgId, project.id, { to: b.id }).fromScan?.id).toBe(a.id);
    expect(code(() => diffScans(s, orgId, project.id, { from: b.id, to: b.id }))).toBe('bad_request');
    expect(code(() => diffScans(s, otherOrgId, project.id))).toBe('not_found');
    expect(code(() => diffScans(s, orgId, project.id, { from: 'scan_nope' }))).toBe('not_found');
  });
});
