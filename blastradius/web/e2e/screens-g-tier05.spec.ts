/**
 * Tier 0.5 on the seeded fixture (`serve --dev-seed`): the demo project payments-platform is badged
 * "demo" on the Projects page and never counted as a real project; the Overview says its numbers are
 * demo data; axe clean in light and dark.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devProject, login, watchConsole } from './helpers';

async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.impact} ${v.id}: ${n.target.join(' ')} ${n.any[0]?.message ?? ''}`.slice(0, 300)));
}

test.describe('tier 0.5: the demo project', () => {
  let errors: () => string[] = () => [];
  test.beforeEach(async ({ page }) => {
    await login(page, 'admin');
    errors = watchConsole(page);
    await devProject(page);
  });
  test.afterEach(async () => {
    expect(errors(), 'console errors').toEqual([]);
  });

  test('Projects badges payments-platform "demo" and counts no real project; Overview calls its numbers demo data', async ({ page }) => {
    await page.goto('/projects');
    const table = page.getByRole('table', { name: 'Projects' });
    const row = table.getByRole('row').filter({ hasText: 'payments-platform' });
    await expect(row.getByText('demo', { exact: true })).toBeVisible();
    await expect(page.getByText(/^\d+ projects? · 1 demo \(not counted\)$/)).toBeVisible();
    await page.goto('/');
    await expect(page.getByText(/Demo data: these numbers come from the demo project|The demo project is left out of these totals/)).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`demo badge screens have no serious axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const problems: string[] = [];
      for (const path of ['/projects', '/']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(300);
        problems.push(...(await seriousAxe(page)).map((p) => `${path}: ${p}`));
      }
      expect(problems).toEqual([]);
    });
  }
});
