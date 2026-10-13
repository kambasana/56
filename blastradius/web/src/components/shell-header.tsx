import { createContext, useContext } from 'react';

/**
 * The AppShell's top bar (next to the SidebarTrigger) as a portal target. PageHeader renders
 * its breadcrumb and actions there, so every screen has a single header row; outside the
 * shell (isolated page tests) PageHeader renders them inline instead.
 */
export const ShellHeaderContext = createContext<{ slot: HTMLElement | null } | null>(null);

export function useShellHeader(): { slot: HTMLElement | null } | null {
  return useContext(ShellHeaderContext);
}
