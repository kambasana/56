import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface BulkAction {
  label: string;
  onSelect: () => void;
  /** Disabled actions stay visible; give the reason (e.g. "Needs the Accept risk permission: ask an admin"). */
  disabledReason?: string;
}

export interface BulkBarProps {
  /** Selected rows; the bar is hidden at 0. */
  count: number;
  /** Set status · Assign · Accept risk… · Create ticket. Pass nodes for menus (e.g. a status dropdown). */
  actions: readonly (BulkAction | ReactNode)[];
  onClear: () => void;
  /** The outcome of the last action, e.g. "4 set to Triaged" (announced politely). */
  status?: ReactNode;
  className?: string;
}

function isAction(a: unknown): a is BulkAction {
  return typeof a === 'object' && a !== null && 'label' in a && 'onSelect' in a;
}

const btn = 'h-7 rounded-lg bg-primary-foreground/15 px-2.5 text-label text-primary-foreground outline-none hover:bg-primary-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-60';

/**
 * Floating bar centred over the bottom of a list once rows are selected. It is fixed, so it never
 * shifts the table.
 */
export function BulkBar({ count, actions, onClear, status, className }: BulkBarProps) {
  if (count <= 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Bulk actions"
        data-slot="bulk-bar"
        className={cn('pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-xl bg-primary py-1.5 pr-1.5 pl-3.5 text-primary-foreground shadow-elev-2', className)}
      >
        <span className="mr-1.5 font-semibold">{count} selected</span>
        {actions.map((a, i) =>
          isAction(a) ? (
            <button key={a.label} type="button" className={btn} onClick={a.onSelect} disabled={!!a.disabledReason} title={a.disabledReason}>
              {a.label}
              {a.disabledReason && <span className="sr-only"> ({a.disabledReason})</span>}
            </button>
          ) : (
            <span key={i}>{a}</span>
          ),
        )}
        <button type="button" aria-label="Clear selection" className={cn(btn, 'bg-transparent')} onClick={onClear}>
          <X aria-hidden="true" className="size-4" />
        </button>
        <span role="status" aria-live="polite" className={cn('text-label', status ? 'ml-1 pr-2' : 'sr-only')}>
          {status}
        </span>
      </div>
    </div>
  );
}
