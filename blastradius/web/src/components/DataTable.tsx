/**
 * DataTable: the table every screen uses (table-first UI, PLAN §12).
 *
 * TanStack Table for sorting, global filtering and column visibility; TanStack Virtual for
 * row virtualisation once the row count passes `virtualizeAbove`. Clicking a row (or Enter on
 * a focused row) selects it and, when `renderPanel` is given, opens a SidePanel to the right.
 *
 * Cell values are rendered as React text (escaped). Never pass untrusted HTML.
 */
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn, fmtNum } from '@/lib/cn';
import { EmptyState } from './EmptyState';

export type { ColumnDef } from '@tanstack/react-table';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /** Right-align (numbers). */
    align?: 'left' | 'right';
    /** Extra classes for header and cells. */
    className?: string;
    /** Label in the column visibility menu when the header is not a string. */
    label?: string;
  }
}

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
  /** Show the "Columns" visibility menu (default true). */
  columnToggle?: boolean;
  /** Extra toolbar content (filters, badges) shown left of the column menu. */
  toolbar?: ReactNode;
  /** Called when a row is clicked or activated with Enter. */
  onRowClick?: (row: T) => void;
  /** When set, the clicked row opens a right side panel rendered by this function. */
  renderPanel?: (row: T, close: () => void) => ReactNode;
  /** Controlled selected row id (for deep links). */
  selectedId?: string | null;
  onSelectedIdChange?: (id: string | null) => void;
  /** Virtualise rows when there are more than this many (default 80). */
  virtualizeAbove?: number;
  /** Estimated row height in px for virtualisation (default 37). */
  rowHeight?: number;
  /** Max height of the scroll area (default: fill the parent, min 320px). */
  maxHeight?: number | string;
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
  columnToggle = true,
  toolbar,
  onRowClick,
  renderPanel,
  selectedId: controlledSelected,
  onSelectedIdChange,
  virtualizeAbove = 80,
  rowHeight = 37,
  maxHeight,
  emptyTitle = 'No rows',
  emptyDescription,
  footer,
  total,
  className,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [visibility, setVisibility] = useState<VisibilityState>(initialColumnVisibility);
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

  const table = useReactTable<T>({
    data,
    columns,
    state: { sorting, columnVisibility: visibility, globalFilter: filter },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    onGlobalFilterChange: (v: unknown) => setFilter(typeof v === 'string' ? v : ''),
    globalFilterFn: 'includesString',
    getColumnCanGlobalFilter: () => true,
    getRowId: getRowId ? (row, i) => getRowId(row, i) : undefined,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = table.getRowModel().rows;
  const virtual = rows.length > virtualizeAbove;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const items = virtual ? virtualizer.getVirtualItems() : [];
  const visibleRows: { row: Row<T>; index: number }[] = virtual
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

  const activate = (row: Row<T>) => {
    setSelected(row.id);
    onRowClick?.(row.original);
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: Row<T>, index: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(row);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = index + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0 || next >= rows.length) return;
      if (virtual) virtualizer.scrollToIndex(next);
      requestAnimationFrame(() => {
        scrollRef.current?.querySelector<HTMLElement>(`tr[data-index="${next}"]`)?.focus();
      });
    }
  };

  const close = useCallback(() => setSelected(null), [setSelected]);
  const filterId = useId();
  const visibleCols = table.getVisibleLeafColumns().length;
  const shown = rows.length;
  const of = total ?? data.length;

  return (
    <div className={cn('flex min-h-0 min-w-0 grow flex-wrap', className)}>
      <section aria-label={label} className="flex min-w-0 flex-[999_1_560px] flex-col">
        {(filterable || toolbar || columnToggle) && (
          <div className="flex flex-wrap items-center gap-1.5 border-b px-5 py-2">
            {filterable && (
              <>
                <label htmlFor={filterId} className="sr-only">
                  Filter {label}
                </label>
                <input
                  id={filterId}
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={filterPlaceholder}
                  className="h-8 w-full max-w-[280px] rounded-md border border-input bg-background px-2.5 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </>
            )}
            {toolbar}
            <span className="grow" />
            {columnToggle && <ColumnMenu table={table} />}
          </div>
        )}
        <div
          ref={scrollRef}
          data-testid="datatable-scroll"
          className="min-h-[200px] grow overflow-auto"
          style={{ maxHeight: maxHeight ?? (virtual ? '70vh' : undefined) }}
        >
          <table aria-label={label} className="w-full min-w-[640px] border-collapse text-[13px] leading-[18px]">
            <thead className="sticky top-0 z-10 bg-muted">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h, hi) => {
                    const sortable = h.column.getCanSort();
                    const dir = h.column.getIsSorted();
                    const meta = h.column.columnDef.meta;
                    return (
                      <th
                        key={h.id}
                        scope="col"
                        aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                        className={cn(
                          'h-9 whitespace-nowrap border-b px-2 text-left text-xs font-medium text-muted-foreground',
                          hi === 0 && 'pl-5',
                          hi === hg.headers.length - 1 && 'pr-5',
                          meta?.align === 'right' && 'text-right',
                          meta?.className,
                        )}
                        style={h.column.columnDef.size !== 150 ? { width: h.getSize() } : undefined}
                      >
                        {h.isPlaceholder ? null : sortable ? (
                          <button
                            type="button"
                            onClick={h.column.getToggleSortingHandler()}
                            className={cn(
                              'inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-medium text-inherit hover:text-foreground',
                              meta?.align === 'right' && 'flex-row-reverse',
                            )}
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            <span aria-hidden="true" className="font-mono text-[10px]">
                              {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}
                            </span>
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {padTop > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={visibleCols} style={{ height: padTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {visibleRows.map(({ row, index }) => {
                const selected = row.id === selectedId;
                const clickable = Boolean(onRowClick || renderPanel);
                return (
                  <tr
                    key={row.id}
                    data-index={index}
                    data-row-id={row.id}
                    ref={virtual ? virtualizer.measureElement : undefined}
                    aria-selected={clickable ? selected : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => activate(row) : undefined}
                    onKeyDown={clickable ? (e) => onRowKey(e, row, index) : undefined}
                    className={cn(
                      'border-b outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60',
                      clickable && 'cursor-pointer',
                      selected && 'bg-muted hover:bg-muted',
                    )}
                  >
                    {row.getVisibleCells().map((cell, ci, all) => {
                      const meta = cell.column.columnDef.meta;
                      return (
                        <td
                          key={cell.id}
                          className={cn(
                            'px-2 py-2 align-middle',
                            ci === 0 && 'pl-5',
                            ci === all.length - 1 && 'pr-5',
                            meta?.align === 'right' && 'text-right font-mono tabular-nums',
                            meta?.className,
                          )}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {padBottom > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={visibleCols} style={{ height: padBottom, padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyState
              title={data.length === 0 ? emptyTitle : 'No rows match the filter'}
              description={data.length === 0 ? emptyDescription : 'Clear the filter to see every row.'}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2.5 text-xs text-muted-foreground">
          <span className="font-mono" data-testid="datatable-count">
            {footer ?? `Showing ${fmtNum(shown)} of ${fmtNum(of)}${virtual ? ' · rows load as you scroll' : ''}`}
          </span>
          {(onRowClick || renderPanel) && <span>↑↓ move · Enter open · Esc close</span>}
        </div>
      </section>
      {renderPanel && selectedRow !== null && renderPanel(selectedRow, close)}
    </div>
  );
}

function ColumnMenu<T>({ table }: { table: ReturnType<typeof useReactTable<T>> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());
  if (hideable.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium hover:bg-accent"
      >
        Columns ▾
      </button>
      {open && (
        <div
          id={menuId}
          role="group"
          aria-label="Visible columns"
          className="absolute right-0 top-7 z-20 flex min-w-[180px] flex-col gap-0.5 rounded-md border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-lg)]"
        >
          {hideable.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-[13px] hover:bg-accent">
              <input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} />
              {headerLabel(c)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
