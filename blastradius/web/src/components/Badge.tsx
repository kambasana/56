import type { HTMLAttributes } from 'react';
import type { RiskLevel } from '@server/api-types';
import { cn } from '@/lib/cn';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

const variants: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'border-border text-foreground',
  destructive: 'border-transparent bg-destructive text-destructive-foreground',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = 'secondary', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium leading-4',
        variants[variant],
        className,
      )}
      {...rest}
    />
  );
}

export const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low'];

/** Same mapping as the design canvas: critical filled red, high amber outline, medium outline, low muted. */
const LEVEL_STYLE: Record<RiskLevel, { variant: BadgeVariant; className: string; label: string }> = {
  critical: { variant: 'destructive', className: '', label: 'Critical' },
  high: { variant: 'outline', className: 'text-warning border-warning/40', label: 'High' },
  medium: { variant: 'outline', className: '', label: 'Medium' },
  low: { variant: 'secondary', className: 'text-muted-foreground', label: 'Low' },
};

export function levelLabel(level: RiskLevel): string {
  return LEVEL_STYLE[level]?.label ?? level;
}

/** Risk level badge (critical / high / medium / low), optionally with the score. */
export function RiskBadge({ level, score, className }: { level: RiskLevel; score?: number; className?: string }) {
  const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.low;
  return (
    <Badge variant={s.variant} className={cn(s.className, className)} data-level={level}>
      {s.label}
      {score !== undefined && <span className="font-mono opacity-80">{Math.round(score)}</span>}
    </Badge>
  );
}
