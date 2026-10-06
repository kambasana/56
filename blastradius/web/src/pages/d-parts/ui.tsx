/** Small presentational pieces shared by the Track D screens. */
import type { ReactNode } from 'react';
import type { FindingStatus, RiskLevel, ScanStatus } from '@server/api-types';
import { Badge } from '@/components/Badge';
import { cn, fmtNum } from '@/lib/cn';
import { LEVELS, SCAN_STATUS_LABELS, STATUS_LABELS } from './format';

const LEVEL_TEXT: Record<RiskLevel, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const LEVEL_DOT: Record<RiskLevel, string> = {
  critical: 'bg-destructive',
  high: 'bg-warning',
  medium: 'bg-foreground/60',
  low: 'bg-muted-foreground/40',
};

/**
 * Toggle chips for risk levels, with counts. No level selected means "all levels".
 * Each chip is a real button with aria-pressed, so it works from the keyboard.
 */
export function LevelChips({
  selected,
  counts,
  onChange,
  label = 'Filter by level',
}: {
  selected: readonly RiskLevel[];
  counts: Record<RiskLevel, number>;
  onChange: (next: RiskLevel[]) => void;
  label?: string;
}) {
  const toggle = (l: RiskLevel) => {
    const next = selected.includes(l) ? selected.filter((x) => x !== l) : [...selected, l];
    onChange(LEVELS.filter((x) => next.includes(x)));
  };
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {LEVELS.map((l) => {
        const on = selected.includes(l);
        return (
          <button
            key={l}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(l)}
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium',
              on ? 'border-foreground/30 bg-accent text-foreground' : 'border-dashed text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <span aria-hidden="true" className={cn('size-2 rounded-full', LEVEL_DOT[l])} />
            {LEVEL_TEXT[l]}
            <span className="font-mono tabular-nums opacity-80">{fmtNum(counts[l] ?? 0)}</span>
          </button>
        );
      })}
      {selected.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="h-7 cursor-pointer rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          Clear
        </button>
      )}
    </div>
  );
}

/** "2 · 5 · 1 · 0" critical/high/medium/low counts, coloured like the canvas. */
export function LevelCounts({ counts, className }: { counts: Record<RiskLevel, number>; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono tabular-nums', className)}>
      <span className={counts.critical ? 'font-semibold text-destructive' : 'text-muted-foreground'} title="Critical">
        {fmtNum(counts.critical)}
      </span>
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <span className={counts.high ? 'font-semibold text-warning' : 'text-muted-foreground'} title="High">
        {fmtNum(counts.high)}
      </span>
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <span className="text-muted-foreground" title="Medium">{fmtNum(counts.medium)}</span>
      <span aria-hidden="true" className="text-muted-foreground">·</span>
      <span className="text-muted-foreground" title="Low">{fmtNum(counts.low)}</span>
      <span className="sr-only">
        {`${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`}
      </span>
    </span>
  );
}

export function StatusBadge({ status }: { status: FindingStatus }) {
  return (
    <Badge variant={status === 'new' ? 'outline' : 'secondary'} className={status === 'accepted_risk' ? 'text-muted-foreground' : undefined}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

const SCAN_TONE: Record<ScanStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-info border-info/40',
  succeeded: 'text-success border-success/40',
  failed: 'text-destructive border-destructive/40',
};

export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  return (
    <Badge variant="outline" className={SCAN_TONE[status]} data-status={status}>
      {(status === 'running' || status === 'queued') && <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-current" />}
      {SCAN_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Titled block inside a side panel or detail page. */
export function Section({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2 py-3 first:pt-0', className)}>
      <div className="flex flex-col gap-0.5">
        <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
        {hint && <p className="m-0 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Tiny inline bar for 0–100 or 0–1 values. */
export function Meter({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-muted align-middle">
      <span className="block h-full bg-foreground/60" style={{ width: `${pct}%` }} />
    </span>
  );
}
