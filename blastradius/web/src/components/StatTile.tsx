import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type StatTone = 'default' | 'critical' | 'high' | 'muted' | 'success';

const toneClass: Record<StatTone, string> = {
  default: 'text-foreground',
  critical: 'text-destructive',
  high: 'text-warning',
  muted: 'text-muted-foreground',
  success: 'text-success',
};

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  className?: string;
}

/** Compact KPI tile: small label, large tabular number, optional hint line. */
export function StatTile({ label, value, hint, tone = 'default', className }: StatTileProps) {
  return (
    <div className={cn('flex min-w-[140px] flex-1 flex-col gap-0.5 rounded-lg border bg-card px-4 py-3 text-card-foreground', className)}>
      <span className="text-xs leading-4 text-muted-foreground">{label}</span>
      <span className={cn('font-mono text-xl font-semibold leading-7 tabular-nums', toneClass[tone])}>{value}</span>
      {hint !== undefined && <span className="text-xs leading-4 text-muted-foreground">{hint}</span>}
    </div>
  );
}
