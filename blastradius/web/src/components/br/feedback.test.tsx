import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeekSheet, useJK, usePeek } from './PeekSheet';
import { needsPermissionText, NotAllowedHint, StateBlock } from './StateBlock';
import { renderWithRouter } from './test-router';
import { Verdict, VerdictContent, verdictHeadline } from './Verdict';

const IDS = ['f1', 'f2', 'f3'];

function List() {
  const peek = usePeek();
  useJK({ ids: IDS, current: peek.id, onMove: peek.open, enabled: peek.id !== null });
  return (
    <>
      {IDS.map((id) => (
        <button key={id} type="button" onClick={() => peek.open(id)}>
          row {id}
        </button>
      ))}
      <PeekSheet open={peek.id !== null} onClose={peek.close} title={`Finding ${peek.id}`} description="Malicious release" fullPageHref={`/findings/${peek.id}`}>
        <p>body of {peek.id}</p>
      </PeekSheet>
    </>
  );
}

describe('<PeekSheet> with usePeek and useJK', () => {
  it('puts the open row in the URL, moves with J/K and closes with Back', async () => {
    const user = userEvent.setup();
    const { url, router } = renderWithRouter(<List />, '/findings?severity=critical');
    await user.click(screen.getByRole('button', { name: 'row f1' }));
    expect(url()).toBe('/findings?severity=critical&peek=f1');
    const dialog = await screen.findByRole('dialog', { name: 'Finding f1' });
    expect(dialog).toHaveTextContent('Malicious release');
    expect(screen.getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/findings/f1');
    expect(dialog).toHaveTextContent('J / K for next and previous');

    fireEvent.keyDown(document.body, { key: 'j' });
    expect(url()).toBe('/findings?severity=critical&peek=f2');
    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'j' }); // stays on the last row
    expect(url()).toBe('/findings?severity=critical&peek=f3');
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(url()).toBe('/findings?severity=critical&peek=f2');
    fireEvent.keyDown(document.body, { key: 'j', metaKey: true }); // modifiers are ignored
    expect(url()).toBe('/findings?severity=critical&peek=f2');

    // J/K replaced the entry, so one Back closes the sheet.
    await act(() => router.navigate(-1));
    expect(url()).toBe('/findings?severity=critical');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes with Escape by going back to the list entry', async () => {
    const user = userEvent.setup();
    const { url } = renderWithRouter(<List />, '/findings');
    await user.click(screen.getByRole('button', { name: 'row f3' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(url()).toBe('/findings');
  });

  it('opened from a shared link, closing drops the param in place', async () => {
    const user = userEvent.setup();
    const { url } = renderWithRouter(<List />, '/findings?peek=f2');
    expect(await screen.findByRole('dialog', { name: 'Finding f2' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(url()).toBe('/findings');
  });

  it('ignores J/K while typing', () => {
    const onMove = vi.fn();
    function Typing() {
      useJK({ ids: IDS, current: 'f1', onMove });
      return <input aria-label="search" />;
    }
    renderWithRouter(<Typing />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'search' }), { key: 'j' });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'J' });
    expect(onMove).toHaveBeenCalledWith('f2');
  });
});

describe('<Verdict>', () => {
  it('leads with the answer', () => {
    expect(verdictHeadline({ projects: 3, production: 1, searched: 42 })).toBe('Yes, it is here: 3 projects, 1 in production');
    expect(verdictHeadline({ projects: 1, production: 0, searched: 42 })).toBe('Yes, it is here: 1 project, 0 in production');
    expect(verdictHeadline({ projects: 0, production: 0, searched: 42 })).toBe('Not found in any of 42 projects');
    expect(verdictHeadline({ projects: 0, production: 0, searched: 1 })).toBe('Not found in the 1 project searched');
  });

  it('is one link to the incident when found', () => {
    renderWithRouter(<Verdict data={{ pkg: 'ua-parser-js@0.7.29', projects: 3, production: 1, searched: 42, advisory: 'GHSA-pjwm-rvh2-c87w', detail: 'payments-api (production)' }} to="/packages?name=ua-parser-js&version=0.7.29" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/packages?name=ua-parser-js&version=0.7.29');
    expect(link).toHaveTextContent('Yes, it is here: 3 projects, 1 in production');
    expect(link).toHaveTextContent('Open incident');
    expect(link).toHaveTextContent('ua-parser-js@0.7.29 (GHSA-pjwm-rvh2-c87w). payments-api (production)');
    expect(link.className).toContain('bg-sev-critical-soft');
  });

  it('shows not found on success-soft', () => {
    renderWithRouter(<Verdict data={{ pkg: 'left-pad@1.3.0', projects: 0, production: 0, searched: 7 }} to="/packages?name=left-pad" />);
    const link = screen.getByRole('link');
    expect(link.className).toContain('bg-success-soft');
    expect(link).toHaveTextContent('✓ Not found in any of 7 projects');
    expect(link).toHaveTextContent('Open package');
  });

  it('renders content without a link for cmdk items', () => {
    renderWithRouter(<VerdictContent data={{ pkg: 'x@1', projects: 2, production: 2, searched: 2 }} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Yes, it is here: 2 projects, 2 in production')).toBeInTheDocument();
  });
});

describe('<StateBlock>', () => {
  it('all-clear says what was checked', () => {
    renderWithRouter(<StateBlock kind="all-clear" title="No open findings in web" description="1,104 packages checked 12 min ago." actions={[{ label: 'Show resolved and accepted (14)', to: '/findings?status=resolved' }]} />);
    const s = screen.getByRole('status');
    expect(s).toHaveAttribute('data-kind', 'all-clear');
    expect(s).toHaveTextContent('✓ No open findings in web');
    expect(screen.getByRole('link', { name: 'Show resolved and accepted (14)' })).toHaveAttribute('href', '/findings?status=resolved');
  });

  it('no-results offers recovery actions', async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    renderWithRouter(<StateBlock kind="no-results" title="No critical findings in cli" actions={[{ label: 'Remove "Severity: Critical" (6 results)', onClick: remove }, { label: 'Search all projects (4 results)', to: '/findings' }]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Try one of these:');
    await user.click(screen.getByRole('button', { name: 'Remove "Severity: Critical" (6 results)' }));
    expect(remove).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Search all projects (4 results)' })).toBeInTheDocument();
  });

  it('error shows the raw cause in mono and Retry', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    renderWithRouter(
      <StateBlock kind="error" title="Scan of acme/billing-worker failed" cause="GitHub returned 404 for package-lock.json at main" onRetry={retry} actions={[{ label: 'Check access in Sources', to: '/integrations' }]} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('code')).toHaveTextContent('GitHub returned 404 for package-lock.json at main');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Check access in Sources' })).toBeInTheDocument();
  });

  it('not-allowed names the permission and who can grant it', () => {
    renderWithRouter(<StateBlock kind="not-allowed" title="Status" permission="review" admins={['Priya Shah', 'Sam Rivera']} />);
    expect(screen.getByRole('status')).toHaveTextContent('Needs the Triage permission: ask an admin (Priya Shah, Sam Rivera).');
    expect(needsPermissionText('accept_risk')).toBe('Needs the Accept risk permission: ask an admin.');
    renderWithRouter(<NotAllowedHint id="why" permission="manage_alert_rules" />);
    expect(document.getElementById('why')).toHaveTextContent('Needs the Alert rules permission');
  });

  it('loading is skeleton rows in the final layout, not a spinner', () => {
    renderWithRouter(<StateBlock kind="loading" rows={4} columns={3} label="Loading findings" />);
    const s = screen.getByRole('status', { name: 'Loading findings' });
    expect(s).toHaveAttribute('aria-busy', 'true');
    expect(s.querySelectorAll('[data-slot=skeleton]')).toHaveLength(12);
  });
});
