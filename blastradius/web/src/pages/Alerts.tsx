/**
 * Alerts (docs/UX.md §8 flow 5): team rules WHEN a new alert's severity is at least X [and it
 * reaches production] THEN post to a Slack channel, each with "would have sent N in the last 30
 * days" from stored alerts. Editing needs manage_alert_rules; the rule sheet lives in the URL
 * (`rule=<id>` or `rule=new`). Below, what fired recently. Data: /api/alert-rules, /api/alerts.
 */
import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { AlertRule, ListAlertRulesResponse, PreviewAlertRuleResponse } from '@server/api-types-incidents';
import type { RiskLevel } from '@server/api-types';
import { incidentsApi } from '@/api-incidents';
import { useAuth } from '@/auth';
import { PageHeader } from '@/components/PageHeader';
import { needsPermissionText, NotAllowedHint, SEVERITY_GLYPH, SEVERITY_LABEL, StateBlock, useUpdateParams } from '@/components/br';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { useApi } from '@/lib/useApi';
import { fmtTime } from '@/lib/cn';
import { cn } from '@/lib/utils';
import { AlertsCard } from './d-parts/IncidentPanel';

const LEVELS: RiskLevel[] = ['critical', 'high', 'medium', 'low'];
const CHANNEL = /^#?[a-z0-9][a-z0-9._-]{0,79}$/i;

/** "◆ Critical or worse, in production" */
export function ruleWhen(r: Pick<AlertRule, 'minLevel' | 'productionOnly'>): string {
  const sev = r.minLevel === 'low' ? 'Any severity' : r.minLevel === 'critical' ? `${SEVERITY_GLYPH.critical} Critical` : `${SEVERITY_GLYPH[r.minLevel]} ${SEVERITY_LABEL[r.minLevel]} or worse`;
  return `${sev}${r.productionOnly ? ', in production' : ', any project'}`;
}

interface Draft {
  name: string;
  minLevel: RiskLevel;
  productionOnly: boolean;
  channel: string;
}

const EMPTY: Draft = { name: '', minLevel: 'critical', productionOnly: true, channel: '' };

function usePreview(d: Draft): { data: PreviewAlertRuleResponse | null; error: string | null } {
  const [state, setState] = useState<{ data: PreviewAlertRuleResponse | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      incidentsApi
        .previewAlertRule({ minLevel: d.minLevel, productionOnly: d.productionOnly }, ac.signal)
        .then((data) => !ac.signal.aborted && setState({ data, error: null }))
        .catch((e: unknown) => !ac.signal.aborted && setState({ data: null, error: (e as Error).message }));
    }, 150);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [d.minLevel, d.productionOnly]);
  return state;
}

