/**
 * Proposed facts on the dev seed: the proposals in test/fixtures/agentic/seed-proposals.json are the
 * real verification gate's output on recorded pages (stubbed model turns). AppSec reads the list
 * without decision buttons; the org admin confirms an organisation's jurisdiction and rejects an
 * unverified proposal; axe in light and dark. Named to run after the other screens (it decides).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login, shot, watchConsole } from './helpers';

async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.impact} ${v.id}: ${n.target.join(' ')} ${n.any[0]?.message ?? ''}`.slice(0, 300)));
}

test.describe('proposed facts', () => {
  let errors: () => string[] = () => [];

  test.afterEach(async () => {
    expect(errors(), 'console errors').toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`proposed facts have no serious axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await login(page, 'admin');
      errors = watchConsole(page);
      const problems: string[] = [];
      for (const path of ['/proposed-facts']) {
        await page.goto(path);
        await expect(page.getByRole('table', { name: 'Proposed facts' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        problems.push(...(await seriousAxe(page)).map((p) => `${path}: ${p}`));
      }
      await page.getByRole('button', { name: /Unverified proposal/ }).click();
      await expect(page.getByRole('table', { name: 'Proposed facts' }).getByRole('row')).toHaveCount(2);
      problems.push(...(await seriousAxe(page)).map((p) => `filtered: ${p}`));
      await shot(page, `proposed-facts-${scheme}`);
      expect(problems).toEqual([]);
    });
  }

  test('AppSec reads the list with evidence and gate results, without decisions', async ({ page }) => {
    await login(page, 'appsec');
    errors = watchConsole(page);
    await page.goto('/');
    await page.getByRole('link', { name: 'Proposed facts to review' }).click();
    await expect(page).toHaveURL(/\/proposed-facts$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Proposed facts' })).toBeVisible();
    await expect(page.getByRole('note')).toContainText('never used');
    await expect(page.getByRole('button', { name: /Needs confirmation\s*2/ })).toBeVisible();
    const table = page.getByRole('table', { name: 'Proposed facts' });
    await expect(table.getByRole('row')).toHaveCount(11);
    const fabricated = table.getByRole('row').filter({ hasText: 'Babel is funded entirely by Google' });
    await expect(fabricated).toContainText('Unverified proposal');
    await expect(fabricated).toContainText('the quoted text is not on the source page');
    const moment = table.getByRole('row').filter({ hasText: 'Moment.js is a legacy project in maintenance mode.' });
    await expect(moment).toContainText('Verified');
    await expect(moment.getByRole('link', { name: 'momentjs.com' })).toHaveAttribute('href', 'https://momentjs.com/docs/');
    await expect(table.getByRole('button')).toHaveCount(0);
    await shot(page, 'proposed-facts-appsec');
  });

  test('the org admin confirms a jurisdiction and rejects an unverified proposal', async ({ page }) => {
    await login(page, 'admin');
    errors = watchConsole(page);
    await page.goto('/proposed-facts');
    const table = page.getByRole('table', { name: 'Proposed facts' });
    await page.getByRole('button', { name: /^Confirm Organisation jurisdiction for funder:opencollective\/opensource: US/ }).click();
    const osc = table.getByRole('row').filter({ hasText: 'funder:opencollective/opensource' });
    await expect(osc).toContainText('Confirmed');
    await expect(osc).toContainText('by Dev Admin');
    await expect(page.getByRole('button', { name: /Needs confirmation\s*1/ })).toBeVisible();
    await page.getByRole('button', { name: /^Reject Funding for pkg:npm\/@babel\/core: corporate backer · Google$/ }).click();
    await expect(table.getByRole('row').filter({ hasText: 'Babel is funded entirely by Google' })).toContainText('Rejected');
    await expect(page.getByRole('button', { name: /^Rejected\s*1/ })).toBeVisible();
  });
});
