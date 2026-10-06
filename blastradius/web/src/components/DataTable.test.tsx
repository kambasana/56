import { render, screen, within } from '@testing-library/react';
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
    await user.click(screen.getByRole('checkbox', { name: 'Level' }));
    expect(screen.queryByRole('columnheader', { name: 'Level' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Level' }));
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
    expect(within(panel).getByText('score 70')).toBeInTheDocument();
    expect(onRowClick).toHaveBeenCalledWith(rows[2]);
    expect(screen.getByText('colors', { selector: 'td' }).closest('tr')).toHaveAttribute('aria-selected', 'true');
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

  it('shows the empty state for no data', () => {
    render(<DataTable label="Findings" data={[]} columns={columns} emptyTitle="No findings yet" />);
    expect(screen.getByText('No findings yet')).toBeInTheDocument();
  });
});
