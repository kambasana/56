import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RiskBadge } from './Badge';
import { StatTile } from './StatTile';
import { EmptyState } from './EmptyState';

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
    expect(crit.className).toContain('bg-destructive');
    expect(crit).toHaveTextContent('Critical92');
    expect(screen.getByText('High').className).toContain('text-warning');
    expect(screen.getByText('Low').className).toContain('text-muted-foreground');
  });

  it('renders a stat tile and an empty state', () => {
    render(
      <>
        <StatTile label="Critical" value="12" hint="+3 since last scan" tone="critical" />
        <EmptyState title="No scans yet" description="Run a scan to see findings." />
      </>,
    );
    expect(screen.getByText('12').className).toContain('text-destructive');
    expect(screen.getByRole('status')).toHaveTextContent('No scans yet');
  });
});