function RuleSheet({ rule, list, onClose, onSaved }: { rule: AlertRule | null; list: ListAlertRulesResponse; onClose: () => void; onSaved: () => void }) {
  const { can } = useAuth();
  const allowed = can('manage_alert_rules');
  const id = useId();
  const [d, setD] = useState<Draft>(rule ? { name: rule.name, minLevel: rule.minLevel, productionOnly: rule.productionOnly, channel: rule.channel } : EMPTY);
  const [touched, setTouched] = useState<{ name?: boolean; channel?: boolean }>({});
  const [busy, setBusy] = useState(false);
  const preview = usePreview(d);
  const nameErr = touched.name && !d.name.trim() ? 'Give the rule a name.' : null;
  const channelErr = touched.channel && !CHANNEL.test(d.channel.trim()) ? 'A Slack channel name: letters, digits, dots, dashes and underscores, like #security.' : null;
  const valid = d.name.trim() !== '' && CHANNEL.test(d.channel.trim());

  const save = async () => {
    setTouched({ name: true, channel: true });
    if (!valid) return;
    setBusy(true);
    try {
      const body = { name: d.name.trim(), minLevel: d.minLevel, productionOnly: d.productionOnly, channel: d.channel.trim() };
      if (rule) await incidentsApi.updateAlertRule(rule.id, body);
      else await incidentsApi.createAlertRule(body);
      toast.success(rule ? 'Rule saved' : 'Rule created', { description: `${body.name}: ${ruleWhen(body)}` });
      onSaved();
    } catch (e) {
      toast.error('Could not save the rule', { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!rule) return;
    setBusy(true);
    try {
      await incidentsApi.deleteAlertRule(rule.id);
      toast.success('Rule deleted', { description: rule.name });
      onSaved();
    } catch (e) {
      toast.error('Could not delete the rule', { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setTouched((t) => ({ ...t, channel: true }));
    if (!CHANNEL.test(d.channel.trim())) return;
    setBusy(true);
    try {
      await incidentsApi.testAlertRule(d.channel.trim());
      toast.success('Test message sent', { description: `To ${d.channel.trim().replace(/^#?/, '#')} through the Slack webhook` });
    } catch (e) {
      toast.error('The test message was not sent', { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const n = preview.data?.count;
  const noHook = !list.webhook.configured;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-[var(--sheet-w,440px)] max-w-full flex-col gap-0 sm:max-w-[440px]">
        <SheetHeader className="border-b">
          <SheetTitle>{rule ? 'Edit rule' : 'New rule'}</SheetTitle>
          <SheetDescription>Team rules post to the Slack webhook, naming the channel.</SheetDescription>
        </SheetHeader>
        <form
          className="flex grow flex-col gap-4 overflow-y-auto p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-name`} className="text-label font-medium">
              Name <span aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
            </label>
            <Input id={`${id}-name`} value={d.name} disabled={!allowed} onChange={(e) => setD({ ...d, name: e.target.value })} onBlur={() => setTouched((t) => ({ ...t, name: true }))} aria-invalid={!!nameErr} aria-describedby={nameErr ? `${id}-name-err` : undefined} />
            {nameErr && (
              <span id={`${id}-name-err`} className="text-label text-destructive">
                {nameErr}
              </span>
            )}
          </div>
          <fieldset className="flex flex-col gap-2 rounded-lg border p-3" disabled={!allowed}>
            <legend className="px-1 text-label font-semibold">When</legend>
            <span className="text-text-secondary">A new alert's severity is at least</span>
            <div role="radiogroup" aria-label="Minimum severity" className="flex flex-wrap gap-1.5">
              {LEVELS.map((l) => {
                const on = d.minLevel === l;
                return (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setD({ ...d, minLevel: l })}
                    className={cn('h-7 rounded-lg border px-2.5 text-label outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', on ? 'border-selection bg-selection-soft font-semibold text-selection' : 'border-input bg-background')}
                  >
                    <span aria-hidden="true">{SEVERITY_GLYPH[l]} </span>
                    {SEVERITY_LABEL[l]}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-2">
              <Checkbox checked={d.productionOnly} onCheckedChange={(v) => setD({ ...d, productionOnly: v === true })} />
              Only when it reaches production
            </label>
            <span className="text-caption text-muted-foreground">An alert whose severity is not known always matches.</span>
          </fieldset>
          <fieldset className="flex flex-col gap-2 rounded-lg border p-3" disabled={!allowed}>
            <legend className="px-1 text-label font-semibold">Then</legend>
            <label htmlFor={`${id}-ch`} className="text-label font-medium">
              Slack channel <span aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
            </label>
            <Input id={`${id}-ch`} value={d.channel} placeholder="#security" onChange={(e) => setD({ ...d, channel: e.target.value })} onBlur={() => setTouched((t) => ({ ...t, channel: true }))} aria-invalid={!!channelErr} aria-describedby={`${id}-ch-why${channelErr ? ` ${id}-ch-err` : ''}`} />
            {channelErr && (
              <span id={`${id}-ch-err`} className="text-label text-destructive">
                {channelErr}
              </span>
            )}
            <span id={`${id}-ch-why`} className="text-caption text-muted-foreground">
              Sent through the configured Slack webhook with this channel named; a Slack app webhook posts to the channel it was made for.
            </span>
            <label className="flex items-center gap-2 text-muted-foreground">
              <Checkbox checked={false} disabled aria-describedby={`${id}-mail`} />
              Also email the affected projects' owners
            </label>
            <span id={`${id}-mail`} className="text-caption text-muted-foreground">
              Not available: no email sender is configured on this server.
            </span>
          </fieldset>
          <div className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2.5" aria-live="polite">
            {preview.error ? (
              <span className="text-label text-destructive">Could not count past alerts: {preview.error}</span>
            ) : n === undefined ? (
              <span className="text-text-secondary">Counting the last 30 days…</span>
            ) : (
              <>
                <span className="font-semibold">
                  Would have sent {n} {n === 1 ? 'alert' : 'alerts'} in the last 30 days
                </span>
                <span className="text-caption text-text-secondary">
                  {n > 30
                    ? 'That is more than one a day. Consider raising the severity or limiting it to production.'
                    : preview.data?.mostRecent
                      ? `Most recent: ${decodeURIComponent(preview.data.mostRecent.purl.replace(/^pkg:npm\//, ''))} in ${preview.data.mostRecent.projectName}, ${fmtTime(preview.data.mostRecent.createdAt)}.`
                      : 'None in the last 30 days.'}
                </span>
              </>
            )}
          </div>
          {!allowed && <NotAllowedHint permission="manage_alert_rules" />}
        </form>
        <SheetFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t">
          {rule && allowed && (
            <Button type="button" variant="ghost" size="sm" className="mr-auto h-7 text-label text-destructive" onClick={remove} disabled={busy}>
              Delete rule
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="h-7 text-label" onClick={test} disabled={!allowed || noHook || busy} aria-describedby={noHook ? `${id}-nohook` : undefined}>
            Send a test message
          </Button>
          <Button type="button" size="sm" className="h-7 text-label" onClick={save} disabled={!allowed || busy}>
            Save rule
          </Button>
          {noHook && (
            <span id={`${id}-nohook`} className="w-full text-right text-caption text-muted-foreground">
              No Slack webhook is configured (BLASTRADIUS_ALERT_WEBHOOK), so nothing can be sent yet.
            </span>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function RulesTable({ list, onOpen, onToggle }: { list: ListAlertRulesResponse; onOpen: (id: string) => void; onToggle: (r: AlertRule, on: boolean) => void }) {
  const { can } = useAuth();
  const allowed = can('manage_alert_rules');
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Alert rules" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-4 py-2 font-medium">Rule</th>
            <th scope="col" className="px-2 py-2 font-medium">Sends to</th>
            <th scope="col" className="px-2 py-2 font-medium">Last 30 days</th>
            <th scope="col" className="px-4 py-2 font-medium">On</th>
          </tr>
        </thead>
        <tbody>
          {list.usingDefault && (
            <tr className="border-t">
              <td className="px-4 py-2.5">
                <span className="font-medium">Every new alert</span>
                <span className="block text-caption text-muted-foreground">Built-in default: applies while no rule exists</span>
              </td>
              <td className="px-2 py-2.5 text-text-secondary">The webhook's own channel</td>
              <td className="px-2 py-2.5 text-text-secondary">every alert</td>
              <td className="px-4 py-2.5 text-label text-text-secondary">{list.webhook.configured ? 'On' : 'Off: no webhook'}</td>
            </tr>
          )}
          {list.items.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="px-4 py-2.5">
                <button type="button" onClick={() => onOpen(r.id)} className="text-left font-medium text-selection underline-offset-2 hover:underline">
                  {r.name}
                </button>
                <span className="block text-caption text-muted-foreground">{ruleWhen(r)}</span>
              </td>
              <td className="px-2 py-2.5 font-mono text-[12px]">{r.channel}</td>
              <td className="px-2 py-2.5">
                {r.lastThirtyDays} {r.lastThirtyDays === 1 ? 'alert' : 'alerts'}
              </td>
              <td className="px-4 py-2.5">
                <Switch checked={r.enabled} disabled={!allowed} onCheckedChange={(on) => onToggle(r, on)} aria-label={`${r.name}: ${r.enabled ? 'on' : 'off'}`} title={allowed ? undefined : needsPermissionText('manage_alert_rules')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Alerts() {
  const { me, can } = useAuth();
  const [sp] = useSearchParams();
  const update = useUpdateParams();
  const allowed = can('manage_alert_rules');
  const { data, error, loading, reload } = useApi((s) => incidentsApi.alertRules(s), []);
  const ruleParam = sp.get('rule');
  const crumbs = [
    { label: me?.org?.name ?? 'Organization', to: '/' },
    { label: 'Alerts', to: '/alerts' },
  ];
  const open = (id: string) => update({ rule: id });
  const close = () => update({ rule: null });
  const toggle = async (r: AlertRule, on: boolean) => {
    try {
      await incidentsApi.updateAlertRule(r.id, { enabled: on });
      reload();
    } catch (e) {
      toast.error('Could not change the rule', { description: (e as Error).message });
    }
  };
  const editing = data && ruleParam ? (ruleParam === 'new' ? null : (data.items.find((r) => r.id === ruleParam) ?? undefined)) : undefined;

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title="Alerts"
        meta="team rules for new advisories"
        actions={
          <span className="flex items-center gap-2">
            {!allowed && <NotAllowedHint id="new-rule-hint" permission="manage_alert_rules" className="hidden md:inline" />}
            <Button size="sm" className="h-7 px-3 text-label" onClick={() => open('new')} disabled={!allowed || !data} aria-describedby={allowed ? undefined : 'new-rule-hint'}>
              New rule
            </Button>
          </span>
        }
      />
      <div className="flex max-w-5xl flex-col gap-4 p-4">
        <p className="m-0 text-text-secondary">Team rules post new alerts to Slack. Each one says how many alerts it would have sent in the last 30 days.</p>
        {data && !data.webhook.configured && (
          <p role="note" className="m-0 rounded-lg border border-dashed px-3 py-2 text-label text-text-secondary">
            No Slack webhook is configured (set <span className="font-mono">BLASTRADIUS_ALERT_WEBHOOK</span> on the server). Rules are saved, but nothing is sent until one is.
          </p>
        )}
        {loading && !data && <StateBlock kind="loading" label="Loading alert rules" rows={2} columns={4} />}
        {error && !data && <StateBlock kind="error" title="Could not load alert rules" cause={error.message} onRetry={reload} />}
        {data && <RulesTable list={data} onOpen={open} onToggle={toggle} />}
        <AlertsCard />
      </div>
      {data && editing !== undefined && (
        <RuleSheet
          key={ruleParam ?? 'none'}
          rule={editing}
          list={data}
          onClose={close}
          onSaved={() => {
            close();
            reload();
          }}
        />
      )}
    </>
  );
}
