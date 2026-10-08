/**
 * Incidents, package reach and "who's behind it", derived from stored alerts, inventories and
 * findings (docs/UX.md §8 flow 3, §10). Nothing here re-scans: every answer comes from the newest
 * succeeded scan of each project the caller may see.
 */
import type { EntityChainEntry, Finding, RiskLevel } from '../core/types.js';
import { parsePurl } from '../core/types.js';
import type { StoredInventory } from '../watch/match.js';
import type {
  IncidentDetail,
  IncidentEvent,
  IncidentHit,
  IncidentRow,
  IncidentStatus,
  PackageBehindResponse,
  PackageReachResponse,
  ReachFlow,
  ReachPath,
  ReachProject,
} from './api-types-incidents.js';
import { npmNameVersion, pathsTo, purlLabel, viaOf } from './reach.js';
import {
  alertChecks,
  all,
  closedAt,
  get,
  incidentEvents,
  incidentStates,
  LEVEL_RANK,
  latestAlertCheck,
  latestInventories,
  listAlerts,
  listProjects,
  parseJson,
  placeholders,
  type AlertRow,
  type Store,
} from './store/index.js';

const worst = (levels: readonly (RiskLevel | null | undefined)[]): RiskLevel | null => {
  let best: RiskLevel | null = null;
  for (const l of levels) if (l && (!best || LEVEL_RANK[l] > LEVEL_RANK[best])) best = l;
  return best;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function inventoryHas(inv: StoredInventory | undefined, purl: string): boolean {
  return !!inv?.inventory.components.some((c) => c.purl === purl);
}

function findingIn(s: Store, scanId: string | undefined, purl: string): { id: string; level: RiskLevel } | null {
  if (!scanId) return null;
  return get<{ id: string; level: RiskLevel }>(s, 'SELECT id, level FROM finding WHERE scan_id = ? AND purl = ?', scanId, purl) ?? null;
}

export interface IncidentContext {
  store: Store;
  orgId: string;
  /** Projects the caller may see (null = all). */
  projectIds: readonly string[] | null;
}

interface Group {
  advisoryId: string;
  alerts: AlertRow[];
}

function groups(alerts: readonly AlertRow[]): Group[] {
  const map = new Map<string, AlertRow[]>();
  for (const a of alerts) (map.get(a.advisoryId) ?? map.set(a.advisoryId, []).get(a.advisoryId)!).push(a);
  return [...map.entries()].map(([advisoryId, list]) => ({ advisoryId, alerts: list }));
}

function rowFor(ctx: IncidentContext, g: Group, invs: Map<string, StoredInventory>, status: IncidentStatus): IncidentRow {
  const pkgs = new Map<string, IncidentRow['packages'][number]>();
  const projects = new Map<string, { name: string; production: boolean; fixed: boolean }>();
  for (const a of g.alerts) {
    const nv = npmNameVersion(a.purl);
    pkgs.set(a.purl, { purl: a.purl, name: nv?.name ?? a.purl, version: nv?.version || null });
    const p = projects.get(a.projectId) ?? { name: a.projectName, production: false, fixed: true };
    p.production ||= a.production;
    p.fixed &&= !inventoryHas(invs.get(a.projectId), a.purl);
    projects.set(a.projectId, p);
  }
  const list = [...projects.values()].sort((x, y) => Number(y.production) - Number(x.production) || x.name.localeCompare(y.name));
  const first = g.alerts.reduce((m, a) => (a.createdAt < m ? a.createdAt : m), g.alerts[0]!.createdAt);
  const published = g.alerts.map((a) => a.advisoryPublished).filter((x): x is string => !!x).sort()[0] ?? null;
  return {
    id: g.advisoryId,
    advisoryId: g.advisoryId,
    advisoryPublished: published,
    summary: g.alerts.find((a) => a.summary)?.summary ?? null,
    level: worst(g.alerts.map((a) => a.level)),
    status,
    packages: [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name)),
    openedAt: first,
    closedAt: status === 'closed' ? closedAt(ctx.store, ctx.orgId, g.advisoryId) : null,
    affected: list.length,
    production: list.filter((p) => p.production).length,
    fixed: list.filter((p) => p.fixed).length,
    projects: list.map((p) => p.name),
  };
}

