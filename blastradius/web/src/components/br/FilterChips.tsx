/**
 * FilterChips (promoted quick filters plus "All filters") and AppliedFilters (every applied value
 * as a removable chip, with "Clear all"). State lives in the URL through useFilters(): define
 * `filters` at module level so its identity is stable.
 */
import { useId, useState, type ReactNode } from 'react';
import { Info, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { appliedList, useFilters, type FilterDef, type QuickFilter } from './filters';

/** Lists longer than this get a search box (Baymard B7). */
const SEARCH_AT = 8;

const chip = 'inline-flex h-7 items-center rounded-lg border px-2.5 text-label transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none';

function FilterGroup({ def }: { def: FilterDef }) {
  const f = useFilters([def]);
  const [q, setQ] = useState('');
  const id = useId();
  const shown = def.options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 flex items-center gap-1 text-label font-medium">
        {def.label}
        {def.info && (
          <span title={def.info} className="inline-flex text-muted-foreground">
            <Info aria-hidden="true" className="size-3.5" />
            <span className="sr-only">({def.info})</span>
          </span>
        )}
      </legend>
      {def.options.length > SEARCH_AT && (
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${def.label.toLowerCase()}`} aria-label={`Search ${def.label}`} className="h-7" />
      )}
      {shown.map((o) => (
        <label key={o.value} htmlFor={`${id}-${o.value}`} className="flex items-center gap-2 text-body">
          <Checkbox id={`${id}-${o.value}`} checked={f.has(def.key, o.value)} onCheckedChange={() => f.toggle(def.key, o.value)} />
          {o.label}
        </label>
      ))}
      {shown.length === 0 && <span className="text-caption text-muted-foreground">No {def.label.toLowerCase()} matches "{q}".</span>}
    </fieldset>
  );
}

export interface FilterChipsProps {
  /** Every filter of the list (the "All filters" panel). */
  filters: readonly FilterDef[];
  /** The 3–5 most used filters as one-click chips (Critical, In production, New this week, Unassigned). */
  quick: readonly QuickFilter[];
  className?: string;
}

export function FilterChips({ filters, quick, className }: FilterChipsProps) {
  const f = useFilters(filters);
  return (
    <div role="group" aria-label="Quick filters" data-slot="filter-chips" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className="text-label text-muted-foreground">Quick filters</span>
      {quick.map((q) => {
        const on = f.has(q.key, q.value);
        return (
          <button
            key={`${q.key}=${q.value}`}
            type="button"
            aria-pressed={on}
            onClick={() => f.toggle(q.key, q.value)}
            className={cn(chip, on ? 'border-selection bg-selection-soft font-medium text-selection' : 'border-input bg-background text-foreground hover:bg-accent')}
          >
            {q.label}
          </button>
        );
      })}
      {filters.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className={cn(chip, 'gap-1 border-dashed border-input bg-transparent hover:bg-accent')}>
              <Plus aria-hidden="true" className="size-3.5" />
              All filters
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex max-h-[70vh] w-72 flex-col gap-4 overflow-y-auto">
            {filters.map((d) => (
              <FilterGroup key={d.key} def={d} />
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

export interface AppliedFiltersProps {
  filters: readonly FilterDef[];
  /** Result count line, e.g. "128 findings · showing 50". */
  count?: ReactNode;
  className?: string;
}

/** Every applied filter as a chip above the table, each removable, plus "Clear all". */
export function AppliedFilters({ filters, count, className }: AppliedFiltersProps) {
  const f = useFilters(filters);
  const applied = appliedList(f.values, filters);
  if (applied.length === 0 && !count) return null;
  return (
    <div data-slot="applied-filters" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {count && (
        <span className="text-label text-muted-foreground" aria-live="polite">
          {count}
        </span>
      )}
      {applied.length > 0 && (
        <ul aria-label="Applied filters" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {applied.map((a) => (
            <li key={`${a.key}=${a.value}`}>
              <button
                type="button"
                onClick={() => f.remove(a.key, a.value)}
                aria-label={`Remove filter ${a.text}`}
                className="inline-flex h-6 items-center gap-1.5 rounded-[6px] bg-selection-soft px-2 text-label font-medium text-selection outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {a.text}
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {applied.length > 0 && (
        <Button variant="link" size="xs" className="h-6 px-1 text-label text-selection underline" onClick={f.clearAll}>
          Clear all
        </Button>
      )}
    </div>
  );
}
