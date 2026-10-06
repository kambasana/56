/**
 * DataTable: the table every screen uses (table-first UI, PLAN §12), built the shadcn/ui
 * "data-table" way: TanStack Table state rendered with the shadcn Table primitives, a
 * toolbar with a filter Input, faceted column filters (Popover + Command), a column
 * visibility DropdownMenu and sortable header Buttons.
 *
 * Rows are virtualised with TanStack Virtual past `virtualizeAbove` (5k+ rows stay smooth).
 * Clicking a row (or Enter on a focused row) selects it; with `renderPanel` the row opens a
 * Sheet (see SidePanel). Arrow keys move between rows.
 *
 * Cell values are rendered as React text (escaped). Never pass untrusted HTML.
 */
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type Row,
  type SortingState,
  type Table as TanTable,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, CirclePlus, Settings2, X } from 'lucide-react';
import type { RiskLevel } from '@server/api-types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { fmtNum } from '@/lib/cn';
import { EmptyState } from './EmptyState';
import { levelLabel, RISK_LEVELS } from './Badge';

export type { ColumnDef } from '@tanstack/react-table';

export interface FacetOption {
  label: string;
  value: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface FacetConfig {
  /** Toolbar button text (defaults to the column label). */
  title?: string;
  /** Options to offer; defaults to the column's distinct values. */
  options?: FacetOption[];
}

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /** Right-align (numbers). */
    align?: 'left' | 'right';
    /** Extra classes for header and cells. */
    className?: string;
    /** Label in the column visibility menu when the header is not a string. */
    label?: string;
    /** Offer a faceted (multi-select) filter for this column in the toolbar. */
    facet?: FacetConfig;
  }
}

/** Facet preset for a risk level column. */
export const riskLevelFacet: FacetConfig = {
  title: 'Level',
  options: RISK_LEVELS.map((l: RiskLevel) => ({ label: levelLabel(l), value: l })),
};

/** Multi-select filter used by faceted columns: the cell value is one of the chosen values. */
export const facetFilter: FilterFn<unknown> = (row, id, value) => {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.includes(String(row.getValue(id)));
};

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, any>[];
  /** Stable row id (defaults to the index). */
  getRowId?: (row: T, index: number) => string;
  /** Accessible name of the table. */
  label: string;
  /** Show the filter box. Filtering is client-side over every column's value. */
  filterable?: boolean;
  filterPlaceholder?: string;
  /** Controlled global filter (e.g. synced to the URL). */
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  initialSorting?: SortingState;
  initialColumnVisibility?: VisibilityState;
  initialColumnFilters?: ColumnFiltersState;
  /** Show the "Columns" visibility menu (default true). */
  columnToggle?: boolean;
  /** Extra toolbar content (filters, badges) shown after the faceted filters. */
  toolbar?: ReactNode;
  /** Called when a row is clicked or activated with Enter. */
  onRowClick?: (row: T) => void;
  /** When set, the clicked row opens a right side panel (Sheet) rendered by this function. */
  renderPanel?: (row: T, close: () => void) => ReactNode;
  /** Controlled selected row id (for deep links). */
  selectedId?: string | null;
  onSelectedIdChange?: (id: string | null) => void;
  /** Virtualise rows when there are more than this many (default 80). */
  virtualizeAbove?: number;
  /** Estimated row height in px for virtualisation (default 37). */
  rowHeight?: number;
  /** Max height of the scroll area (default: 70vh when virtualised). */
  maxHeight?: number | string;
  /** Show skeleton rows instead of data. */
  loading?: boolean;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  /** Footer text left side; defaults to "Showing N of M". */
  footer?: ReactNode;
  /** Total rows on the server, when `data` is one page. */
  total?: number;
  className?: string;
}

function headerLabel(col: { id: string; columnDef: { header?: unknown; meta?: { label?: string } } }): string {
  if (col.columnDef.meta?.label) return col.columnDef.meta.label;
  return typeof col.columnDef.header === 'string' ? col.columnDef.header : col.id;
}

