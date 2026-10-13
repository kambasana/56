/**
 * Presentational pieces shared by the Track D screens, composed from the shadcn/ui components
 * in @/components/ui (Badge, Card, Popover + Command, HoverCard, Skeleton) and theme tokens.
 */
import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Check, CircleCheck, CircleDashed, CirclePlus, CircleX, LoaderCircle } from 'lucide-react';
import type { FindingStatus, RiskLevel, ScanStatus } from '@server/api-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fmtNum } from '@/lib/cn';
import { LEVELS, SCAN_STATUS_LABELS, STATUS_LABELS } from './format';

const LEVEL_TEXT: Record<RiskLevel, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const LEVEL_DOT: Record<RiskLevel, string> = {
  critical: 'bg-level-critical',
  high: 'bg-level-high',
  medium: 'bg-level-medium',
  low: 'bg-level-low',
};

function LevelDot({ level }: { level: RiskLevel }) {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', LEVEL_DOT[level])} />;
}

/**
 * Faceted "Level" filter (the shadcn data-table faceted filter: Popover + Command), controlled
 * by the caller so the selection can live in the URL. No level selected means every level.
 */
export function LevelFacet({
  selected,
  counts,
  onChange,
  title = 'Level',
}: {
  selected: readonly RiskLevel[];
  counts: Record<RiskLevel, number>;
  onChange: (next: RiskLevel[]) => void;
  title?: string;
}) {
  const toggle = (l: RiskLevel) => {
    const next = selected.includes(l) ? selected.filter((x) => x !== l) : [...selected, l];
    onChange(LEVELS.filter((x) => next.includes(x)));
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 border-dashed" aria-label={`Filter by ${title.toLowerCase()}${selected.length ? `: ${selected.map((l) => LEVEL_TEXT[l]).join(', ')}` : ''}`}>
          <CirclePlus />
          {title}
          {selected.length > 0 && (
            <>
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
              <span className="flex gap-1">
                {selected.map((l) => (
                  <Badge key={l} variant="secondary" className="rounded-sm px-1 font-normal">
                    {LEVEL_TEXT[l]}
                  </Badge>
                ))}
              </span>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command aria-label={`Filter by ${title.toLowerCase()}`}>
          <CommandList>
            <CommandGroup>
              {LEVELS.map((l) => {
                const on = selected.includes(l);
                return (
                  <CommandItem key={l} value={l} onSelect={() => toggle(l)} data-checked={on}>
                    <span
                      className={cn(
                        'flex size-4 items-center justify-center rounded-[4px] border',
                        on ? 'border-primary bg-primary text-primary-foreground' : 'border-input [&_svg]:invisible',
                      )}
                    >
                      <Check className="size-3.5 text-primary-foreground" />
                    </span>
                    <LevelDot level={l} />
                    <span>{LEVEL_TEXT[l]}</span>
                    {on && <span className="sr-only">, selected</span>}
                    <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{fmtNum(counts[l] ?? 0)}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selected.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="clear-filters" onSelect={() => onChange([])} className="justify-center text-center">
                    Clear filters
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** "2 · 5 · 1 · 0" critical/high/medium/low counts, coloured with the level tokens. */
export function LevelCounts({ counts, className }: { counts: Record<RiskLevel, number>; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-xs tabular-nums', className)}>
      <span aria-hidden="true" className={counts.critical ? 'font-semibold text-level-critical' : 'text-muted-foreground'}>
        {fmtNum(counts.critical)}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/60">·</span>
      <span aria-hidden="true" className={counts.high ? 'font-semibold text-level-high' : 'text-muted-foreground'}>
        {fmtNum(counts.high)}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/60">·</span>
      <span aria-hidden="true" className="text-muted-foreground">{fmtNum(counts.medium)}</span>
      <span aria-hidden="true" className="text-muted-foreground/60">·</span>
      <span aria-hidden="true" className="text-muted-foreground">{fmtNum(counts.low)}</span>
      <span className="sr-only">{`${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`}</span>
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
  running: 'border-info/40 text-info',
  succeeded: 'border-success/40 text-success',
  failed: 'border-destructive/40 text-destructive',
};

const SCAN_ICON: Record<ScanStatus, ReactNode> = {
  queued: <CircleDashed aria-hidden="true" />,
  running: <LoaderCircle aria-hidden="true" className="animate-spin" />,
  succeeded: <CircleCheck aria-hidden="true" />,
  failed: <CircleX aria-hidden="true" />,
};

export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  return (
    <Badge variant="outline" className={SCAN_TONE[status]} data-status={status}>
      {SCAN_ICON[status]}
      {SCAN_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Titled block inside a side panel: a small heading, optional hint, then content. */
export function Section({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2 py-4 first:pt-0 last:pb-0', className)}>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * A shadcn Card used as a page section: heading (h2), optional description and action, and a
 * body. `flush` removes the body padding for tables and edge-to-edge lists.
 */
export function SectionCard({
  id,
  title,
  description,
  action,
  children,
  flush = false,
  className,
  contentClassName,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card role="region" aria-labelledby={`${id}-title`} className={cn('min-w-0 gap-0 overflow-hidden py-0', className)}>
      <CardHeader className="gap-1 border-b px-4 py-3 [.border-b]:pb-3">
        <CardTitle role="heading" aria-level={2} id={`${id}-title`} className="text-sm">
          {title}
        </CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn(flush ? 'p-0' : 'px-4 py-3', 'text-sm', contentClassName)}>{children}</CardContent>
    </Card>
  );
}

/** Two-column term/value grid used by the panels. */
export function DetailList({ items, className }: { items: [term: ReactNode, value: ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-sm', className)}>
      {items.map(([t, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{t}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Text clamped to `lines` lines; hovering (or focusing) shows the whole text in a HoverCard.
 * The full text stays in the DOM, so screen readers and the table filter see all of it.
 *
 * Pressing the pointer on the text (e.g. clicking a table row to open its side panel) closes the
 * card and keeps it closed until the pointer leaves: otherwise the pending open delay fires after
 * the panel has opened, the card lands on top of it and swallows the first Escape.
 */
export function ClampedText({ children, full, lines = 2, className }: { children: ReactNode; full: ReactNode; lines?: 1 | 2 | 3; className?: string }) {
  const [open, setOpen] = useState(false);
  const suppressed = useRef(false);
  return (
    <HoverCard openDelay={250} closeDelay={80} open={open} onOpenChange={(next) => setOpen(next && !suppressed.current)}>
      <HoverCardTrigger
        asChild
        onPointerDown={() => {
          suppressed.current = true;
          setOpen(false);
        }}
        onPointerLeave={() => {
          suppressed.current = false;
        }}
      >
        <span className={cn('block', lines === 1 ? 'line-clamp-1' : lines === 2 ? 'line-clamp-2' : 'line-clamp-3', className)}>{children}</span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-96 text-sm">
        {full}
      </HoverCardContent>
    </HoverCard>
  );
}

/** Tiny inline bar for 0–100 or 0–1 values. */
export function Meter({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-muted align-middle">
      <span className="block h-full bg-primary/60" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Skeleton page body: KPI cards and a table block, announced as loading. */
export function PageSkeleton({ label = 'Loading…', tiles = 0, rows = 6 }: { label?: string; tiles?: number; rows?: number }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="flex flex-col gap-4 px-4 py-4">
      <span className="sr-only">{label}</span>
      {tiles > 0 && (
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: tiles }, (_, i) => (
            <Skeleton key={i} className="h-[92px] min-w-[140px] flex-1 rounded-xl" />
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-xl border p-4">
        <Skeleton className="h-5 w-48" />
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

export type SectionCardProps = ComponentProps<typeof SectionCard>;
