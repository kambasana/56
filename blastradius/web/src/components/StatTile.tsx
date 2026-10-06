import type { ReactNode } from 'react';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type StatTone = 'default' | 'critical' | 'high' | 'muted' | 'success';

const toneClass: Record<StatTone, string> = {
  default: 'text-foreground',
  critical: 'text-destructive',
  high: 'text-level-high',
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

/** Compact KPI card (shadcn Card, the dashboard "section cards" layout). */
export function StatTile({ label, value, hint, tone = 'default', className }: StatTileProps) {
  return (
    <Card className={cn('@container/card min-w-[140px] flex-1 gap-2 py-4', className)}>
      <CardHeader className="gap-1 px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn('font-mono text-2xl font-semibold tabular-nums', toneClass[tone])}>{value}</CardTitle>
      </CardHeader>
      {hint !== undefined && <CardFooter className="px-4 text-xs text-muted-foreground">{hint}</CardFooter>}
    </Card>
  );
}
