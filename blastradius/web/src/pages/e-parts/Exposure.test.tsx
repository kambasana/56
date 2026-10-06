import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ExposureMatrixResponse } from '@server/api-types';
import Exposure from '../Exposure';
import { meFor } from '@/test/fixtures';
import { cellText, shade, sortRows, toCsv } from './exposure';
import { Reply, choose, fakeApi, renderPage } from './testkit';

function matrix(rows = 3, cols = 3): ExposureMatrixResponse {
  const envs = ['dev', 'prod', 'ci'] as const;
  return {
    axis: 'asset',
    rows: Array.from({ length: rows }, (_, i) => ({
      key: `a${i}`,
      label: `asset-${i}`,
      projectId: 'p1',
      environment: envs[i % 3]!,
      criticality: 3,
      blastScore: i === 1 ? 5 : i,
    })),
    columns: Array.from({ length: cols }, (_, i) => ({
      findingId: `f${i}`,
      projectId: 'p1',
      purl: `pkg:npm/comp-${i}@1.0.0`,
      name: `comp-${i}`,
      version: '1.0.0',
      level: i === 0 ? 'critical' : 'medium',
      score: i === 0 ? 95 : 40,
      reach: 2,
    })),
    cells: [
      { row: 0, col: 0, exposure: 0.25, pathCount: 1 },
      { row: 1, col: 0, exposure: 0.9, pathCount: 3 },
      { row: 2, col: 1, exposure: 0.5, pathCount: 2 },
    ],
    truncated: false,
  };
}

const at = '/projects/p1/exposure';
const path = '/projects/:id/exposure';

describe('Exposure helpers', () => {
  it('shades cells in the canvas buckets', () => {
    expect([0, 0.2, 0.3, 0.5, 0.61, 1].map(shade)).toEqual([0, 18, 18, 45, 85, 85]);
    expect(cellText(0)).toBe('');
    expect(cellText(0.62)).toBe('.6');
    expect(cellText(1)).toBe('1.0');
  });

  it('sorts rows by blast score, environment or name', () => {
    const m = matrix();
    expect(sortRows(m.rows, 'blast').map((i) => m.rows[i]!.label)).toEqual(['asset-1', 'asset-2', 'asset-0']);
    expect(sortRows(m.rows, 'env').map((i) => m.rows[i]!.environment)).toEqual(['prod', 'ci', 'dev']);
    expect(sortRows(m.rows, 'name').map((i) => m.rows[i]!.label)).toEqual(['asset-0', 'asset-1', 'asset-2']);
  });

  it('exports CSV and neutralises formulas in untrusted names', () => {
    const m = matrix(1, 1);
    m.rows[0]!.label = '=HYPERLINK("x")';
    const csv = toCsv(m, [0]);
    expect(csv.split('\n')[0]).toBe('asset,environment,criticality,blast_score,comp-0@1.0.0');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(',0.25');
  });
});

