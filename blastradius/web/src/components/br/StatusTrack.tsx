import { cn } from '@/lib/utils';

/** Finding life cycle (docs/UX.md §5). "Accepted risk" is a separate end state. */
export const FINDING_STEPS = ['Open', 'Triaged', 'Fixing', 'Resolved'] as const;
export const INCIDENT_STEPS = ['Investigating', 'Fixing', 'Monitoring', 'Closed'] as const;
export const ACCEPTED_RISK = 'Accepted risk';

export interface StatusTrackProps {
  steps: readonly string[];
  /** One of `steps`, or an end state outside the track such as "Accepted risk". */
  current: string;
  /** Accessible name of the list, e.g. "Finding status". */
  label?: string;
  className?: string;
}

/**
 * Where a finding or incident is in its life, under the page title. Read-only: moving forward is
 * the page's one primary action, not a click on the track.
 */
export function StatusTrack({ steps, current, label = 'Status', className }: StatusTrackProps) {
  const offTrack = !steps.includes(current);
  return (
    <div data-slot="status-track" className={cn('flex flex-wrap items-center gap-2', className)}>
      <ol aria-label={label} className="m-0 flex list-none flex-wrap gap-1 p-0 text-label">
        {steps.map((s, i) => {
          const on = s === current;
          return (
            <li
              key={s}
              aria-current={on ? 'step' : undefined}
              className={cn('rounded-[6px] px-2.5 py-0.5', on ? 'bg-selection-soft font-semibold text-selection' : 'text-muted-foreground')}
            >
              {i > 0 && <span aria-hidden="true">› </span>}
              {s}
            </li>
          );
        })}
      </ol>
      {offTrack && (
        <span aria-current="step" className="rounded-[6px] border border-input px-2.5 py-0.5 text-label font-semibold text-foreground">
          {current}
        </span>
      )}
    </div>
  );
}