function inventoriesById(ctx: IncidentContext): Map<string, StoredInventory> {
  return new Map(latestInventories(ctx.store, ctx.orgId, ctx.projectIds).map((i) => [i.projectId, i] as const));
}

/** Every incident the caller can see: open ones first (production, then newest), closed last. */
export function listIncidents(ctx: IncidentContext): IncidentRow[] {
  const alerts = listAlerts(ctx.store, ctx.orgId, { projectIds: ctx.projectIds, limit: 5000 });
  const gs = groups(alerts);
  const states = incidentStates(ctx.store, ctx.orgId, gs.map((g) => g.advisoryId));
  const invs = inventoriesById(ctx);
  return gs
    .map((g) => rowFor(ctx, g, invs, states.get(g.advisoryId)?.status ?? 'investigating'))
    .sort(
      (a, b) =>
        Number(a.status === 'closed') - Number(b.status === 'closed') ||
        Number(b.production > 0) - Number(a.production > 0) ||
        b.openedAt.localeCompare(a.openedAt) ||
        a.id.localeCompare(b.id),
    );
}

export interface IncidentCapabilities {
  packConfigured: boolean;
  webhookConfigured: boolean;
}

/** One incident, or null when the caller sees none of its alerts. */
export function getIncident(ctx: IncidentContext, advisoryId: string, caps: IncidentCapabilities): IncidentDetail | null {
  const alerts = listAlerts(ctx.store, ctx.orgId, { projectIds: ctx.projectIds, advisoryId, limit: 5000 });
  if (alerts.length === 0) return null;
  const status = incidentStates(ctx.store, ctx.orgId, [advisoryId]).get(advisoryId)?.status ?? 'investigating';
  const invs = inventoriesById(ctx);
  const row = rowFor(ctx, { advisoryId, alerts }, invs, status);
  const owners = new Map(listProjects(ctx.store, ctx.orgId, [...new Set(alerts.map((a) => a.projectId))]).map((p) => [p.id, p.owner] as const));

  const hits: IncidentHit[] = alerts.map((a) => {
    const inv = invs.get(a.projectId);
    const present = inventoryHas(inv, a.purl);
    const paths = present && inv ? pathsTo(inv.inventory, a.purl) : [];
    const nv = npmNameVersion(a.purl);
    return {
      alertId: a.id,
      projectId: a.projectId,
      projectName: a.projectName,
      owner: owners.get(a.projectId) ?? null,
      purl: a.purl,
      name: nv?.name ?? a.purl,
      version: nv?.version ?? '',
      production: present ? paths.some((p) => p.production) || (paths.length === 0 && a.production) : a.production,
      reachText: a.reachText,
      broughtInBy: [...new Set(paths.filter((p) => p.nodes.length > 2).map(viaOf))],
      direct: paths.some((p) => p.nodes.length === 2),
      findingId: present ? (findingIn(ctx.store, inv?.scanId, a.purl)?.id ?? null) : null,
      fixed: !present,
      alertedAt: a.createdAt,
    };
  });
  hits.sort((x, y) => Number(x.fixed) - Number(y.fixed) || Number(y.production) - Number(x.production) || x.projectName.localeCompare(y.projectName) || x.purl.localeCompare(y.purl));

  // Timeline: alerts (one event per check that raised them), org-wide checks since, status changes
  // and notifications.
  const timeline: IncidentEvent[] = [];
  const byTime = new Map<string, AlertRow[]>();
  for (const a of alerts) (byTime.get(a.createdAt) ?? byTime.set(a.createdAt, []).get(a.createdAt)!).push(a);
  for (const [at, list] of byTime) {
    const projects = [...new Set(list.map((a) => a.projectName))];
    const prod = new Set(list.filter((a) => a.production).map((a) => a.projectName));
    timeline.push({
      at,
      kind: 'alert',
      title: `Advisory matched ${plural(projects.length, 'project')}`,
      detail: `${[...new Set(list.map((a) => purlLabel(a.purl)))].join(', ')} in ${projects.map((p) => (prod.has(p) ? `${p} (production)` : p)).join(', ')}`,
    });
  }
  for (const c of alertChecks(ctx.store, ctx.orgId, row.openedAt).slice(-10)) {
    timeline.push({
      at: c.at,
      kind: 'check',
      title: `${plural(c.projectsChecked, 'project')} checked`,
      detail: `From stored inventories (${c.source === 'pack' ? 'knowledge pack' : 'advisories posted to the API'}), ${plural(c.created, 'new alert')}`,
    });
  }
  timeline.push(...incidentEvents(ctx.store, ctx.orgId, advisoryId));
  const order: Record<IncidentEvent['kind'], number> = { alert: 0, check: 1, notified: 2, status: 3 };
  timeline.sort((a, b) => a.at.localeCompare(b.at) || order[a.kind] - order[b.kind]);

  const ownerList = [...new Set(hits.filter((h) => !h.fixed && h.owner).map((h) => h.owner!))].sort();
  const check = latestAlertCheck(ctx.store, ctx.orgId);
  return {
    ...row,
    hits,
    timeline,
    checked: { projects: check?.projectsChecked ?? invs.size, at: check?.at ?? null, source: check?.source ?? null },
    owners: ownerList,
    actions: {
      recheck: caps.packConfigured
        ? { available: true, reason: null }
        : { available: false, reason: 'No knowledge pack is configured (BLASTRADIUS_PACK), so there is nothing to re-check against. Fixed counts update with every new scan.' },
      notify: !caps.webhookConfigured
        ? { available: false, reason: 'No Slack webhook is configured (BLASTRADIUS_ALERT_WEBHOOK), so nothing can be sent.' }
        : ownerList.length === 0
          ? { available: false, reason: 'No affected project has an owner. Set one under Settings › Project.' }
          : { available: true, reason: null },
    },
  };
}