export function DataTable<T>({
  data,
  columns,
  getRowId,
  label,
  filterable = true,
  filterPlaceholder = 'Filter rows…',
  globalFilter: controlledFilter,
  onGlobalFilterChange,
  initialSorting = [],
  initialColumnVisibility = {},
  initialColumnFilters = [],
  columnToggle = true,
  toolbar,
  onRowClick,
  renderPanel,
  selectedId: controlledSelected,
  onSelectedIdChange,
  virtualizeAbove = 80,
  rowHeight = 37,
  maxHeight,
  loading = false,
  emptyTitle = 'No rows',
  emptyDescription,
  footer,
  total,
  className,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [visibility, setVisibility] = useState<VisibilityState>(initialColumnVisibility);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(initialColumnFilters);
  const [innerFilter, setInnerFilter] = useState('');
  const [innerSelected, setInnerSelected] = useState<string | null>(null);
  const filter = controlledFilter ?? innerFilter;
  const selectedId = controlledSelected !== undefined ? controlledSelected : innerSelected;

  const setFilter = useCallback(
    (v: string) => {
      if (onGlobalFilterChange) onGlobalFilterChange(v);
      if (controlledFilter === undefined) setInnerFilter(v);
    },
    [onGlobalFilterChange, controlledFilter],
  );
  const setSelected = useCallback(
    (id: string | null) => {
      if (onSelectedIdChange) onSelectedIdChange(id);
      if (controlledSelected === undefined) setInnerSelected(id);
    },
    [onSelectedIdChange, controlledSelected],
  );

  // Faceted columns get the multi-select filter unless they bring their own.
  const cols = useMemo(
    () => columns.map((c) => (c.meta?.facet && !c.filterFn ? { ...c, filterFn: facetFilter as FilterFn<T> } : c)),
    [columns],
  );

  const table = useReactTable<T>({
    data,
    columns: cols,
    state: { sorting, columnVisibility: visibility, globalFilter: filter, columnFilters },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: (v: unknown) => setFilter(typeof v === 'string' ? v : ''),
    globalFilterFn: 'includesString',
    getColumnCanGlobalFilter: () => true,
    getRowId: getRowId ? (row, i) => getRowId(row, i) : undefined,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const rows = table.getRowModel().rows;
  const virtual = !loading && rows.length > virtualizeAbove;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const items = virtual ? virtualizer.getVirtualItems() : [];
  const visibleRows: { row: Row<T>; index: number }[] = loading
    ? []
    : virtual
      ? items.flatMap((v) => {
          const row = rows[v.index];
          return row ? [{ row, index: v.index }] : [];
        })
      : rows.map((row, index) => ({ row, index }));
  const padTop = virtual && items.length > 0 ? (items[0]?.start ?? 0) : 0;
  const padBottom = virtual && items.length > 0 ? virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0) : 0;

  const selectedRow = useMemo(() => {
    if (selectedId === null) return null;
    return table.getCoreRowModel().rowsById[selectedId]?.original ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, data, table]);

  // Roving tabindex: only one row is a Tab stop (the last focused row, else the
  // selected row, else the first rendered row); arrow keys move between rows.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const selectedIndex = selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId);
  const preferredIndex =
    focusIndex !== null && focusIndex < rows.length ? focusIndex : selectedIndex >= 0 ? selectedIndex : 0;
  const tabStopIndex = visibleRows.some((v) => v.index === preferredIndex)
    ? preferredIndex
    : (visibleRows[0]?.index ?? -1);

  const focusRow = (index: number) => {
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`tr[data-index="${index}"]`)?.focus();
    });
  };

  const activate = (row: Row<T>) => {
    setSelected(row.id);
    onRowClick?.(row.original);
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: Row<T>, index: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(row);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next =
        e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : index + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0 || next >= rows.length) return;
      if (virtual) virtualizer.scrollToIndex(next);
      focusRow(next);
    }
  };

  const close = useCallback(() => {
    const id = selectedId;
    setSelected(null);
    // Give focus back to the row the panel was opened from.
    if (id !== null) {
      requestAnimationFrame(() => {
        const rowsEls = scrollRef.current?.querySelectorAll<HTMLElement>('tr[data-row-id]') ?? [];
        Array.from(rowsEls)
          .find((el) => el.dataset.rowId === id)
          ?.focus();
      });
    }
  }, [selectedId, setSelected]);

  const filterId = useId();
  const visibleCols = table.getVisibleLeafColumns().length;
  const shown = rows.length;
  const of = total ?? data.length;
  const clickable = Boolean(onRowClick || renderPanel);
  const facetColumns = table.getAllLeafColumns().filter((c) => c.columnDef.meta?.facet);
  const filtered = columnFilters.length > 0 || filter.length > 0;

  return (
    <div data-slot="data-table" className={cn('flex min-h-0 min-w-0 grow flex-col', className)}>
      <section aria-label={label} className="flex min-w-0 grow flex-col">
        {(filterable || toolbar || columnToggle || facetColumns.length > 0) && (
          <div data-slot="data-table-toolbar" className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            {filterable && (
              <>
                <Label htmlFor={filterId} className="sr-only">
                  Filter {label}
                </Label>
                <Input
                  id={filterId}
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={filterPlaceholder}
                  className="h-8 w-full max-w-[280px]"
                />
              </>
            )}
            {facetColumns.map((c) => (
              <DataTableFacetedFilter key={c.id} column={c} title={c.columnDef.meta?.facet?.title ?? headerLabel(c)} options={c.columnDef.meta?.facet?.options} />
            ))}
            {filtered && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  table.resetColumnFilters();
                  setFilter('');
                }}
              >
                Reset
                <X />
              </Button>
            )}
            {toolbar}
            <span className="grow" />
            {columnToggle && <DataTableViewOptions table={table} />}
          </div>
        )}
        <div
          ref={scrollRef}
          data-testid="datatable-scroll"
          className="relative min-h-[200px] grow overflow-auto [&>[data-slot=table-container]]:overflow-visible"
          style={{ maxHeight: maxHeight ?? (virtual ? '70vh' : undefined) }}
        >
          <Table aria-label={label} aria-busy={loading || undefined} className="min-w-[640px]">
            <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((h, hi) => {
                    const dir = h.column.getIsSorted();
                    const meta = h.column.columnDef.meta;
                    return (
                      <TableHead
                        key={h.id}
                        scope="col"
                        aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                        className={cn(
                          'h-9 text-xs text-muted-foreground',
                          hi === 0 && 'pl-4',
                          hi === hg.headers.length - 1 && 'pr-4',
                          meta?.align === 'right' && 'text-right',
                          meta?.className,
                        )}
                        style={h.column.columnDef.size !== 150 ? { width: h.getSize() } : undefined}
                      >
                        {h.isPlaceholder ? null : <DataTableColumnHeader column={h.column}>{flexRender(h.column.columnDef.header, h.getContext())}</DataTableColumnHeader>}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading &&
                Array.from({ length: 8 }, (_, i) => (
                  <TableRow key={`sk${i}`} aria-hidden="true" className="hover:bg-transparent">
                    {table.getVisibleLeafColumns().map((c, ci, all) => (
                      <TableCell key={c.id} className={cn(ci === 0 && 'pl-4', ci === all.length - 1 && 'pr-4')}>
                        <Skeleton className={cn('h-4', ci === 0 ? 'w-40' : 'w-16', c.columnDef.meta?.align === 'right' && 'ml-auto')} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {padTop > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={visibleCols} style={{ height: padTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {visibleRows.map(({ row, index }) => {
                const selected = row.id === selectedId;
                return (
                  <TableRow
                    key={row.id}
                    data-index={index}
                    data-row-id={row.id}
                    data-state={selected ? 'selected' : undefined}
                    ref={virtual ? virtualizer.measureElement : undefined}
                    aria-current={clickable && selected ? 'true' : undefined}
                    tabIndex={clickable ? (index === tabStopIndex ? 0 : -1) : undefined}
                    onFocus={clickable ? () => setFocusIndex(index) : undefined}
                    onClick={clickable ? () => activate(row) : undefined}
                    onKeyDown={clickable ? (e) => onRowKey(e, row, index) : undefined}
                    className={cn(
                      'outline-none focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                      clickable && 'cursor-pointer',
                    )}
                  >
                    {row.getVisibleCells().map((cell, ci, all) => {
                      const meta = cell.column.columnDef.meta;
                      return (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            'py-2 text-[13px] whitespace-normal',
                            ci === 0 && 'pl-4',
                            ci === all.length - 1 && 'pr-4',
                            meta?.align === 'right' && 'text-right font-mono tabular-nums',
                            meta?.className,
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
              {padBottom > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={visibleCols} style={{ height: padBottom, padding: 0, border: 0 }} />
                </tr>
              )}
            </TableBody>
          </Table>
          {!loading && rows.length === 0 && (
            <EmptyState
              title={data.length === 0 ? emptyTitle : 'No rows match the filter'}
              description={data.length === 0 ? emptyDescription : 'Clear the filter to see every row.'}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="font-mono" data-testid="datatable-count">
            {loading ? 'Loading…' : (footer ?? `Showing ${fmtNum(shown)} of ${fmtNum(of)}${virtual ? ' · rows load as you scroll' : ''}`)}
          </span>
          {clickable && (
            <span className="hidden items-center gap-1 sm:inline-flex">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>Esc</Kbd> close
            </span>
          )}
        </div>
      </section>
      {renderPanel && selectedRow !== null && renderPanel(selectedRow, close)}
    </div>
  );
}

/** Sortable column header (a ghost Button showing the sort direction). */
function DataTableColumnHeader<T>({ column, children }: { column: Column<T, unknown>; children: ReactNode }) {
  if (!column.getCanSort()) return <>{children}</>;
  const dir = column.getIsSorted();
  const right = column.columnDef.meta?.align === 'right';
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={column.getToggleSortingHandler()}
      className={cn('-ml-2 h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground data-[sorted=true]:text-foreground', right && '-mr-2 ml-0 flex-row-reverse')}
      data-sorted={dir ? 'true' : undefined}
    >
      {children}
      <Icon aria-hidden="true" className={cn('size-3.5', !dir && 'opacity-50')} />
    </Button>
  );
}

/** Multi-select facet filter: Popover + Command, the shadcn data-table pattern. */
function DataTableFacetedFilter<T>({ column, title, options }: { column: Column<T, unknown>; title: string; options?: FacetOption[] }) {
  const facets = column.getFacetedUniqueValues();
  const opts: FacetOption[] = useMemo(
    () =>
      options ??
      Array.from(facets.keys())
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map((v) => ({ label: String(v), value: String(v) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [options, facets],
  );
  const selected = new Set((column.getFilterValue() as string[] | undefined) ?? []);
  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    column.setFilterValue(next.size ? Array.from(next) : undefined);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 border-dashed">
          <CirclePlus />
          {title}
          {selected.size > 0 && (
            <>
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
              <Badge variant="secondary" className="rounded-sm px-1 font-normal lg:hidden">
                {selected.size}
              </Badge>
              <div className="hidden gap-1 lg:flex">
                {selected.size > 2 ? (
                  <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                    {selected.size} selected
                  </Badge>
                ) : (
                  opts
                    .filter((o) => selected.has(o.value))
                    .map((o) => (
                      <Badge variant="secondary" key={o.value} className="rounded-sm px-1 font-normal">
                        {o.label}
                      </Badge>
                    ))
                )}
              </div>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {opts.map((o) => {
                const isSelected = selected.has(o.value);
                return (
                  <CommandItem key={o.value} value={o.label} onSelect={() => toggle(o.value)} data-checked={isSelected}>
                    <div
                      className={cn(
                        'flex size-4 items-center justify-center rounded-[4px] border',
                        isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-input [&_svg]:invisible',
                      )}
                    >
                      <Check className="size-3.5 text-primary-foreground" />
                    </div>
                    {o.icon && <o.icon className="size-4 text-muted-foreground" />}
                    <span>{o.label}</span>
                    {isSelected && <span className="sr-only">, selected</span>}
                    {facets.get(o.value) !== undefined && (
                      <span className="ml-auto flex size-4 items-center justify-center font-mono text-xs">{facets.get(o.value)}</span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selected.size > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={() => column.setFilterValue(undefined)} className="justify-center text-center">
                    Clear filters
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Column visibility menu (DropdownMenu with checkbox items). */
function DataTableViewOptions<T>({ table }: { table: TanTable<T> }) {
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());
  if (hideable.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="ml-auto h-8">
          <Settings2 />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[180px]">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideable.map((c) => (
          <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(!!v)} onSelect={(e) => e.preventDefault()}>
            {headerLabel(c)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
