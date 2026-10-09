/**
 * Team alert rules: WHEN a new alert's severity is at least `minLevel` (and, optionally, it
 * reaches production) THEN post it to the Slack webhook, naming `channel`. With no stored rule
 * every new alert is posted, which is what the watcher did before rules existed.
 */
import type { RiskLevel } from '../../core/types.js';
import type { AlertRule, CreateAlertRuleRequest, UpdateAlertRuleRequest } from '../api-types-incidents.js';
import type { AlertRow } from './alerts.js';
import { writeAudit } from './audit.js';
import { all, get, newId, nowIso, run, StoreError, tx, type Store } from './db.js';
import { LEVEL_RANK } from './findings.js';

export type StoredAlertRule = Omit<AlertRule, 'lastThirtyDays'>;

interface RuleSql {
  id: string;
  name: string;
  min_level: RiskLevel;
  production_only: number;
  channel: string;
  email_owners: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const toRule = (r: RuleSql): StoredAlertRule => ({
  id: r.id,
  name: r.name,
  minLevel: r.min_level,
  productionOnly: r.production_only === 1,
  channel: r.channel,
  emailOwners: r.email_owners === 1,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The rule that applies while an org has stored none: every new alert, to the webhook's channel. */
export const DEFAULT_RULE: Pick<StoredAlertRule, 'name' | 'minLevel' | 'productionOnly' | 'channel'> = {
  name: 'Every new alert',
  minLevel: 'low',
  productionOnly: false,
  channel: '',
};

/**
 * True when the rule would send this alert. An alert whose severity is unknown always matches:
 * nothing shows it is below the threshold.
 */
export function ruleMatches(rule: Pick<StoredAlertRule, 'minLevel' | 'productionOnly'>, a: Pick<AlertRow, 'level' | 'production'>): boolean {
  if (rule.productionOnly && !a.production) return false;
  if (!a.level) return true;
  return LEVEL_RANK[a.level] >= LEVEL_RANK[rule.minLevel];
}

export function listAlertRules(s: Store, orgId: string): StoredAlertRule[] {
  return all<RuleSql>(s, 'SELECT * FROM alert_rule WHERE org_id = ? ORDER BY created_at, rowid', orgId).map(toRule);
}

export function getAlertRule(s: Store, orgId: string, id: string): StoredAlertRule | null {
  const r = get<RuleSql>(s, 'SELECT * FROM alert_rule WHERE id = ? AND org_id = ?', id, orgId);
  return r ? toRule(r) : null;
}

function cleanName(name: string): string {
  const n = name.trim();
  if (!n) throw new StoreError('bad_request', 'Give the rule a name', ['name']);
  return n.slice(0, 100);
}

/** "#security" or "security" → "#security". */
export function cleanChannel(channel: string): string {
  const c = channel.trim().replace(/^#/, '');
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(c)) throw new StoreError('bad_request', 'A Slack channel name: letters, digits, dots, dashes and underscores, like #security', ['channel']);
  return `#${c.toLowerCase()}`;
}

function nameTaken(s: Store, orgId: string, name: string, exceptId?: string): boolean {
  return !!get(s, 'SELECT 1 AS x FROM alert_rule WHERE org_id = ? AND name = ? AND id != ?', orgId, name, exceptId ?? '');
}

export function createAlertRule(s: Store, orgId: string, body: CreateAlertRuleRequest, actor: string): StoredAlertRule {
  const name = cleanName(body.name);
  const channel = cleanChannel(body.channel);
  return tx(s, () => {
    if (nameTaken(s, orgId, name)) throw new StoreError('conflict', 'A rule with this name already exists', ['name']);
    const id = newId('rule');
    const at = nowIso(s);
    run(
      s,
      `INSERT INTO alert_rule (id, org_id, name, min_level, production_only, channel, email_owners, enabled, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      orgId,
      name,
      body.minLevel,
      body.productionOnly ? 1 : 0,
      channel,
      body.emailOwners ? 1 : 0,
      body.enabled === false ? 0 : 1,
      at,
      at,
      actor,
    );
    writeAudit(s, { orgId, actor, action: 'alert_rule.create', target: id, detail: { name, minLevel: body.minLevel, productionOnly: !!body.productionOnly, channel } });
    return getAlertRule(s, orgId, id)!;
  });
}

export function updateAlertRule(s: Store, orgId: string, id: string, body: UpdateAlertRuleRequest, actor: string): StoredAlertRule {
  return tx(s, () => {
    const prev = getAlertRule(s, orgId, id);
    if (!prev) throw new StoreError('not_found', 'Alert rule not found');
    const name = body.name !== undefined ? cleanName(body.name) : prev.name;
    if (nameTaken(s, orgId, name, id)) throw new StoreError('conflict', 'A rule with this name already exists', ['name']);
    const next = {
      name,
      minLevel: body.minLevel ?? prev.minLevel,
      productionOnly: body.productionOnly ?? prev.productionOnly,
      channel: body.channel !== undefined ? cleanChannel(body.channel) : prev.channel,
      emailOwners: body.emailOwners ?? prev.emailOwners,
      enabled: body.enabled ?? prev.enabled,
    };
    run(
      s,
      `UPDATE alert_rule SET name = ?, min_level = ?, production_only = ?, channel = ?, email_owners = ?, enabled = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
      next.name,
      next.minLevel,
      next.productionOnly ? 1 : 0,
      next.channel,
      next.emailOwners ? 1 : 0,
      next.enabled ? 1 : 0,
      nowIso(s),
      id,
      orgId,
    );
    writeAudit(s, { orgId, actor, action: 'alert_rule.update', target: id, detail: next });
    return getAlertRule(s, orgId, id)!;
  });
}

export function deleteAlertRule(s: Store, orgId: string, id: string, actor: string): void {
  tx(s, () => {
    const prev = getAlertRule(s, orgId, id);
    if (!prev) throw new StoreError('not_found', 'Alert rule not found');
    run(s, 'DELETE FROM alert_rule WHERE id = ? AND org_id = ?', id, orgId);
    writeAudit(s, { orgId, actor, action: 'alert_rule.delete', target: id, detail: { name: prev.name } });
  });
}
