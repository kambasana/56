import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type ColumnDef } from './DataTable';
import { SidePanel } from './SidePanel';

interface Row {
  id: string;
  name: string;
  score: number;
  level: string;
}

const rows: Row[] = [
  { id: 'a', name: 'left-pad', score: 40, level: 'medium' },
  { id: 'b', name: 'event-stream', score: 95, level: 'critical' },
  { id: 'c', name: 'colors', score: 70, level: 'high' },
];

const columns: ColumnDef<Row, any>[] = [
  { accessorKey: 'name', header: 'Component' },
  { accessorKey: 'score', header: 'Score', meta: { align: 'right' } },
  { accessorKey: 'level', header: 'Level' },
];

const bodyNames = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]?.textContent);

describe('<DataTable>', () => {
  it('renders rows and the count footer', () => {
    render(<DataTable label="Findings" data={rows} columns={columns} getRowId={(r) => r.id} />);
    expect(screen.getByRole('table', { name: 'Findings' })).toBeInTheDocument();
    expect(bodyNames()).toEqual(['left-pad', 'event-stream', 'colors']);
    expect(screen.getByTestId('datatable-count')).toHaveTextContent('Showing 3 of 3');
  });

  it('sorts when a header is clicked', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Findings" data={rows} columns={columns} getRowId={(r) => r.id} />);
    await user.click(screen.getByRole('button', { name: /Score/ }));
    const first = bodyNames();
    await user.click(screen.getByRole('button', { name: /Score/ }));
    const second = bodyNames();
    expect([first, second]).toContainEqual(['left-pad', 'colors', 'event-stream']);
    expect([first, second]).toContainEqual(['event-stream', 'colors', 'left-pad']);
    expect(screen.getByRole('columnheader', { name: /Score/ })).toHaveAttribute('aria-sort');
  });

  it('honours initial sorting', () => {
    render(<DataTable label="Findings" data={rows} columns={columns} getRowId={(r) => r.id} initialSorting={[{ id: 'score', desc: true }]} />);
    expect(bodyNames()).toEqual(['event-stream', 'colors', 'left-pad']);
  });

  it('filters rows with the filter box', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Findings" data={rows} columns={columns} getRowId={(r) => r.id} />);
    await user.type(screen.getByLabelText('Filter Findings'), 'stream');
    expect(bodyNames()).toEqual(['event-stream']);
    expect(screen.getByTestId('datatable-count')).toHaveTextContent('Showing 1 of 3');
    await user.clear(screen.getByLabelText('Filter Findings'));
    await user.type(screen.getByLabelText('Filter Findings'), 'zzz');
    expect(screen.getByText('No rows match the filter')).toBeInTheDocument();
  });

  it('hides and shows columns', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Findings" data={rows} columns={columns} getRowId={(r) => r.id} />);
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Level' }));
    // The menu stays open while toggling, like the shadcn data-table view options.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Level' })).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('columnheader', { name: 'Level' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Score' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Level' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('columnheader', { name: 'Level' })).toBeInTheDocument();
  });

  it('opens a side panel on row click and closes it', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        label="Findings"
        data={rows}
        columns={columns}
        getRowId={(r) => r.id}
        onRowClick={onRowClick}
        renderPanel={(r, close) => (
          <SidePanel title={r.name} onClose={close} label="Finding detail">
            score {r.score}
          </SidePanel>
        )}
      />,
    );
    expect(screen.queryByRole('complementary', { name: 'Finding detail' })).not.toBeInTheDocument();
    await user.click(screen.getByText('colors'));
    const panel = screen.getByRole('complementary', { name: 'Finding detail' });
    // The panel is a shadcn Sheet (Radix dialog, non-modal) titled by the row.
    expect(screen.getByRole('dialog', { name: 'colors' })).toContainElement(panel);
    expect(within(panel).getByText('score 70')).toBeInTheDocument();
    expect(onRowClick).toHaveBeenCalledWith(rows[2]);
    expect(screen.getByText('colors', { selector: 'td' }).closest('tr')).toHaveAttribute('aria-current', 'true');
    await user.click(within(panel).getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('complementary', { name: 'Finding detail' })).not.toBeInTheDocument();
  });

  it('opens the panel with Enter and closes it with Escape', async () => {
    const user = userEvent.setup();
    render(
      <DataTable label="Findings" data={rows} columns={columns} getRowId={(r) => r.id} renderPanel={(r, close) => <SidePanel title={r.name} onClose={close} />} />,
    );
    const row = screen.getByText('left-pad').closest('tr')!;
    row.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('complementary')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('renders cell text escaped, never as HTML', () => {
    const evil = [{ id: 'x', name: '<img src=x onerror=alert(1)>', score: 1, level: 'low' }];
    const { container } = render(<DataTable label="Findings" data={evil} columns={columns} getRowId={(r) => r.id} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('virtualises large row sets', () => {
    // jsdom has no layout: give the scroll area a 600px viewport (virtual-core reads offsetHeight).
    const h = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'datatable-scroll' ? 600 : 37;
    });
    const w = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    const many: Row[] = Array.from({ length: 2000 }, (_, i) => ({ id: `r${i}`, name: `pkg-${i}`, score: i % 100, level: 'low' }));
    render(<DataTable label="Findings" data={many} columns={columns} getRowId={(r) => r.id} />);
    const rendered = screen.getAllByRole('row').length - 1;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
    expect(screen.getByTestId('datatable-count')).toHaveTextContent('Showing 2,000 of 2,000');
    h.mockRestore();
    w.mockRestore();
  });

  it('filters a faceted column with the Popover + Command filter', async () => {
    const user = userEvent.setup();
    const faceted: ColumnDef<Row, any>[] = [...columns.slice(0, 2), { accessorKey: 'level', header: 'Level', meta: { facet: { title: 'Level' } } }];
    render(<DataTable label="Findings" data={rows} columns={faceted} getRowId={(r) => r.id} />);
    const toolbar = document.querySelector<HTMLElement>('[data-slot=data-table-toolbar]')!;
    await user.click(within(toolbar).getByRole('button', { name: 'Level' }));
    await user.click(screen.getByRole('option', { name: /critical/ }));
    expect(bodyNames()).toEqual(['event-stream']);
    await user.click(screen.getByRole('option', { name: /high/ }));
    expect(bodyNames()).toEqual(['event-stream', 'colors']);
    expect(screen.getByTestId('datatable-count')).toHaveTextContent('Showing 2 of 3');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /Reset/ }));
    expect(bodyNames()).toHaveLength(3);
  });

  it('moves between rows with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Findings" data={rows} columns={columns} getRowId={(r) => r.id} onRowClick={() => {}} />);
    const first = screen.getByText('left-pad').closest('tr')!;
    first.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByText('event-stream').closest('tr')).toHaveFocus());
  });

  it('leaves Enter, Space and arrow keys to controls inside a cell', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onButton = vi.fn();
    const withButton: ColumnDef<Row, any>[] = [
      ...columns,
      { id: 'act', header: 'Action', cell: ({ row }) => <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onButton(row.original.id);
          }}
        >Act {row.original.name}</button> },
    ];
    render(<DataTable label="Findings" data={rows} columns={withButton} getRowId={(r) => r.id} onRowClick={onRowClick} />);
    const button = screen.getByRole('button', { name: 'Act left-pad' });
    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onButton).toHaveBeenCalledTimes(2);
    expect(onButton).toHaveBeenCalledWith('a');
    expect(onRowClick).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}');
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(button).toHaveFocus();
    // The row itself still handles keys.
    const row = button.closest('tr')!;
    row.focus();
    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onButton).toHaveBeenCalledTimes(2);
  });

  it('makes only one row a Tab stop (roving tabindex)', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Findings" data={rows} columns={columns} getRowId={(r) => r.id} onRowClick={() => {}} />);
    const bodyRows = () => Array.from(document.querySelectorAll<HTMLElement>('tbody tr[data-row-id]'));
    expect(bodyRows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(bodyRows()[0]).toHaveAttribute('tabindex', '0');
    bodyRows()[0]!.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(bodyRows()[1]).toHaveFocus());
    expect(bodyRows().filter((r) => r.tabIndex === 0)).toEqual([bodyRows()[1]]);
    expect(bodyRows().some((r) => r.hasAttribute('aria-selected'))).toBe(false);
  });

  it('announces the checked state of faceted filter options', async () => {
    const user = userEvent.setup();
    const faceted: ColumnDef<Row, any>[] = [...columns.slice(0, 2), { accessorKey: 'level', header: 'Level', meta: { facet: { title: 'Level' } } }];
    render(<DataTable label="Findings" data={rows} columns={faceted} getRowId={(r) => r.id} />);
    const toolbar = document.querySelector<HTMLElement>('[data-slot=data-table-toolbar]')!;
    await user.click(within(toolbar).getByRole('button', { name: 'Level' }));
    expect(screen.getByRole('option', { name: /critical/ })).not.toHaveAccessibleName(/selected/);
    await user.click(screen.getByRole('option', { name: /critical/ }));
    expect(screen.getByRole('option', { name: /critical/ })).toHaveAccessibleName(/critical, selected/);
  });

  it('shows skeleton rows while loading', () => {
    render(<DataTable label="Findings" data={[]} columns={columns} loading />);
    expect(screen.getByRole('table', { name: 'Findings' })).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('[data-slot=skeleton]').length).toBeGreaterThan(0);
    expect(screen.queryByText('No rows')).not.toBeInTheDocument();
  });

  it('shows the empty state for no data', () => {
    render(<DataTable label="Findings" data={[]} columns={columns} emptyTitle="No findings yet" />);
    expect(screen.getByText('No findings yet')).toBeInTheDocument();
  });
});
