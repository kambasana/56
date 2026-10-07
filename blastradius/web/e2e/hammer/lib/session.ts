/** Browser contexts per role, theme and viewport, plus the role -> page expectations of PLAN §12. */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { userFor, type Role, type Theme, type Viewport } from './env';

export const THEME_KEY = 'blastradius.theme';

export type PagePerm = 'home' | 'projects' | 'reports' | 'integrations' | 'settings' | 'changes' | 'findings' | 'exposure' | 'investigate' | 'scans';
export const ALL_PAGES: readonly PagePerm[] = ['home', 'projects', 'reports', 'integrations', 'settings', 'changes', 'findings', 'exposure', 'investigate', 'scans'];

/** PLAN §12 default templates: Org admin everything; AppSec and Developer every page but Settings; Auditor Reports only. */
export const ROLE_PAGES: Record<Role, readonly PagePerm[]> = {
  admin: ALL_PAGES,
  appsec: ALL_PAGES.filter((p) => p !== 'settings'),
  developer: ALL_PAGES.filter((p) => p !== 'settings'),
  auditor: ['reports'],
};

/** Sidebar labels per page permission (src/nav.ts). */
export const NAV_LABEL: Record<PagePerm, string> = {
  home: 'Home',
  projects: 'Projects',
  reports: 'Reports',
  integrations: 'Integrations',
  settings: 'Settings',
  changes: 'Changes',
  findings: 'Findings',
  exposure: 'Exposure matrix',
  investigate: 'Investigate',
  scans: 'Scans',
};

export async function openAs(browser: Browser, role: Role | null, theme: Theme, vp: Viewport): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...(role ? { storageState: userFor(role).storageState } : {}),
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.name === 'mobile',
    hasTouch: vp.name === 'mobile',
    deviceScaleFactor: vp.name === 'mobile' ? 2 : 1,
    colorScheme: theme,
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([k, t]) => {
      try {
        localStorage.setItem(k, t);
      } catch {
        /* storage blocked */
      }
    },
    [THEME_KEY, theme] as const,
  );
  const page = await context.newPage();
  return { context, page };
}

/** The sidebar's link labels. On mobile the sidebar is a sheet: open it first, close after. */
export async function navLinks(page: Page, mobile: boolean): Promise<{ label: string; href: string }[]> {
  if (mobile) await openMobileNav(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.waitFor({ state: 'visible' });
  const links = await nav.locator('a[href]').evaluateAll((els) =>
    els.map((e) => ({ label: (e as HTMLElement).innerText.trim(), href: e.getAttribute('href') ?? '' })),
  );
  if (mobile) await closeMobileNav(page);
  return links;
}

/** Wait out sheet open/close animations so clicks land on a stable element. */
async function sheetIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('[data-slot=sheet-content][data-state=closed], [data-slot=sheet-overlay][data-state=closed]'), undefined, { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(350);
}

export async function openMobileNav(page: Page): Promise<void> {
  await sheetIdle(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (await nav.isVisible()) return;
  await page.getByRole('button', { name: /toggle sidebar/i }).first().click();
  await nav.waitFor({ state: 'visible' });
  await sheetIdle(page);
}

/** True when the mobile nav sheet is open. */
export async function mobileNavOpen(page: Page): Promise<boolean> {
  return page.getByRole('navigation', { name: 'Main' }).isVisible();
}

export async function closeMobileNav(page: Page): Promise<void> {
  if (!(await mobileNavOpen(page))) return;
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: 'Main' }).waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  await sheetIdle(page);
}
