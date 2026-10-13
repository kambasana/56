/** /api/findings, /api/exposure, /api/changes, /api/graph, /api/investigate/* */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Finding, RiskLevel } from '../../core/types.js';
import type {
  ChangesResponse,
  ExposureMatrixResponse,
  GetFindingResponse,
  GraphResponse,
  InvestigateNodeResponse,
  InvestigateSearchResponse,
  ListFindingsResponse,
  Project,
  UpdateFindingStatusResponse,
} from '../api-types.js';
import { deps, requireOrg, requireProjectPerm, visibleProjects, type AppEnv, type Ctx } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { findingGraph, investigateNode, investigateSearch, nodeGraph, type ScanFindingSet } from '../graph.js';
import { idParam, pageQuery, parseBody, queryInt, queryString } from '../request.js';
import { listOrgFindingsHandler, TriageFields } from './triage.js';
import {
  all,
  diffScans,
  effectiveTierSettings,
  exposureMatrix,
  getEngineFinding,
  getFindingDetail,
  getFindingRow,
  getScanInventory,
  introducedByOf,
  isRiskLevel,
  listAlertsFor,
  packageSpread,
  latestSucceededScan,
  listFindings,
  listProjects,
  parseJson,
  parseLevelList,
  parseStatusList,
  scanAssets,
  triagePermission,
  updateFindingStatus,
  type FindingSort,
  type Store,
} from '../store/index.js';

const SORTS: readonly FindingSort[] = ['score', '-score', 'name', 'reach'];

const UpdateStatusBody = z.strictObject(TriageFields);

/** Engine findings + metadata of one scan, for graphs and Investigate. */
export function loadScanSet(store: Store, orgId: string, project: Pick<Project, 'id' | 'name'>, scanId: string): ScanFindingSet {
  const rows = all<{ id: string; purl: string; finding_json: string }>(
    store,
    'SELECT id, purl, finding_json FROM finding WHERE scan_id = ? AND org_id = ? ORDER BY ord',
    scanId,
    orgId,
  );
  const findings: Finding[] = [];
  const findingIds = new Map<string, string>();
  for (const r of rows) {
    const f = parseJson<Finding | null>(r.finding_json, null);
    if (!f) continue;
    findings.push(f);
    findingIds.set(f.purl, r.id);
  }
  return {
    projectId: project.id,
    projectName: project.name,
    findings,
    findingIds,
    inventory: getScanInventory(store, orgId, scanId),
    assetNames: new Map(scanAssets(store, scanId).map((a) => [a.id, a.name] as const)),
  };
}

function latestSet(c: Ctx, orgId: string, project: Project): ScanFindingSet | null {
  const scan = latestSucceededScan(deps(c).store, project.id);
  return scan ? loadScanSet(deps(c).store, orgId, project, scan.id) : null;
}

function nodeParam(c: Ctx, name: string): string {
  const v = queryString(c, name, 512);
  if (!v) throw badRequest(`${name} is required`, [name]);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw badRequest(`Invalid ${name}`, [name]);
  return v;
}

