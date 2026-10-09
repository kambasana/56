/**
 * Graph/Table (or Table/Heatmap) switch. The choice lives in the URL (`view=`) and pushes history,
 * so Back returns to the other view. The table is always the accessible equivalent of the graph.
 */
import { useSearchParams } from 'react-router';
import { useUpdateParams } from '@/components/br';
import { cn } from '@/lib/utils';

export interface ViewOption<V extends string> {
  value: V;
  label: string;
}

export interface ViewToggleProps<V extends string> {
  value: V;
  options: readonly ViewOption<V>[];
  onChange: (v: V) => void;
  label?: string;
  className?: string;
}

export function ViewToggle<V extends string>({ value, options, onChange, label = 'View', className }: ViewToggleProps<V>) {
  return (
    <div role="group" aria-label={label} data-slot="view-toggle" className={cn('inline-flex rounded-lg bg-muted p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-6 rounded-[6px] px-2.5 text-label outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              on ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-text-secondary hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** `view=` from the URL, with a default (omitted from the URL). */
export function useViewParam<V extends string>(values: readonly V[], fallback: V, key = 'view'): [V, (v: V) => void] {
  const [sp] = useSearchParams();
  const update = useUpdateParams();
  const raw = sp.get(key);
  const value = raw && (values as readonly string[]).includes(raw) ? (raw as V) : fallback;
  return [value, (v: V) => update({ [key]: v === fallback ? null : v })];
}
