import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScrollRegion } from './ScrollRegion';

describe('<ScrollRegion>', () => {
  it('is a focusable, named region (axe scrollable-region-focusable)', () => {
    render(
      <ScrollRegion as="pre" label="API examples" className="bg-muted">
        GET /api/findings
      </ScrollRegion>,
    );
    const region = screen.getByRole('region', { name: 'API examples' });
    expect(region.tagName).toBe('PRE');
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toContain('overflow-auto');
    expect(region.className).toContain('bg-muted');
  });

  it('takes over scrolling from a wrapped shadcn table container', () => {
    render(
      <ScrollRegion label="Tier settings">
        <div data-slot="table-container" />
      </ScrollRegion>,
    );
    expect(screen.getByRole('region', { name: 'Tier settings' }).tagName).toBe('DIV');
    expect(screen.getByRole('region', { name: 'Tier settings' }).className).toContain('[&>[data-slot=table-container]]:overflow-visible');
  });
});
