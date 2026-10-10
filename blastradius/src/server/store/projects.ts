/**
 * Projects: what to scan (a local path or an https git URL), size tier and tier overrides.
 * Target safety (allow-listed hosts, allowed local roots) is enforced by the server before it
 * calls in here; the store only records the target and its kind.
 */
import type { CreateProjectRequest, OrgHomeResponse, Project, ProjectRow, SizeTier, TierSettings, UpdateProjectRequest } from '../api-types.js';
import { SIZE_TIERS, TIER_DEFAULTS } from '../api-types.js';
import { writeAudit } from './audit.js';
import { all, get, isConstraintError, newId, nowIso, parseJson, placeholders, run, StoreError, tx, type Store } from './db.js';
import { emptyCounts, latestSucceededScan, scanFindingStats } from './findings.js';
import { getOrg } from './orgs.js';
import { latestScan, recentScans, succeededSummaries } from './scans.js';

interface ProjectRowSql {
  id: string;
  org_id: string;
  name: string;
  target: string;
  target_kind: 'local' | 'git';
  tier: SizeTier;
  tier_overrides: string;
  owner: string | null;
  created_at: string;
  updated_at: string;
}

function toProject(r: ProjectRowSql): Project {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    tier: r.tier,
    tierOverrides: parseJson<Partial<TierSettings>>(r.tier_overrides, {}),
    target: r.target,
    owner: r.owner,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type TargetKind = 'local' | 'git';

/** "git" for https URLs, "local" otherwise. Validation of the target is the server's job. */
export function classifyTarget(target: string): TargetKind {
  return /^https:\/\//i.test(target) ? 'git' : 'local';
}

export function isSizeTier(v: unknown): v is SizeTier {
  return typeof v === 'string' && (SIZE_TIERS as readonly string[]).includes(v);
}

const OVERRIDE_CHECKS: { [K in keyof TierSettings]: (v: unknown) => boolean } = {
  scanCadence: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80,
  dependencyDepth: (v) => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100),
  includeDevDependencies: (v) => typeof v === 'boolean',
  retentionDays: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650,
  graphNodeCap: (v) => Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 5000,
  entityHops: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10,
};

/** Keep only known, well-typed override keys; report the rest. */
export function normalizeTierOverrides(input: unknown): { overrides: Partial<TierSettings>; invalid: string[] } {
  const overrides: Record<string, unknown> = {};
  const invalid: string[] = [];
  if (input === undefined || input === null) return { overrides: {}, invalid };
  if (typeof input !== 'object' || Array.isArray(input)) return { overrides: {}, invalid: ['tierOverrides'] };
  for (const [k, v] of Object.entries(input)) {
    const check = (OVERRIDE_CHECKS as Record<string, ((v: unknown) => boolean) | undefined>)[k];
    if (!check || !check(v)) invalid.push(`tierOverrides.${k}`);
    else overrides[k] = v;
  }
  return { overrides: overrides as Partial<TierSettings>, invalid };
}

/** TIER_DEFAULTS[tier] + overrides. */
export function effectiveTierSettings(p: Pick<Project, 'tier' | 'tierOverrides'>): TierSettings {
  const d = TIER_DEFAULTS[p.tier];
  const base: TierSettings = {
    scanCadence: d.scanCadence,
    dependencyDepth: d.dependencyDepth,
    includeDevDependencies: d.includeDevDependencies,
    retentionDays: d.retentionDays,
    graphNodeCap: d.graphNodeCap,
    entityHops: d.entityHops,
  };
  return { ...base, ...p.tierOverrides };
}

function cleanTarget(t: unknown): string {
  if (typeof t !== 'string') throw new StoreError('bad_request', 'Target is required', ['target']);
  const v = t.trim();
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > 2048 || /[\u0000-\u001f]/.test(v)) throw new StoreError('bad_request', 'Invalid target', ['target']);
  return v;
}

function cleanProjectName(n: unknown): string {
  const v = typeof n === 'string' ? n.trim() : '';
  if (!v || v.length > 120) throw new StoreError('bad_request', 'Name must be 1–120 characters', ['name']);
  return v;
}

function cleanOwner(o: unknown): string | null {
  if (o === undefined || o === null) return null;
  if (typeof o !== 'string' || o.length > 200) throw new StoreError('bad_request', 'Invalid owner', ['owner']);
  return o.trim() || null;
}

function checkedOverrides(input: unknown): Partial<TierSettings> {
  const { overrides, invalid } = normalizeTierOverrides(input);
  if (invalid.length > 0) throw new StoreError('bad_request', 'Invalid tier overrides', invalid);
  return overrides;
}

