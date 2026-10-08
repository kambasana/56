/**
 * Incidents (advisories that hit a project), package reach, "who's behind it" and team alert
 * rules. Reads follow the caller's visible projects; writes need an org-scope permission.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type {
  AlertRule,
  IncidentDetail,
  ListAlertRulesResponse,
  ListIncidentsResponse,
  NotifyIncidentResponse,
  PackageBehindResponse,
  PackageReachResponse,
  PreviewAlertRuleResponse,
} from '../api-types-incidents.js';
import { INCIDENT_STATUSES } from '../api-types-incidents.js';
import type { OkResponse } from '../api-types.js';
import { deps, requireOrgPerm, visibleProjects, type AppEnv, type Ctx } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { getIncident, incidentMessage, listIncidents, packageBehind, packageReach, type IncidentContext } from '../incidents.js';
import { idParam, parseBody, queryString } from '../request.js';
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  listAlerts,
  nowIso,
  recordNotified,
  RISK_LEVELS,
  ruleMatches,
  setIncidentStatus,
  updateAlertRule,
  type StoredAlertRule,
} from '../store/index.js';
import { parseExposureQuery } from './alerts.js';

const Level = z.enum(RISK_LEVELS as unknown as ['critical', 'high', 'medium', 'low']);
const StatusBody = z.strictObject({ status: z.enum(INCIDENT_STATUSES) });
const RuleBody = z.strictObject({
  name: z.string().max(100),
  minLevel: Level,
  productionOnly: z.boolean().optional(),
  channel: z.string().max(81),
  emailOwners: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const PreviewBody = z.strictObject({ minLevel: Level, productionOnly: z.boolean().optional() });
const TestBody = z.strictObject({ channel: z.string().max(81) });

const DAY = 86_400_000;

function ctxFor(c: Ctx, ...perms: Parameters<typeof visibleProjects>[1][]): IncidentContext & { userId: string; userName: string } {
  const { orgId, projectIds, session } = visibleProjects(c, ...perms);
  return { store: deps(c).store, orgId, projectIds, userId: session.user.id, userName: session.user.name };
}

function detail(c: Ctx, ctx: IncidentContext, id: string): IncidentDetail {
  const { watcher } = deps(c);
  const d = getIncident(ctx, id, { packConfigured: watcher.enabled, webhookConfigured: watcher.webhookConfigured });
  if (!d) throw notFound('Incident not found');
  return d;
}

/** Alerts of the last 30 days the caller may see. */
function recentAlerts(ctx: IncidentContext) {
  const since = new Date(ctx.store.now().getTime() - 30 * DAY).toISOString();
  return listAlerts(ctx.store, ctx.orgId, { projectIds: ctx.projectIds, since, limit: 5000 });
}

function withCounts(rules: StoredAlertRule[], recent: ReturnType<typeof recentAlerts>): AlertRule[] {
  return rules.map((r) => ({ ...r, lastThirtyDays: recent.filter((a) => ruleMatches(r, a)).length }));
}

function packageQuery(c: Ctx): { name: string; version?: string } {
  const name = queryString(c, 'name', 214)?.trim();
  const version = queryString(c, 'version', 100)?.trim();
  const q = name ? parseExposureQuery(version ? `${name}@${version}` : name) : null;
  if (!q) throw badRequest('Give a package name, optionally with a version', ['name']);
  return q;
}

