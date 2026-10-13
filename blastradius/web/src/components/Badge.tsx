/**
 * App badges on top of the shadcn/ui Badge (components/ui/badge.tsx).
 *
 * RiskBadge shows a risk level as a shape, a word and the severity tokens (--sev-*, see
 * components/br/SeverityBadge for the design-system component new screens should use).
 */
import type { ComponentProps } from 'react';
import { cva } from 'class-variance-authority';
import type { RiskLevel } from '@server/api-types';
import { Badge as UiBadge, badgeVariants } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SEVERITY_GLYPH } from './br/severity';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'ghost' | 'link';

export type BadgeProps = ComponentProps<typeof UiBadge>;

/** shadcn Badge; defaults to the "secondary" variant (the app's neutral chip). */
export function Badge({ variant = 'secondary', ...props }: BadgeProps) {
  return <UiBadge variant={variant} {...props} />;
}

export { badgeVariants };

export const RISK_LEVELS: readonly RiskLevel[] = ['critical', 'high', 'medium', 'low'];

const LABELS: Record<RiskLevel, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** Severity tokens from the design system: glyph and word in sev-* ink on the sev-*-soft fill. */
export const levelBadgeVariants = cva('gap-1 border-transparent font-semibold', {
  variants: {
    level: {
      critical: 'bg-sev-critical-soft text-sev-critical',
      high: 'bg-sev-high-soft text-sev-high',
      medium: 'bg-sev-medium-soft text-sev-medium',
      low: 'bg-sev-low-soft text-sev-low',
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
      <span aria-hidden="true">{SEVERITY_GLYPH[lv]}</span>
      {levelLabel(lv)}
      {score !== undefined && <span className="font-mono tabular-nums">{Math.round(score)}</span>}
    </UiBadge>
  );
}
