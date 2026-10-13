import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './theme-provider';
import { PageHeader } from './PageHeader';
import { ShellHeaderContext } from './shell-header';

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
      {theme}
    </button>
  );
}

describe('ThemeProvider', () => {
  it('puts the theme class on <html> and remembers the choice', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('system');
    expect(document.documentElement).toHaveClass('light');
    act(() => screen.getByRole('button').click());
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('light');
    expect(localStorage.getItem('blastradius.theme')).toBe('dark');
  });

  it('starts from the stored choice', () => {
    localStorage.setItem('blastradius.theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('dark');
  });
});

describe('PageHeader', () => {
  const crumbs = [{ label: 'acme-corp', to: '/' }, { label: 'Findings' }];

  it('renders breadcrumb and actions inline outside the shell', () => {
    render(
      <MemoryRouter>
        <PageHeader crumbs={crumbs} title="Findings" actions={<button type="button">Export</button>} />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'breadcrumb' });
    expect(nav).toHaveTextContent('acme-corpFindings');
    expect(screen.getByRole('link', { name: 'acme-corp' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('heading', { level: 1, name: 'Findings' })).toBeInTheDocument();
  });

  it('portals breadcrumb and actions into the shell top bar', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    render(
      <MemoryRouter>
        <ShellHeaderContext.Provider value={{ slot }}>
          <PageHeader crumbs={crumbs} title="Findings" actions={<button type="button">Export</button>} />
        </ShellHeaderContext.Provider>
      </MemoryRouter>,
    );
    expect(slot).toHaveTextContent('acme-corpFindingsExport');
    expect(screen.getByRole('heading', { level: 1, name: 'Findings' })).toBeInTheDocument();
    slot.remove();
  });
});
