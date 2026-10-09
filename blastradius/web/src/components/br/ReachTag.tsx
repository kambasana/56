import { cn } from '@/lib/utils';
import { REACH_LABEL, REACH_SHORT, type Reach } from './severity';

export interface ReachTagProps {
  reach: Reach;
  /** Shows "<count> prod" / "<count> dev" instead of the full label, e.g. in a Projects column. */
  count?: number;
  className?: string;
}

const STYLE: Record<Reach, string> = {
  production: 'border-solid border-reach-prod text-reach-prod font-semibold',
  dev: 'border-dashed border-reach-dev text-reach-dev',
  unknown: 'border-dashed border-border text-muted-foreground',
};

/**
 * Where a package runs. Production is full-weight ink with a solid outline; dev and test is muted
 * with a dashed outline. Never a hue: severity owns colour.
 */
export function ReachTag({ reach, count, className }: ReachTagProps) {
  const text = count === undefined ? REACH_LABEL[reach] : `${count} ${REACH_SHORT[reach]}`;
  return (
    <span
      data-slot="reach-tag"
      data-reach={reach}
      title={count === undefined ? undefined : REACH_LABEL[reach]}
      className={cn('inline-flex w-fit shrink-0 items-center rounded-[6px] border px-2 text-caption whitespace-nowrap', STYLE[reach], className)}
    >
      {count !== undefined && <span className="sr-only">{REACH_LABEL[reach]}: </span>}
      {text}
    </span>
  );
}
