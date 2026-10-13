import { cn } from '@/lib/utils';
import { isSeverity, SEVERITY_GLYPH, SEVERITY_LABEL, type Severity } from './severity';

export interface SeverityBadgeProps {
  level: Severity;
  /**
   * `filled` (default): glyph and word on the `sev-*-soft` fill, for headers and sheets.
   * `plain`: glyph and word in `sev-*` ink, no fill, to keep table rows calm.
   */
  variant?: 'filled' | 'plain';
  /** `sm` in tables, `md` in headers. */
  size?: 'sm' | 'md';
  className?: string;
}

const INK: Record<Severity, string> = {
  critical: 'text-sev-critical',
  high: 'text-sev-high',
  medium: 'text-sev-medium',
  low: 'text-sev-low',
};
const FILL: Record<Severity, string> = {
  critical: 'bg-sev-critical-soft',
  high: 'bg-sev-high-soft',
  medium: 'bg-sev-medium-soft',
  low: 'bg-sev-low-soft',
};

/** A finding's one severity: shape, word and colour together, never colour alone. */
export function SeverityBadge({ level, variant = 'filled', size = 'sm', className }: SeverityBadgeProps) {
  const lv: Severity = isSeverity(level) ? level : 'low';
  return (
    <span
      data-slot="severity-badge"
      data-level={lv}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 font-semibold whitespace-nowrap',
        size === 'sm' ? 'text-label' : 'text-body',
        INK[lv],
        variant === 'filled' && ['rounded-[6px] px-2 py-0.5', FILL[lv]],
        className,
      )}
    >
      <span aria-hidden="true">{SEVERITY_GLYPH[lv]}</span>
      {SEVERITY_LABEL[lv]}
    </span>
  );
}
