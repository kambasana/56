import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BulkBar } from './BulkBar';
import { AppliedFilters, FilterChips } from './FilterChips';
import { applyFilters, appliedList, parseFilters, type FilterDef, type QuickFilter } from './filters';
import { parseScope, ScopeBar, scopeSearch } from './ScopeBar';
import { renderWithRouter } from './test-router';

const FILTERS: FilterDef[] = [
  {
    key: 'severity',
    label: 'Severity',
    options: [
      { value: 'critical', label: 'Critical' },
      { value: 'high', label: 'High' },
    ],
  },
  { key: 'reach', label: 'Reach', info: 'Where the package runs.', options: [{ value: 'production', label: 'In production' }] },
];
const QUICK: QuickFilter[] = [
  { label: 'Critical', key: 'severity', value: 'critical' },
  { label: 'In production', key: 'reach', value: 'production' },
];

describe('filter model', () => {
  const rows = [
    { id: 1, severity: 'critical', reach: 'production' },
    { id: 2, severity: 'high', reach: 'dev' },
    { id: 3, severity: 'low', reach: 'production' },
  ];
  const get = (r: (typeof rows)[number], k: string) => (r as Record<string, unknown>)[k] as string;

  it('ORs values within a filter and ANDs across filters', () => {
    expect(applyFilters(rows, { severity: ['critical', 'high'] }, get).map((r) => r.id)).toEqual([1, 2]);
    expect(applyFilters(rows, { severity: ['critical', 'high'], reach: ['production'] }, get).map((r) => r.id)).toEqual([1]);
    expect(applyFilters(rows, {}, get)).toHaveLength(3);
    expect(applyFilters(rows, { severity: ['x'] }, () => null)).toEqual([]);
    expect(applyFilters([{ tags: ['a', 'b'] }], { tags: ['b'] }, (r, k) => (r as Record<string, string[]>)[k])).toHaveLength(1);
  });

  it('parses comma lists from the URL and labels applied chips', () => {
    const v = parseFilters(new URLSearchParams('severity=critical,high,critical&reach=&other=1'), FILTERS);
    expect(v).toEqual({ severity: ['critical', 'high'] });
    expect(appliedList(v, FILTERS).map((a) => a.text)).toEqual(['Severity: Critical', 'Severity: High']);
  });
});

describe('<FilterChips> and <AppliedFilters>', () => {
  it('keeps filters in the URL, pushes history and clears all', async () => {
    const user = userEvent.setup();
    const { url, router } = renderWithRouter(
      <>
        <FilterChips filters={FILTERS} quick={QUICK} />
        <AppliedFilters filters={FILTERS} count="3 findings" />
      </>,
      '/findings?sort=sev',
    );
    const crit = screen.getByRole('button', { name: 'Critical' });
    expect(crit).toHaveAttribute('aria-pressed', 'false');
    await user.click(crit);
    expect(url()).toBe('/findings?sort=sev&severity=critical');
    expect(screen.getByRole('button', { name: 'Critical' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'In production' }));
    const applied = screen.getByRole('list', { name: 'Applied filters' });
    expect(within(applied).getAllByRole('button').map((b) => b.textContent)).toEqual(['Severity: Critical', 'Reach: In production']);
    await user.click(screen.getByRole('button', { name: 'Remove filter Severity: Critical' }));
    expect(url()).toBe('/findings?sort=sev&reach=production');
    // Back restores the removed filter.
    await act(() => router.navigate(-1));
    expect(url()).toBe('/findings?sort=sev&severity=critical&reach=production');
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(url()).toBe('/findings?sort=sev');
    expect(screen.queryByRole('list', { name: 'Applied filters' })).not.toBeInTheDocument();
    expect(screen.getByText('3 findings')).toBeInTheDocument();
  });

  it('opens All filters with checkboxes and an explanation for jargon filters', async () => {
    const user = userEvent.setup();
    const { url } = renderWithRouter(<FilterChips filters={FILTERS} quick={[]} />);
    await user.click(screen.getByRole('button', { name: 'All filters' }));
    expect(screen.getByText('(Where the package runs.)')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'High' }));
    expect(url()).toBe('/list?severity=high');
  });

  it('adds a search box to long option lists', async () => {
    const user = userEvent.setup();
    const many: FilterDef = { key: 'project', label: 'Project', options: Array.from({ length: 12 }, (_, i) => ({ value: `p${i}`, label: `proj-${i}` })) };
    renderWithRouter(<FilterChips filters={[many]} quick={[]} />);
    await user.click(screen.getByRole('button', { name: 'All filters' }));
    await user.type(screen.getByRole('textbox', { name: 'Search Project' }), 'proj-11');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});

describe('<ScopeBar>', () => {
  const projects = [
    { id: 'p1', name: 'payments-api' },
    { id: 'p2', name: 'web' },
  ];

  it('parses scope with defaults and carries only scope params', () => {
    expect(parseScope(new URLSearchParams(''))).toEqual({ projects: [], env: 'all', range: '30d' });
    expect(parseScope(new URLSearchParams('env=prod&range=7d&projects=p1'))).toEqual({ projects: ['p1'], env: 'prod', range: '7d' });
    expect(parseScope(new URLSearchParams('env=bogus')).env).toBe('all');
    expect(scopeSearch(new URLSearchParams('env=prod&severity=critical&peek=f1'))).toBe('?env=prod');
    expect(scopeSearch(new URLSearchParams('severity=critical'))).toBe('');
  });

  it('writes choices to the URL', async () => {
    const user = userEvent.setup();
    const { url } = renderWithRouter(<ScopeBar projects={projects} />, '/');
    expect(screen.getByRole('button', { name: 'Projects: All projects' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Environment: Production and dev' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Production' }));
    expect(url()).toBe('/?env=prod');
    await user.click(screen.getByRole('button', { name: 'Projects: All projects' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'web' }));
    expect(url()).toBe('/?env=prod&projects=p2');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Projects: web' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Time: Last 30 days' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Last 7 days' }));
    expect(url()).toBe('/?env=prod&projects=p2&range=7d');
  });
});

describe('<BulkBar>', () => {
  it('is hidden without a selection', () => {
    renderWithRouter(<BulkBar count={0} actions={[]} onClear={() => {}} />);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('runs actions, explains disabled ones and announces the outcome', async () => {
    const user = userEvent.setup();
    const setStatus = vi.fn();
    const clear = vi.fn();
    renderWithRouter(
      <BulkBar
        count={4}
        onClear={clear}
        status="4 set to Triaged"
        actions={[
          { label: 'Set status', onSelect: setStatus },
          { label: 'Accept risk…', onSelect: () => {}, disabledReason: 'Needs the Accept risk permission: ask an admin.' },
        ]}
      />,
    );
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('4 selected');
    await user.click(within(bar).getByRole('button', { name: 'Set status' }));
    expect(setStatus).toHaveBeenCalledOnce();
    expect(within(bar).getByRole('button', { name: /Accept risk/ })).toBeDisabled();
    expect(within(bar).getByRole('button', { name: /Accept risk/ })).toHaveAccessibleName(/Needs the Accept risk permission/);
    await user.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(clear).toHaveBeenCalledOnce();
    expect(within(bar).getByRole('status')).toHaveTextContent('4 set to Triaged');
  });
});
