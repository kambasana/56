import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchExposureResponse } from '@server/api-types';
import { api } from '@/api';
import { AuthProvider } from '@/auth';
import { ProjectProvider } from '@/project';
import { meFor, reportsOnly } from '@/test/fixtures';
import { parsePackageQuery, verdictFrom } from '@/lib/package-query';
import { CommandPaletteProvider, useCommandPalette } from './CommandPalette';
import type { MeResponse } from '@server/api-types';

const hit = (projectId: string, projectName: string, production: boolean) => ({
  projectId,
  projectName,
  purl: 'pkg:npm/event-stream@3.3.6',
  name: 'event-stream',
  version: '3.3.6',
  production,
  reachText: 'Brought in by x',
});

const FOUND: SearchExposureResponse = {
  query: { name: 'event-stream', version: '3.3.6' },
  projectsSearched: 4,
  items: [hit('p2', 'web', false), hit('p1', 'payments-api', true), hit('p1', 'payments-api', false)],
};

describe('package queries', () => {
  it('parses name@version and "name version"', () => {
    expect(parsePackageQuery('lodash@4.17.20')).toEqual({ name: 'lodash', version: '4.17.20' });
    expect(parsePackageQuery(' @scope/pkg@1.0.0 ')).toEqual({ name: '@scope/pkg', version: '1.0.0' });
    expect(parsePackageQuery('ua-parser-js 0.7.29')).toEqual({ name: 'ua-parser-js', version: '0.7.29' });
    expect(parsePackageQuery('lodash v4.17.20')).toEqual({ name: 'lodash', version: '4.17.20' });
    expect(parsePackageQuery('lodash')).toBeNull();
    expect(parsePackageQuery('slack alerts')).toBeNull();
    expect(parsePackageQuery('@scope/pkg')).toBeNull();
    // name@version needs an exact version too, like "name version".
    expect(parsePackageQuery('lodash@v4.17.20')).toEqual({ name: 'lodash', version: '4.17.20' });
    expect(parsePackageQuery('lodash@latest')).toBeNull();
    expect(parsePackageQuery('@scope/pkg@next')).toBeNull();
    expect(parsePackageQuery('lodash@^4.17.0')).toBeNull();
    expect(parsePackageQuery('lodash@v')).toBeNull();
  });

  it('counts projects once, production first', () => {
    const v = verdictFrom(FOUND);
    expect(v).toMatchObject({ pkg: 'event-stream@3.3.6', projects: 2, production: 1, searched: 4 });
    expect(v.detail).toBe('payments-api (production); web (dev and test)');
    expect(verdictFrom({ query: { name: 'x', version: null }, projectsSearched: 3, items: [] })).toEqual({ pkg: 'x', projects: 0, production: 0, searched: 3 });
  });
});

function Where() {
  const l = useLocation();
  return <span data-testid="where">{l.pathname + l.search}</span>;
}

function Opener() {
  const { setOpen } = useCommandPalette();
  return (
    <button type="button" onClick={() => setOpen(true)}>
      open palette
    </button>
  );
}

function renderPalette(me: MeResponse = meFor('org_admin')) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider initialMe={me}>
        <ProjectProvider initialProjects={[{ id: 'p1', name: 'payments-api' }, { id: 'p2', name: 'web' }]}>
          <CommandPaletteProvider>
            <Opener />
            <Where />
          </CommandPaletteProvider>
        </ProjectProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const input = () => screen.getByRole('combobox', { name: 'Search packages, projects, people, settings' });

describe('<CommandPalette>', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens with Ctrl+K or ⌘K and closes with Esc', async () => {
    const user = userEvent.setup();
    renderPalette();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('groups projects and settings and actions, and opens one with Enter', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Settings and actions')).toBeInTheDocument();
    await user.type(input(), 'web');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    // Projects first for a plain query; the package lookup comes last.
    expect(options[0]).toBe('webProject');
    expect(options.at(-1)).toBe('web (all versions)Is it anywhere?');
    expect(options.some((o) => o?.includes('payments-api'))).toBe(false);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('answers name@version with the Verdict first, linking to the package page', async () => {
    const user = userEvent.setup();
    const search = vi.spyOn(api, 'searchExposure').mockResolvedValue(FOUND);
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await user.type(input(), 'event-stream@3.3.6');
    const verdict = await screen.findByTestId('cmdk-verdict');
    expect(search).toHaveBeenCalledWith('event-stream@3.3.6', expect.anything());
    expect(verdict).toHaveTextContent('Yes, it is here: 2 projects, 1 in production');
    expect(verdict).toHaveTextContent('payments-api (production); web (dev and test)');
    const options = screen.getAllByRole('option');
    expect(options[0]).toBe(verdict);
    await waitFor(() => expect(verdict).toHaveAttribute('aria-selected', 'true'));
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/packages?name=event-stream&version=3.3.6');
  });

  it('says "Not found in any of N projects" for "name version"', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'searchExposure').mockResolvedValue({ query: { name: 'left-pad', version: '1.3.0' }, projectsSearched: 7, items: [] });
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await user.type(input(), 'left-pad 1.3.0');
    expect(await screen.findByTestId('cmdk-verdict')).toHaveTextContent('Not found in any of 7 projects');
  });

  it('shows the raw reason when the check fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'searchExposure').mockRejectedValue(new Error('Request failed (500)'));
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await user.type(input(), 'x@1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (500)');
  });

  it('explains instead of searching without the exposure permission', async () => {
    const user = userEvent.setup();
    const search = vi.spyOn(api, 'searchExposure');
    renderPalette(reportsOnly());
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await user.type(input(), 'x@1');
    await act(() => new Promise((r) => setTimeout(r, 250)));
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText(/needs the Exposure matrix page/)).toBeInTheDocument();
  });

  it('keeps nothing between openings', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    await user.type(input(), 'web');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'open palette' }));
    expect(input()).toHaveValue('');
    expect(localStorage.length).toBe(0);
  });
});
