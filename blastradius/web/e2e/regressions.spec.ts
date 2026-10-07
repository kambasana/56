/**
 * Regressions for bugs the hammer run found: axe serious/critical issues (contrast, aria,
 * scrollable regions), the sidebar rail over table rows, the mobile nav sheet staying open,
 * 403s from the nav for roles without the projects page, and the Blast column precision.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devProject, login } from './helpers';

async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.impact} ${v.id}: ${n.target.join(' ')} ${n.any[0]?.message ?? ''}`.slice(0, 300)));
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

test.describe('accessibility (axe serious/critical)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`admin pages have no serious axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await login(page, 'admin');
      const project = await devProject(page);
      const paths = [
        '/',
        '/reports',
        '/integrations',
        '/settings',
        '/settings?tab=roles',
        '/settings?tab=bindings',
        '/settings?tab=project',
        '/settings?tab=audit',
        ...['changes', 'findings', 'exposure', 'investigate', 'scans'].map((p) => `/projects/${project}/${p}`),
      ];
      const problems: string[] = [];
      for (const path of paths) {
        await page.goto(path);
        await settle(page);
        problems.push(...(await seriousAxe(page)).map((p) => `${path}: ${p}`));
      }
      expect(problems).toEqual([]);
    });
  }
});

test('auditor navigates without any 4xx from the API (no /api/projects 403)', async ({ page }) => {
  await login(page, 'auditor');
  const bad: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
  });
  for (const path of ['/reports', '/no-such-page', '/reports']) {
    await page.goto(path);
    await settle(page);
  }
  expect(bad).toEqual([]);
  const mine = await page.request.get('/api/me/projects');
  expect(mine.status()).toBe(200);
  expect(((await mine.json()) as { items: { name: string }[] }).items.map((p) => p.name)).toContain('payments-platform');
});

test.describe('layout', () => {
  test('the sidebar rail never sits over table rows', async ({ page }) => {
    await login(page, 'admin');
    const project = await devProject(page);
    for (const p of ['changes', 'findings', 'scans']) {
      await page.goto(`/projects/${project}/${p}`);
      await settle(page);
      const rail = await page.locator('[data-slot=sidebar-rail]').boundingBox();
      const inset = await page.locator('[data-slot=sidebar-inset]').boundingBox();
      expect(rail && inset, p).toBeTruthy();
      expect(rail!.x + rail!.width, `${p}: rail right edge vs inset left`).toBeLessThanOrEqual(inset!.x + 0.5);
    }
  });

  test('Changes tabs point aria-controls at a real tabpanel', async ({ page }) => {
    await login(page, 'admin');
    const project = await devProject(page);
    await page.goto(`/projects/${project}/changes`);
    const tab = page.getByRole('tablist', { name: 'Change type' }).getByRole('tab', { selected: true });
    const controls = await tab.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    await expect(page.locator(`[id="${controls}"]`)).toHaveAttribute('role', 'tabpanel');
  });

  test('Findings Blast column keeps decimals', async ({ page }) => {
    await login(page, 'admin');
    const project = await devProject(page);
    await page.goto(`/projects/${project}/findings`);
    const table = page.getByRole('table').first();
    await expect(table.getByRole('columnheader', { name: /Blast/ })).toBeVisible();
    const headers = await table.getByRole('columnheader').allInnerTexts();
    const idx = headers.findIndex((h) => /Blast/.test(h));
    const values = await table.locator('tbody tr').evaluateAll((rows, i) => rows.map((r) => r.querySelectorAll('td')[i]?.textContent?.trim() ?? ''), idx);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/^(<0\.01|[\d,]+\.\d\d)$/);
  });
});

test('mobile: the nav sheet closes after choosing a page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'admin').catch(() => undefined); // the nav is in the closed sheet on mobile
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  const project = await devProject(page);
  await page.goto(`/projects/${project}/findings`);
  for (const name of ['Exposure matrix', 'Reports', 'Changes']) {
    await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('link', { name, exact: true }).click();
    await expect(sheet).toBeHidden();
  }
});