/** The Slack message for "Notify owners". */
export function incidentMessage(orgName: string, d: IncidentDetail, publicUrl?: string): { text: string } {
  const open = d.hits.filter((h) => !h.fixed);
  const pkgs = d.packages.map((p) => (p.version ? `${p.name}@${p.version}` : p.name)).join(', ');
  const lines = [`*Blastradius incident in ${orgName}: ${d.advisoryId}* (${pkgs})`, `${plural(open.length, 'project')} still affected, ${d.production} in production. Owners, please check:`];
  for (const h of open.slice(0, 15)) lines.push(`• *${h.projectName}*${h.production ? ' *production*' : ''}: ${h.owner ?? 'no owner set'}${h.broughtInBy.length ? ` (brought in by ${h.broughtInBy.join(', ')})` : ''}`);
  if (open.length > 15) lines.push(`… and ${open.length - 15} more`);
  if (publicUrl) lines.push(`<${publicUrl.replace(/\/$/, '')}/incidents/${encodeURIComponent(d.advisoryId)}|Open the incident>`);
  return { text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Package reach
// ---------------------------------------------------------------------------

const MAX_PATHS = 200;

export function packageReach(ctx: IncidentContext, query: { name: string; version?: string }): PackageReachResponse {
  const inventories = latestInventories(ctx.store, ctx.orgId, ctx.projectIds);
  const projects: ReachProject[] = [];
  const flows = new Map<string, ReachFlow & { assetIds: Set<string> }>();
  const paths: ReachPath[] = [];
  const levels: (RiskLevel | null)[] = [];
  for (const inv of inventories) {
    const comps = inv.inventory.components.filter((c) => {
      const nv = npmNameVersion(c.purl);
      return nv && nv.name === query.name && (query.version === undefined || nv.version === query.version);
    });
    if (comps.length === 0) continue;
    let finding: { id: string; level: RiskLevel } | null = null;
    const all: ReturnType<typeof pathsTo> = [];
    for (const c of comps) {
      const f = findingIn(ctx.store, inv.scanId, c.purl);
      if (f && (!finding || LEVEL_RANK[f.level] > LEVEL_RANK[finding.level])) finding = f;
      for (const p of pathsTo(inv.inventory, c.purl)) all.push(p);
    }
    levels.push(finding?.level ?? null);
    const production = all.some((p) => p.production);
    const via = [...new Set(all.map(viaOf))];
    const assetIds = new Set(all.map((p) => p.assetId));
    const prodAssets = new Set(all.filter((p) => p.production).map((p) => p.assetName));
    const direct = all.some((p) => p.nodes.length === 2);
    const brought = via.filter((v) => v !== '(direct)');
    const reachText =
      all.length === 0
        ? 'In the lockfile, but no dependency path from this project reaches it'
        : `${direct ? (brought.length ? `Direct dependency, also brought in by ${brought.slice(0, 2).join(', ')}` : 'Direct dependency') : `Brought in by ${brought.slice(0, 2).join(', ')}`}${brought.length > 2 ? ` and ${brought.length - 2} more` : ''} · ${plural(assetIds.size, 'part')} of the project${prodAssets.size ? `, ${prodAssets.size} in production` : ''}`;
    projects.push({
      projectId: inv.projectId,
      projectName: inv.projectName,
      production,
      assets: assetIds.size,
      paths: all.length,
      via,
      reachText,
      versions: [...new Set(comps.map((c) => c.version))],
      findingId: finding?.id ?? null,
      level: finding?.level ?? null,
    });
    for (const p of all) {
      const key = `${inv.projectId}\u0000${viaOf(p)}`;
      const f = flows.get(key) ?? { projectId: inv.projectId, projectName: inv.projectName, via: viaOf(p), production: false, assets: 0, paths: 0, assetIds: new Set<string>() };
      f.production ||= p.production;
      f.paths++;
      f.assetIds.add(p.assetId);
      f.assets = f.assetIds.size;
      flows.set(key, f);
      paths.push({
        projectId: inv.projectId,
        projectName: inv.projectName,
        assetId: p.assetId,
        assetName: p.assetName,
        environment: p.environment,
        production: p.production,
        nodes: p.nodes.map((id, i) => (i === 0 ? { id, label: p.assetName, kind: 'asset' as const } : { id, label: purlLabel(id), kind: 'package' as const })),
        scopes: p.scopes,
      });
    }
  }
  projects.sort((a, b) => Number(b.production) - Number(a.production) || b.assets - a.assets || a.projectName.localeCompare(b.projectName));
  paths.sort((a, b) => Number(b.production) - Number(a.production) || a.nodes.length - b.nodes.length || a.projectName.localeCompare(b.projectName));

  // Advisories naming it, from stored alerts.
  const alerts = listAlerts(ctx.store, ctx.orgId, { projectIds: ctx.projectIds, limit: 5000 }).filter((a) => {
    const nv = npmNameVersion(a.purl);
    return nv && nv.name === query.name && (query.version === undefined || nv.version === query.version);
  });
  const states = incidentStates(ctx.store, ctx.orgId, [...new Set(alerts.map((a) => a.advisoryId))]);
  const advisories = new Map<string, PackageReachResponse['advisories'][number]>();
  for (const a of alerts) {
    const prev = advisories.get(a.advisoryId);
    advisories.set(a.advisoryId, {
      id: a.advisoryId,
      published: prev?.published ?? a.advisoryPublished,
      status: states.get(a.advisoryId)?.status ?? 'investigating',
      fixedIn: prev?.fixedIn ?? a.fixedIn ?? null,
    });
    levels.push(a.level ?? null);
  }
  const byId = new Map(inventories.map((i) => [i.projectId, i] as const));
  const alerted = new Set(alerts.map((a) => a.projectId));
  const fixedProjects = [...alerted].filter((pid) => alerts.filter((a) => a.projectId === pid).every((a) => !inventoryHas(byId.get(pid), a.purl)));
  const firstAdvisory = [...advisories.values()].filter((a) => a.published).sort((a, b) => a.published!.localeCompare(b.published!))[0];

  const visible = ctx.projectIds;
  const firstSeen = get<{ at: string | null }>(
    ctx.store,
    `SELECT MIN(first_seen_at) AS at FROM finding WHERE org_id = ? AND name = ?${query.version !== undefined ? ' AND version = ?' : ''}${visible ? ` AND project_id IN (${placeholders(visible.length)})` : ''}`,
    ctx.orgId,
    query.name,
    ...(query.version !== undefined ? [query.version] : []),
    ...(visible ?? []),
  )?.at;

  return {
    query: { name: query.name, version: query.version ?? null },
    projectsSearched: inventories.length,
    level: worst(levels),
    advisories: [...advisories.values()],
    lifecycle: {
      firstWarning: visible && visible.length === 0 ? null : (firstSeen ?? null),
      advisory: firstAdvisory ? { id: firstAdvisory.id, at: firstAdvisory.published! } : null,
      fixed: alerted.size > 0 ? { fixed: fixedProjects.length, of: alerted.size } : null,
    },
    projects,
    flows: [...flows.values()]
      .map(({ assetIds: _a, ...f }) => f)
      .sort((a, b) => Number(b.production) - Number(a.production) || b.assets - a.assets || a.projectName.localeCompare(b.projectName) || a.via.localeCompare(b.via)),
    paths: paths.slice(0, MAX_PATHS),
    totalPaths: paths.length,
  };
}

// ---------------------------------------------------------------------------
// Who's behind it
// ---------------------------------------------------------------------------

type Link = PackageBehindResponse['links'][number];

function pkgNameOfFrom(from: string): string | null {
  try {
    const p = parsePurl(from);
    return p.namespace ? `${p.namespace}/${p.name}` : p.name;
  } catch {
    return null;
  }
}

/** Links from the newest findings of every visible project, merged per (from, to, relation). */
export function packageBehind(ctx: IncidentContext, name: string): PackageBehindResponse {
  const inventories = latestInventories(ctx.store, ctx.orgId, ctx.projectIds);
  const usedIn = inventories.filter((i) => i.inventory.components.some((c) => npmNameVersion(c.purl)?.name === name)).length;
  const scanIds = inventories.map((i) => i.scanId).filter((x): x is string => !!x);
  const rows = scanIds.length
    ? all<{ name: string; finding_json: string }>(ctx.store, `SELECT name, finding_json FROM finding WHERE scan_id IN (${placeholders(scanIds.length)})`, ...scanIds)
    : [];
  const links = new Map<string, Link>();
  const incidents = new Set<string>();
  const entityPackages = new Map<string, Set<string>>();
  const add = (e: EntityChainEntry, pkg: string, mine: boolean) => {
    if (e.relation === 'incident') {
      if (mine) incidents.add(e.entityId);
      return;
    }
    (entityPackages.get(e.entityId) ?? entityPackages.set(e.entityId, new Set()).get(e.entityId)!).add(pkg);
    if (!mine || !e.from) return;
    const key = `${e.from}\u0000${e.entityId}\u0000${e.relation}`;
    const prev = links.get(key);
    const evidence = [...new Set([...(prev?.evidence ?? []), ...(e.evidence ?? [])])].slice(0, 20);
    links.set(key, {
      from: e.from,
      entityId: e.entityId,
      relation: e.relation,
      confidence: Math.max(prev?.confidence ?? 0, e.confidence),
      evidence,
      method: prev?.method === 'deterministic' || e.method === 'deterministic' ? 'deterministic' : (e.method ?? 'probabilistic'),
      reviewed: !!(prev?.reviewed || e.reviewed),
    });
  };
  for (const r of rows) {
    const f = parseJson<Finding | null>(r.finding_json, null);
    if (!f) continue;
    const mine = r.name === name;
    for (const e of [...(f.behind ?? []), ...(f.entityChain ?? [])]) add(e, r.name, mine);
  }
  // Only links reachable from this package (behind lists are per package, but the chain may
  // pass through entities shared with others).
  const alsoLinked: Record<string, string[]> = {};
  for (const l of links.values()) {
    const others = [...(entityPackages.get(l.entityId) ?? [])].filter((p) => p !== name).sort();
    if (others.length) alsoLinked[l.entityId] = others.slice(0, 20);
  }
  const ordered = [...links.values()].sort(
    (a, b) => Number(pkgNameOfFrom(b.from) === name) - Number(pkgNameOfFrom(a.from) === name) || b.confidence - a.confidence || a.entityId.localeCompare(b.entityId),
  );
  return { name, usedIn, links: ordered, incidents: [...incidents].sort(), alsoLinked };
}
