/**
 * App badges on top of the shadcn/ui Badge (components/ui/badge.tsx).
 *
 * RiskBadge maps the four risk levels to theme tokens defined in index.css
 * (--level-critical = destructive, --level-high = orange, --level-medium = amber,
 * --level-low = muted), so light and dark mode stay consistent.
 */
import type { ComponentProps } from 'react';
import { cva } from 'class-variance-authority';
import type { RiskLevel } from '@server/api-types';
import { Badge as UiBadge, badgeVariants } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'ghost' | 'link';

export type BadgeProps = ComponentProps<typeof UiBadge>;

/** shadcn Badge; defaults to the "secondary" variant (the app's neutral chip). */
export function Badge({ variant = 'secondary', ...props }: BadgeProps) {
  return <UiBadge variant={variant} {...props} />;
}

export { badgeVariants };

export const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low'];

const LABELS: Record<RiskLevel, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export const levelBadgeVariants = cva('', {
  variants: {
    level: {
      critical: 'border-transparent bg-level-critical text-white dark:bg-level-critical/60',
      high: 'border-level-high/40 bg-level-high/10 text-level-high',
      medium: 'border-level-medium/40 bg-level-medium/10 text-level-medium',
      low: 'border-transparent bg-secondary text-level-low',
    },
  },
  defaultVariants: { level: 'low' },
});

export function levelLabel(level: RiskLevel): string {
  return LABELS[level] ?? level;
}

/** Risk level badge (critical / high / medium / low), optionally with the score. */
export function RiskBadge({ level, score, className }: { level: RiskLevel; score?: number; className?: string }) {
  const lv: RiskLevel = level in LABELS ? level : 'low';
  return (
    <UiBadge variant="outline" className={cn(levelBadgeVariants({ level: lv }), className)} data-level={lv}>
      {levelLabel(lv)}
      {score !== undefined && <span className="font-mono tabular-nums">{Math.round(score)}</span>}
    </UiBadge>
  );
}