export function registerIncidentRoutes(app: Hono<AppEnv>): void {
  app.get('/api/incidents', (c) => {
    const ctx = ctxFor(c, 'findings', 'exposure');
    return c.json<ListIncidentsResponse>({ items: listIncidents(ctx) });
  });

  app.get('/api/incidents/:id', (c) => c.json<IncidentDetail>(detail(c, ctxFor(c, 'findings', 'exposure'), idParam(c, 'id'))));

  app.patch('/api/incidents/:id', async (c) => {
    const id = idParam(c, 'id');
    const ctx = ctxFor(c, 'findings', 'exposure');
    detail(c, ctx, id); // 404 before 403
    requireOrgPerm(c, 'review');
    const body = await parseBody(c, StatusBody);
    setIncidentStatus(ctx.store, ctx.orgId, id, body.status, { id: ctx.userId, name: ctx.userName });
    return c.json<IncidentDetail>(detail(c, ctx, id));
  });

  app.post('/api/incidents/:id/notify', async (c) => {
    const id = idParam(c, 'id');
    const ctx = ctxFor(c, 'findings', 'exposure');
    const before = detail(c, ctx, id);
    requireOrgPerm(c, 'send_to_destinations', 'manage_alert_rules');
    if (!before.actions.notify.available) throw badRequest(before.actions.notify.reason ?? 'Nothing to send');
    const { watcher } = deps(c);
    const ok = await watcher.post(incidentMessage(watcher.orgName(ctx.orgId), before, process.env.BLASTRADIUS_PUBLIC_URL));
    if (!ok) throw badRequest('The Slack webhook did not accept the message; the server log has its answer.');
    recordNotified(ctx.store, ctx.orgId, [id], ctx.userId, `${ctx.userName} notified the owners`, `${before.owners.join(', ')} (Slack)`);
    return c.json<NotifyIncidentResponse>({ sent: true, owners: before.owners, detail: detail(c, ctx, id) });
  });

  app.get('/api/packages/reach', (c) => {
    const query = packageQuery(c);
    return c.json<PackageReachResponse>(packageReach(ctxFor(c, 'exposure'), query));
  });

  app.get('/api/packages/behind', (c) => {
    const name = packageQuery(c).name;
    return c.json<PackageBehindResponse>(packageBehind(ctxFor(c, 'exposure'), name));
  });

  // Alert rules ---------------------------------------------------------------

  app.get('/api/alert-rules', (c) => {
    const ctx = ctxFor(c, 'findings', 'exposure');
    const rules = listAlertRules(ctx.store, ctx.orgId);
    const { watcher } = deps(c);
    return c.json<ListAlertRulesResponse>({
      items: withCounts(rules, recentAlerts(ctx)),
      usingDefault: rules.length === 0,
      webhook: { configured: watcher.webhookConfigured },
      email: { configured: false },
    });
  });

  app.post('/api/alert-rules/preview', async (c) => {
    const ctx = ctxFor(c, 'findings', 'exposure');
    const body = await parseBody(c, PreviewBody);
    const rule = { minLevel: body.minLevel, productionOnly: !!body.productionOnly };
    const hits = recentAlerts(ctx).filter((a) => ruleMatches(rule, a));
    const top = hits[0];
    return c.json<PreviewAlertRuleResponse>({
      days: 30,
      count: hits.length,
      mostRecent: top ? { purl: top.purl, projectName: top.projectName, advisoryId: top.advisoryId, createdAt: top.createdAt } : null,
    });
  });

  app.post('/api/alert-rules/test', async (c) => {
    const { orgId, session } = requireOrgPerm(c, 'manage_alert_rules');
    const body = await parseBody(c, TestBody);
    const { watcher } = deps(c);
    if (!watcher.webhookConfigured) throw badRequest('No Slack webhook is configured (BLASTRADIUS_ALERT_WEBHOOK)');
    const channel = `#${body.channel.trim().replace(/^#/, '')}`;
    const ok = await watcher.post({ text: `Blastradius test message for ${channel} from ${session.user.name} (${watcher.orgName(orgId)}), ${nowIso(deps(c).store)}.`, channel });
    if (!ok) throw badRequest('The Slack webhook did not accept the message; the server log has its answer.');
    return c.json<OkResponse>({ ok: true });
  });

  app.post('/api/alert-rules', async (c) => {
    const { orgId, session } = requireOrgPerm(c, 'manage_alert_rules');
    const body = await parseBody(c, RuleBody);
    const store = deps(c).store;
    const rule = createAlertRule(store, orgId, body, session.user.id);
    return c.json<AlertRule>(withCounts([rule], recentAlerts({ store, orgId, projectIds: null }))[0]!, 201);
  });

  app.patch('/api/alert-rules/:id', async (c) => {
    const id = idParam(c, 'id');
    const { orgId, session } = requireOrgPerm(c, 'manage_alert_rules');
    const body = await parseBody(c, RuleBody.partial());
    const store = deps(c).store;
    const rule = updateAlertRule(store, orgId, id, body, session.user.id);
    return c.json<AlertRule>(withCounts([rule], recentAlerts({ store, orgId, projectIds: null }))[0]!);
  });

  app.delete('/api/alert-rules/:id', (c) => {
    const id = idParam(c, 'id');
    const { orgId, session } = requireOrgPerm(c, 'manage_alert_rules');
    deleteAlertRule(deps(c).store, orgId, id, session.user.id);
    return c.json<OkResponse>({ ok: true });
  });
}
