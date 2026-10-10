import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RiskBadge } from './Badge';
import { Button, ButtonLink } from './Button';
import { StatTile } from './StatTile';
import { EmptyState, ErrorState } from './EmptyState';

describe('small components', () => {
  it('maps risk levels like the canvas', () => {
    render(
      <>
        <RiskBadge level="critical" score={92.4} />
        <RiskBadge level="high" />
        <RiskBadge level="medium" />
        <RiskBadge level="low" />
      </>,
    );
    const crit = screen.getByText('Critical').closest('[data-level]')!;
    expect(crit).toHaveAttribute('data-level', 'critical');
    expect(crit).toHaveAttribute('data-slot', 'badge');
    expect(crit.className).toContain('bg-sev-critical-soft');
    expect(crit).toHaveTextContent('◆Critical92');
    expect(screen.getByText('High').className).toContain('text-sev-high');
    expect(screen.getByText('Medium').className).toContain('text-sev-medium');
    expect(screen.getByText('Low').className).toContain('text-sev-low');
  });

  it('renders a stat tile and an empty state', () => {
    render(
      <>
        <StatTile label="Critical" value="12" hint="+3 since last scan" tone="critical" />
        <EmptyState title="No scans yet" description="Run a scan to see findings." />
      </>,
    );
    expect(screen.getByText('12').className).toContain('text-destructive');
    expect(screen.getByText('12').closest('[data-slot=card]')).toHaveTextContent('Critical12+3 since last scan');
    expect(screen.getByRole('status')).toHaveTextContent('No scans yet');
    expect(screen.getByRole('status')).toHaveAttribute('data-slot', 'empty');
  });

  it('renders error and forbidden states', async () => {
    const retry = vi.fn();
    render(<ErrorState error={new Error('Boom')} onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });

  it('keeps button helpers on the shadcn button styles', () => {
    render(
      <MemoryRouter>
        <Button>Plain</Button>
        <ButtonLink to="/reports">Reports</ButtonLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Plain' })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: 'Plain' })).toHaveAttribute('data-slot', 'button');
    const link = screen.getByRole('link', { name: 'Reports' });
    expect(link).toHaveAttribute('href', '/reports');
    expect(link).toHaveAttribute('data-variant', 'outline');
  });
});
