/**
 * A keyboard-reachable scroll box (axe scrollable-region-focusable): tabIndex 0, role=region and
 * an accessible name, so keyboard users can focus it and scroll with the arrow keys.
 *
 * `as="pre"` for code samples. Around a shadcn <Table>, the table's own overflow container is
 * made non-scrolling so this region is the one that scrolls.
 */
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type ScrollRegionProps = { label: string; as?: 'div' | 'pre' } & Omit<HTMLAttributes<HTMLElement>, 'aria-label' | 'role' | 'tabIndex'>;

export function ScrollRegion({ label, as = 'div', className, ...props }: ScrollRegionProps) {
  const shared = {
    ...props,
    role: 'region',
    'aria-label': label,
    tabIndex: 0,
    'data-slot': 'scroll-region',
    className: cn('overflow-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>[data-slot=table-container]]:overflow-visible', className),
  };
  return as === 'pre' ? <pre {...shared} /> : <div {...shared} />;
}