export function createProject(s: Store, orgId: string, input: CreateProjectRequest, actor: string): Project {
  const name = cleanProjectName(input.name);
  const target = cleanTarget(input.target);
  if (!isSizeTier(input.tier)) throw new StoreError('bad_request', 'Unknown tier', ['tier']);
  const overrides = checkedOverrides(input.tierOverrides);
  const owner = cleanOwner(input.owner);
  return tx(s, () => {
    if (!getOrg(s, orgId)) throw new StoreError('not_found', 'Org not found');
    const id = newId('prj');
    const at = nowIso(s);
    try {
      run(
        s,
        `INSERT INTO project (id, org_id, name, target, target_kind, tier, tier_overrides, owner, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        orgId,
        name,
        target,
        classifyTarget(target),
        input.tier,
        JSON.stringify(overrides),
        owner,
        at,
        at,
      );
    } catch (e) {
      if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'A project with this name already exists', ['name']);
      throw e;
    }
    const p = getProject(s, orgId, id)!;
    writeAudit(s, { orgId, actor, action: 'project.create', target: id, detail: { after: p } });
    return p;
  });
}

/** Org-scoped: a project of another org is null (the API answers 404). */
export function getProject(s: Store, orgId: string, id: string): Project | null {
  const r = get<ProjectRowSql>(s, 'SELECT * FROM project WHERE id = ? AND org_id = ?', id, orgId);
  return r ? toProject(r) : null;
}

/** Projects in the org, by name. `projectIds` (when not null) limits to those ids. */
export function listProjects(s: Store, orgId: string, projectIds: readonly string[] | null = null): Project[] {
  if (projectIds && projectIds.length === 0) return [];
  const filter = projectIds ? ` AND id IN (${placeholders(projectIds.length)})` : '';
  return all<ProjectRowSql>(s, `SELECT * FROM project WHERE org_id = ?${filter} ORDER BY name COLLATE NOCASE, rowid`, orgId, ...(projectIds ?? [])).map(
    toProject,
  );
}

export function updateProject(s: Store, orgId: string, id: string, patch: UpdateProjectRequest, actor: string): Project {
  return tx(s, () => {
    const before = getProject(s, orgId, id);
    if (!before) throw new StoreError('not_found', 'Project not found');
    const name = patch.name !== undefined ? cleanProjectName(patch.name) : before.name;
    const target = patch.target !== undefined ? cleanTarget(patch.target) : before.target;
    if (patch.tier !== undefined && !isSizeTier(patch.tier)) throw new StoreError('bad_request', 'Unknown tier', ['tier']);
    const tier = patch.tier ?? before.tier;
    const overrides = patch.tierOverrides !== undefined ? checkedOverrides(patch.tierOverrides) : before.tierOverrides;
    const owner = patch.owner !== undefined ? cleanOwner(patch.owner) : before.owner;
    try {
      run(
        s,
        `UPDATE project SET name = ?, target = ?, target_kind = ?, tier = ?, tier_overrides = ?, owner = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
        name,
        target,
        classifyTarget(target),
        tier,
        JSON.stringify(overrides),
        owner,
        nowIso(s),
        id,
        orgId,
      );
    } catch (e) {
      if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'A project with this name already exists', ['name']);
      throw e;
    }
    const after = getProject(s, orgId, id)!;
    writeAudit(s, { orgId, actor, action: 'project.update', target: id, detail: { before, after } });
    return after;
  });
}

/** Deletes the project with its scans, findings, status and project bindings. 409 while a scan is active. */
export function deleteProject(s: Store, orgId: string, id: string, actor: string): void {
  tx(s, () => {
    const before = getProject(s, orgId, id);
    if (!before) throw new StoreError('not_found', 'Project not found');
    const active = get<{ id: string }>(s, `SELECT id FROM scan WHERE project_id = ? AND status IN ('queued', 'running')`, id);
    if (active) throw new StoreError('conflict', 'A scan is queued or running for this project');
    run(s, 'DELETE FROM project WHERE id = ? AND org_id = ?', id, orgId);
    writeAudit(s, { orgId, actor, action: 'project.delete', target: id, detail: { before } });
  });
}

// ---------------------------------------------------------------------------
// Rows for Org home / project list
// ---------------------------------------------------------------------------

export function projectRow(s: Store, p: Project): ProjectRow {
  const latest = latestSucceededScan(s, p.id);
  const summaries = succeededSummaries(s, p.id, 12);
  const latestSummary = latest ? summaries.find((x) => x.id === latest.id)?.summary : null;
  const stats = latest ? scanFindingStats(s, latest.id) : { counts: emptyCounts(), toReview: 0 };
  return {
    ...p,
    lastScan: latestScan(s, p.id),
    assets: latestSummary?.inventory.assets ?? 0,
    components: latestSummary?.inventory.components ?? 0,
    counts: stats.counts,
    trend: summaries.map((x) => (x.summary ? x.summary.counts.critical + x.summary.counts.high : 0)),
    toReview: stats.toReview,
  };
}

export function getProjectRow(s: Store, orgId: string, id: string): ProjectRow | null {
  const p = getProject(s, orgId, id);
  return p ? projectRow(s, p) : null;
}

export function listProjectRows(s: Store, orgId: string, projectIds: readonly string[] | null = null): ProjectRow[] {
  return listProjects(s, orgId, projectIds).map((p) => projectRow(s, p));
}

/** GET /api/home. `projectIds` (when not null) limits to the projects the caller may see. */
export function orgHome(s: Store, orgId: string, projectIds: readonly string[] | null = null): OrgHomeResponse {
  const org = getOrg(s, orgId);
  if (!org) throw new StoreError('not_found', 'Org not found');
  const projects = listProjectRows(s, orgId, projectIds);
  const counts = emptyCounts();
  let assets = 0;
  let components = 0;
  let toReview = 0;
  for (const p of projects) {
    assets += p.assets;
    components += p.components;
    toReview += p.toReview;
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += p.counts[k];
  }
  return {
    org,
    totals: { projects: projects.length, assets, components, counts, toReview },
    projects,
    recentScans: recentScans(s, orgId, { projectIds, limit: 10 }),
  };
}
