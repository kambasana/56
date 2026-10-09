/**
 * Timeline (design system: Timeline): a lifecycle strip (released → first warning → advisory →
 * fixed, only the phases the data knows) and a vertical, time-stamped list of typed events. A
 * change shows as from → to, the old value struck through.
 */
import type { ReactNode } from 'react';
import { fmtTime } from '@/lib/cn';
import { cn } from '@/lib/utils';

export interface LifecyclePhase {
  label: string;
  value: ReactNode;
  /** Accent on the top border: severity for the release, warning for the first warning. */
  accent?: 'critical' | 'warning' | 'none';
}

const ACCENT: Record<NonNullable<LifecyclePhase['accent']>, string> = { critical: 'border-t-sev-critical', warning: 'border-t-sev-high', none: 'border-t-border' };

export function LifecycleStrip({ phases, label = 'Lifecycle' }: { phases: readonly LifecyclePhase[]; label?: string }) {
  if (phases.length === 0) return null;
  return (
    <ol aria-label={label} data-slot="lifecycle" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {phases.map((p) => (
        <li key={p.label} className={cn('flex min-w-36 flex-1 flex-col gap-0.5 border-t-[3px] bg-card px-2.5 py-2', ACCENT[p.accent ?? 'none'])}>
          <span className="text-eyebrow font-semibold tracking-[.08em] text-muted-foreground uppercase">{p.label}</span>
          <span className="font-medium">{p.value}</span>
        </li>
      ))}
    </ol>
  );
}

export type TimelineKind = 'release' | 'publisher' | 'install-script' | 'advisory' | 'alert' | 'check' | 'notified' | 'status' | 'account';

/** A glyph per event type (never colour alone; the title says it too). */
const ICON: Record<TimelineKind, string> = {
  release: '◇',
  publisher: '↻',
  'install-script': '+',
  advisory: '◆',
  alert: '!',
  check: '✓',
  notified: '→',
  status: '›',
  account: '⚑',
};

export interface TimelineEvent {
  at: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  from?: string | null;
  to?: string | null;
}

/** "Status: Investigating → Fixing"-style change, old value struck through. */
function Change({ from, to }: { from: string; to: string }) {
  return (
    <span className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-[12px]">
      <span className="rounded-[6px] bg-muted px-1.5 text-muted-foreground line-through">
        <span className="sr-only">from </span>
        {from}
      </span>
      <span aria-hidden="true">→</span>
      <span className="rounded-[6px] bg-selection-soft px-1.5 font-medium text-selection">
        <span className="sr-only">to </span>
        {to}
      </span>
    </span>
  );
}

export function EventTimeline({ events, label = 'Timeline', empty = 'Nothing recorded yet.' }: { events: readonly TimelineEvent[]; label?: string; empty?: string }) {
  if (events.length === 0) return <p className="m-0 text-caption text-muted-foreground">{empty}</p>;
  return (
    <ol aria-label={label} data-slot="timeline" className="m-0 flex list-none flex-col gap-3 p-0">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} data-kind={e.kind} className="grid grid-cols-[92px_18px_minmax(0,1fr)] gap-2">
          <time dateTime={e.at} className="text-caption text-muted-foreground">
            {fmtTime(e.at)}
          </time>
          <span aria-hidden="true" className="flex h-[18px] items-center justify-center rounded-full border-2 border-node-border bg-background text-[10px] leading-none font-semibold text-text-secondary">
            {ICON[e.kind]}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{e.title}</span>
            {e.detail && <span className="text-caption break-words text-text-secondary">{e.detail}</span>}
            {e.from && e.to && <Change from={e.from} to={e.to} />}
          </span>
        </li>
      ))}
    </ol>
  );
}
