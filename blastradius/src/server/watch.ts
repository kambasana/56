/**
 * Alerts without anyone asking (docs/NEXT-LEVEL.md, org-wide incident mode):
 * - after every successful scan, that project's inventory is checked against the knowledge pack;
 * - every `intervalMinutes`, every project of every org is checked (the pack is reloaded when its
 *   file changes, so refreshing the pack raises alerts for projects scanned earlier);
 * - new alerts are posted once to an optional Slack-compatible webhook ({ text }).
 * Matching uses stored inventories only; nothing is re-scanned.
 */
import { stat } from 'node:fs/promises';
import { loadPack, type LoadedPack } from '../pack/load.js';
import { matchAdvisories, matchPack, type AdvisoryLike, type ExposureHit } from '../watch/match.js';
import { all, latestInventories, listAlertRules, recordAlertCheck, recordAlerts, recordNotified, ruleMatches, type AlertRow, type RecordedAlerts, type StoredAlertRule, type Store } from './store/index.js';

export interface AlertWatcherOptions {
  /** Knowledge pack file (default $BLASTRADIUS_PACK). */
  packPath?: string;
  /** Slack-compatible incoming webhook (default $BLASTRADIUS_ALERT_WEBHOOK). https only, except loopback. */
  webhookUrl?: string;
  /** Link shown in notifications (default $BLASTRADIUS_PUBLIC_URL). */
  publicUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

/** Webhooks leave the server: https anywhere, plain http only to this machine (tests, local relays). */
export function webhookAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** One Slack-style message for a batch of new alerts (plain text with mrkdwn; also fine for Teams/Mattermost). */
export function alertMessage(orgName: string, alerts: readonly AlertRow[], publicUrl?: string): { text: string } {
  const prod = alerts.filter((a) => a.production).length;
  const head = `:rotating_light: *Blastradius: ${alerts.length} new supply-chain alert${alerts.length === 1 ? '' : 's'} in ${orgName}*${prod ? ` (${prod} in production)` : ''}`;
  const lines = alerts.slice(0, 15).map((a) => {
    const pkg = decodeURIComponent(a.purl.replace(/^pkg:npm\//, ''));
    return `• *${a.projectName}*: \`${pkg}\` (${a.advisoryId})${a.production ? ' *production*' : ''}: ${a.reachText}`;
  });
  if (alerts.length > 15) lines.push(`… and ${alerts.length - 15} more`);
  if (publicUrl) lines.push(`<${publicUrl.replace(/\/$/, '')}/|Open Blastradius>`);
  return { text: [head, ...lines].join('\n') };
}

export class AlertWatcher {
  private readonly packPath: string | undefined;
  private readonly webhookUrl: string | undefined;
  private readonly publicUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (m: string) => void;
  private pack: { mtimeMs: number; loaded: Promise<LoadedPack> } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    opts: AlertWatcherOptions = {},
  ) {
    this.packPath = opts.packPath ?? process.env.BLASTRADIUS_PACK ?? undefined;
    const hook = opts.webhookUrl ?? process.env.BLASTRADIUS_ALERT_WEBHOOK ?? undefined;
    this.log = opts.log ?? (() => {});
    if (hook && !webhookAllowed(hook)) this.log('alert webhook ignored: it must be https (http only to localhost) and carry no credentials in the URL');
    this.webhookUrl = hook && webhookAllowed(hook) ? hook : undefined;
    this.publicUrl = opts.publicUrl ?? process.env.BLASTRADIUS_PUBLIC_URL ?? undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return this.packPath !== undefined;
  }

  /** A Slack-compatible webhook is configured (notifications can leave the server). */
  get webhookConfigured(): boolean {
    return this.webhookUrl !== undefined;
  }

  /** The pack, reloaded when its file changes. */
  async currentPack(): Promise<LoadedPack | null> {
    if (!this.packPath) return null;
    const mtimeMs = (await stat(this.packPath)).mtimeMs;
    if (!this.pack || this.pack.mtimeMs !== mtimeMs) {
      const loaded = loadPack(this.packPath);
      this.pack = { mtimeMs, loaded };
      loaded.catch(() => {
        if (this.pack?.loaded === loaded) this.pack = null;
      });
    }
    return this.pack.loaded;
  }

  /**
   * Record hits as alerts and notify about the new ones and those whose level was raised (so a
   * rule with a minimum level fires when an alert reaches it). Returns the new alerts.
   */
  async record(orgId: string, hits: readonly ExposureHit[]): Promise<AlertRow[]> {
    return (await this.recordAll(orgId, hits)).created;
  }

  async recordAll(orgId: string, hits: readonly ExposureHit[]): Promise<RecordedAlerts> {
    const out = recordAlerts(this.store, orgId, hits);
    const changed = [...out.created, ...out.raised];
    if (changed.length > 0) await this.notify(orgId, changed);
    return out;
  }

  /** Match the pack (or given advisories) against one org's projects; returns new alerts. */
  async checkOrg(orgId: string, opts: { projectIds?: string[]; advisories?: AdvisoryLike[] } = {}): Promise<{ created: AlertRow[]; projectsChecked: number; source: 'pack' | 'advisories' }> {
    const inventories = latestInventories(this.store, orgId, opts.projectIds ?? null);
    // Only org-wide checks count as "every project checked" on the Incident page.
    const note = (source: 'pack' | 'advisories', created: AlertRow[]) => {
      if (!opts.projectIds) recordAlertCheck(this.store, orgId, source, inventories.length, created.length);
      return { created, projectsChecked: inventories.length, source };
    };
    if (opts.advisories) return note('advisories', await this.record(orgId, matchAdvisories(inventories, opts.advisories)));
    const pack = await this.currentPack();
    if (!pack) return { created: [], projectsChecked: inventories.length, source: 'pack' };
    return note('pack', await this.record(orgId, matchPack(inventories, pack.pack)));
  }

  /** Every org (the periodic sweep). Runs one at a time. */
  checkAll(): Promise<number> {
    const run = this.running.then(async () => {
      let total = 0;
      for (const { id } of all<{ id: string }>(this.store, 'SELECT id FROM org ORDER BY id')) total += (await this.checkOrg(id)).created.length;
      if (total) this.log(`alerts: ${total} new from the knowledge pack`);
      return total;
    });
    this.running = run.catch(() => undefined);
    return run;
  }

  /** After a successful scan: check just that project. Never throws (a scan must not fail on this). */
  afterScan(projectId: string): void {
    if (!this.enabled) return;
    const orgId = all<{ org_id: string }>(this.store, 'SELECT org_id FROM project WHERE id = ?', projectId)[0]?.org_id;
    if (!orgId) return;
    this.running = this.running
      .then(() => this.checkOrg(orgId, { projectIds: [projectId] }))
      .then((r) => r.created.length && this.log(`alerts: ${r.created.length} new for project ${projectId}`))
      .catch((e) => this.log(`alerts: check after scan failed: ${(e as Error).message}`));
  }

  start(intervalMinutes: number): void {
    if (!this.enabled || intervalMinutes <= 0) return;
    void this.checkAll().catch((e) => this.log(`alerts: sweep failed: ${(e as Error).message}`));
    this.timer = setInterval(() => void this.checkAll().catch((e) => this.log(`alerts: sweep failed: ${(e as Error).message}`)), intervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wait for queued checks (tests, shutdown). */
  idle(): Promise<unknown> {
    return this.running;
  }

  /**
   * Post new alerts to the webhook, rule by rule. With no stored rule every alert goes out once
   * (the default rule); otherwise each enabled rule posts the alerts it matches, naming its
   * channel. Each post the webhook accepts lands on the incidents' timelines.
   */
  private async notify(orgId: string, alerts: AlertRow[]): Promise<void> {
    if (!this.webhookUrl) return;
    const org = this.orgName(orgId);
    const rules = listAlertRules(this.store, orgId);
    const batches: { rule: StoredAlertRule | null; alerts: AlertRow[] }[] =
      rules.length === 0 ? [{ rule: null, alerts }] : rules.filter((r) => r.enabled).map((rule) => ({ rule, alerts: alerts.filter((a) => ruleMatches(rule, a)) }));
    for (const b of batches) {
      if (b.alerts.length === 0) continue;
      const msg = alertMessage(org, b.alerts, this.publicUrl);
      const body = b.rule ? { text: `${msg.text}\n_Alert rule: ${b.rule.name}_`, channel: b.rule.channel } : msg;
      if (!(await this.post(body))) continue;
      const n = b.alerts.length;
      recordNotified(
        this.store,
        orgId,
        b.alerts.map((a) => a.advisoryId),
        'system',
        b.rule ? `Slack ${b.rule.channel} notified` : 'Slack notified',
        `${b.rule ? `Alert rule: ${b.rule.name}` : 'Default rule: every new alert'} · ${n} ${n === 1 ? 'alert' : 'alerts'}`,
      );
    }
  }

  /** One message through the webhook; true when it answered 2xx. Never throws. */
  async post(body: { text: string; channel?: string }): Promise<boolean> {
    if (!this.webhookUrl) return false;
    try {
      const res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log(`alert webhook answered HTTP ${res.status}`);
      return res.ok;
    } catch (e) {
      this.log(`alert webhook failed: ${(e as Error).message}`);
      return false;
    }
  }

  orgName(orgId: string): string {
    return all<{ name: string }>(this.store, 'SELECT name FROM org WHERE id = ?', orgId)[0]?.name ?? orgId;
  }
}