export function registerFindingRoutes(app: Hono<AppEnv>): void {
  app.get('/api/findings', (c) => {
    const projectId = queryString(c, 'project', 100);
    // No project: every project the caller may read findings in (docs/WEB-API.md).
    if (projectId === undefined) return listOrgFindingsHandler(c);
    const { orgId } = requireProjectPerm(c, projectId, 'findings');
    const sort = queryString(c, 'sort', 10);
    if (sort !== undefined && !(SORTS as readonly string[]).includes(sort)) throw badRequest('Unknown sort', ['sort']);
    const scanId = queryString(c, 'scan', 100);
    const levels = parseLevelList(queryString(c, 'level', 100));
    const statuses = parseStatusList(queryString(c, 'status', 100));
    const q = queryString(c, 'q', 200);
    const res = listFindings(deps(c).store, orgId, {
      projectId: projectId!,
      ...(scanId !== undefined ? { scanId } : {}),
      ...(levels ? { levels } : {}),
      ...(statuses ? { statuses } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(sort !== undefined ? { sort: sort as FindingSort } : {}),
      ...pageQuery(c),
    });
    return c.json<ListFindingsResponse>(res);
  });

  app.get('/api/findings/:id', (c) => {
    const id = idParam(c, 'id');
    const { orgId } = requireOrg(c);
    const row = getFindingRow(deps(c).store, orgId, id);
    if (!row) throw notFound('Finding not found');
    const { project } = requireProjectPerm(c, row.projectId, 'findings');
    const { store } = deps(c);
    const detail = getFindingDetail(store, orgId, id);
    if (!detail) throw notFound('Finding not found');
    const { projectIds } = visibleProjects(c, 'findings');
    return c.json<GetFindingResponse>({
      ...detail,
      projectName: project.name,
      introducedBy: introducedByOf(detail.finding),
      alerts: listAlertsFor(store, orgId, row.projectId, row.purl),
      spread: packageSpread(store, orgId, projectIds, row.purl),
    });
  });

  app.patch('/api/findings/:id', async (c) => {
    const id = idParam(c, 'id');
    const { orgId, session } = requireOrg(c);
    const row = getFindingRow(deps(c).store, orgId, id);
    if (!row) throw notFound('Finding not found');
    const body = await parseBody(c, UpdateStatusBody);
    if (body.status === undefined && body.ownerId === undefined) throw badRequest('Nothing to change: give status or ownerId', ['status']);
    // Moving into or out of accepted_risk, or changing its expiry, needs accept_risk: a review-only
    // user must not be able to undo or extend someone else's risk acceptance.
    requireProjectPerm(c, row.projectId, triagePermission(body, row.status));
    const updated = updateFindingStatus(deps(c).store, orgId, id, body, session.user.id);
    return c.json<UpdateFindingStatusResponse>(updated);
  });

  app.get('/api/exposure', (c) => {
    const projectId = queryString(c, 'project', 100);
    const minLevel = queryString(c, 'minLevel', 10);
    if (minLevel !== undefined && !isRiskLevel(minLevel)) throw badRequest('Unknown level', ['minLevel']);
    const limit = queryInt(c, 'limit', 1, 200);
    const opts = { ...(minLevel ? { minLevel: minLevel as RiskLevel } : {}), ...(limit !== undefined ? { limit } : {}) };
    if (projectId !== undefined) {
      const { orgId } = requireProjectPerm(c, projectId, 'exposure');
      return c.json<ExposureMatrixResponse>(exposureMatrix(deps(c).store, orgId, { ...opts, projectId }));
    }
    const { orgId, projectIds } = visibleProjects(c, 'exposure');
    return c.json<ExposureMatrixResponse>(exposureMatrix(deps(c).store, orgId, { ...opts, projectIds }));
  });

  app.get('/api/changes', (c) => {
    const projectId = queryString(c, 'project', 100);
    const { orgId } = requireProjectPerm(c, projectId, 'changes');
    const from = queryString(c, 'from', 100);
    const to = queryString(c, 'to', 100);
    return c.json<ChangesResponse>(diffScans(deps(c).store, orgId, projectId!, { ...(from ? { from } : {}), ...(to ? { to } : {}) }));
  });

  app.get('/api/graph', (c) => {
    const findingId = queryString(c, 'finding', 100);
    const { store } = deps(c);
    if (findingId !== undefined) {
      const { orgId } = requireOrg(c);
      const row = getFindingRow(store, orgId, findingId);
      if (!row) throw notFound('Finding not found');
      const { project } = requireProjectPerm(c, row.projectId, 'findings', 'investigate');
      const f = getEngineFinding(store, orgId, findingId);
      if (!f) throw notFound('Finding not found');
      const set = loadScanSet(store, orgId, project, row.scanId);
      return c.json<GraphResponse>(findingGraph(f, set, effectiveTierSettings(project).graphNodeCap));
    }
    const projectId = queryString(c, 'project', 100);
    const { orgId, project } = requireProjectPerm(c, projectId, 'investigate');
    const node = nodeParam(c, 'node');
    const set = latestSet(c, orgId, project);
    const g = set ? nodeGraph(node, set, effectiveTierSettings(project).graphNodeCap) : null;
    if (!g) throw notFound('Node not found in the latest scan');
    return c.json<GraphResponse>(g);
  });

  app.get('/api/investigate/search', (c) => {
    const projectId = queryString(c, 'project', 100);
    const { orgId, project } = requireProjectPerm(c, projectId, 'investigate');
    const q = queryString(c, 'q', 200) ?? '';
    const set = latestSet(c, orgId, project);
    return c.json<InvestigateSearchResponse>(set ? investigateSearch(q, set) : { items: [] });
  });

  app.get('/api/investigate/node', (c) => {
    const projectId = queryString(c, 'project', 100);
    const { orgId, project } = requireProjectPerm(c, projectId, 'investigate');
    const id = nodeParam(c, 'id');
    const { store } = deps(c);
    // Appearances across every project the caller may investigate (the requested one first).
    const { projectIds } = visibleProjects(c, 'investigate');
    const allowed = projectIds === null ? null : new Set(projectIds);
    const others = listProjects(store, orgId).filter((p) => p.id !== project.id && (allowed === null || allowed.has(p.id)));
    const sets: ScanFindingSet[] = [];
    for (const p of [project, ...others].slice(0, 100)) {
      const set = latestSet(c, orgId, p);
      if (set) sets.push(set);
    }
    const res = investigateNode(id, sets);
    if (!res) throw notFound('Node not found');
    return c.json<InvestigateNodeResponse>(res);
  });
}