describe('<Exposure>', () => {
  it('renders the matrix with sticky headers, rows and a selected-cell bar', async () => {
    const { calls } = fakeApi({ 'GET /api/exposure': () => matrix() });
    renderPage(<Exposure />, { path, at, me: meFor('org_admin') });
    const grid = await screen.findByRole('grid', { name: 'Exposure matrix' });
    expect(calls[0]!.url.searchParams.get('project')).toBe('p1');
    expect(calls[0]!.url.searchParams.get('minLevel')).toBe('medium');
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Asset', 'comp-0Critical 95', 'comp-1Medium 40', 'comp-2Medium 40', 'Blast score']);
    // Sorted by blast score: asset-1 first.
    expect(within(grid).getAllByRole('rowheader')[0]).toHaveTextContent('asset-1');
    // The strongest cell is preselected.
    const bar = screen.getByRole('status', { name: 'Selected cell' });
    expect(bar).toHaveTextContent('asset-1 × comp-0@1.0.0');
    expect(bar).toHaveTextContent('exposure 0.90 · 3 paths');
    expect(within(bar).getByRole('link', { name: 'Open finding' })).toHaveAttribute('href', '/projects/p1/findings/f0');
    expect(within(bar).getByRole('link', { name: 'Investigate' })).toHaveAttribute('href', '/projects/p1/investigate?finding=f0');

    await userEvent.click(screen.getByRole('button', { name: 'asset-2 × comp-1: exposure 0.50, 2 paths' }));
    expect(bar).toHaveTextContent('asset-2 × comp-1@1.0.0');
  });

  it('moves focus between cells with the arrow keys', async () => {
    fakeApi({ 'GET /api/exposure': () => matrix() });
    renderPage(<Exposure />, { path, at, me: meFor('org_admin') });
    await screen.findByRole('grid');
    const first = screen.getByRole('button', { name: /^asset-1 × comp-0/ });
    expect(first).toHaveAttribute('tabindex', '0');
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByRole('button', { name: /^asset-1 × comp-1/ })).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('button', { name: /^asset-2 × comp-1/ })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('status', { name: 'Selected cell' })).toHaveTextContent('asset-2 × comp-1@1.0.0');
  });

  it('switches to org-wide rows and changes the level filter through the URL', async () => {
    const { calls } = fakeApi({ 'GET /api/exposure': () => matrix() });
    renderPage(<Exposure />, { path, at, me: meFor('org_admin') });
    await screen.findByRole('grid');
    const rows = screen.getByRole('radiogroup', { name: 'Rows' });
    await userEvent.click(within(rows).getByRole('radio', { name: 'All projects' }));
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.has('project')).toBe(false));
    await choose('Risk ≥', 'Critical');
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get('minLevel')).toBe('critical'));
    expect(screen.getByTestId('where')).toHaveTextContent('scope=org');
  });

  it('sorts rows with the toggle group and shows a tooltip on a reached cell', async () => {
    fakeApi({ 'GET /api/exposure': () => matrix() });
    renderPage(<Exposure />, { path, at, me: meFor('org_admin') });
    const grid = await screen.findByRole('grid');
    const sort = screen.getByRole('radiogroup', { name: 'Sort rows' });
    expect(within(sort).getByRole('radio', { name: 'Blast score' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(sort).getByRole('radio', { name: 'Name' }));
    expect(within(grid).getAllByRole('rowheader')[0]).toHaveTextContent('asset-0');
    // Header cells are sticky.
    expect(within(grid).getAllByRole('columnheader')[1]!.className).toContain('sticky');
    await userEvent.hover(screen.getByRole('button', { name: 'asset-2 × comp-1: exposure 0.50, 2 paths' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('asset-2 × comp-1@1.0.0');
  });

  it('hides finding and investigate links without those permissions', async () => {
    fakeApi({ 'GET /api/exposure': () => matrix() });
    renderPage(<Exposure />, { path, at, me: meFor('auditor', { permissions: ['exposure'] }) });
    const bar = await screen.findByRole('status', { name: 'Selected cell' });
    expect(within(bar).queryByRole('link')).toBeNull();
  });

  it('shows empty and error states', async () => {
    fakeApi({ 'GET /api/exposure': () => ({ ...matrix(0, 0), rows: [], columns: [], cells: [] }) });
    const { unmount } = renderPage(<Exposure />, { path, at, me: meFor('org_admin') });
    expect(await screen.findByText('Nothing exposed at this level')).toBeInTheDocument();
    unmount();
    fakeApi({ 'GET /api/exposure': () => new Reply(500, { error: { code: 'internal', message: 'Something broke' } }) });
    renderPage(<Exposure />, { path, at, me: meFor('org_admin') });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke');
  });

  it('virtualises 5,000 rows', async () => {
    const m = matrix(5000, 20);
    fakeApi({ 'GET /api/exposure': () => m });
    renderPage(<Exposure />, { path, at, me: meFor('org_admin') });
    const grid = await screen.findByRole('grid');
    expect(grid).toHaveAttribute('aria-rowcount', '5002');
    const rendered = within(grid).getAllByRole('rowheader').length;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(120);
  });
});
