/**
 * Licences on the seeded fixture (payments-platform: 10 npm packages and 2 GitHub Actions; the
 * deps.dev / ClearlyDefined responses are recorded under test/fixtures/licenses/e2e-repo and
 * replayed offline as of 2018-11-27): the org-wide and project views, the tiles that filter the
 * table through the URL, the Chart/Table toggle, the policy editor (org admin only) and axe in
 * light and dark. Named to run last; the policy it edits is reset at the end.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devProject, login, shot, watchConsole } from './helpers';

async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.impact} ${v.id}: ${n.target.join(' ')} ${n.any[0]?.message ?? ''}`.slice(0, 300)));
}

test.describe('licences', () => {
  let errors: () => string[] = () => [];
  let projectId = '';

  test.afterEach(async () => {
    expect(errors(), 'console errors').toEqual([]);
  });

  test('org-wide view: tiles filter the table, categories have a table view, sources are named', async ({ page }) => {
    await login(page, 'appsec');
    errors = watchConsole(page);
    projectId = await devProject(page);
    await page.goto('/');
    await page.getByRole('link', { name: 'Licences of your dependencies' }).click();
    await expect(page).toHaveURL(/\/licenses$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Licences' })).toBeVisible();
    await expect(page.getByText('This is not legal advice', { exact: false }).first()).toBeVisible();

    await expect(page.getByRole('button', { name: 'Unknown licence: 2, nothing we could identify' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Denied: 0, by your policy' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Component licences' });
    await expect(table.getByRole('row')).toHaveCount(13);
    const ms = table.getByRole('row').filter({ hasText: 'ms@2.1.1' });
    await expect(ms).toContainText('MIT');
    await expect(ms).toContainText('Permissive');
    await expect(ms.getByRole('link', { name: 'deps.dev' })).toHaveAttribute('href', 'https://deps.dev/npm/ms/2.1.1');

    await page.getByRole('button', { name: 'Unknown licence: 2, nothing we could identify' }).click();
    await expect(page).toHaveURL(/category=unknown/);
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table).toContainText('actions/checkout@v4');
    await expect(table).toContainText('no licence declared');
    await page.goBack();
    await expect(table.getByRole('row')).toHaveCount(13);

    const categories = page.getByRole('region', { name: 'Components by category' });
    await expect(categories.getByRole('figure')).toHaveAttribute('aria-label', /Permissive 10, .*Unknown 2 of 12/);
    await categories.getByRole('button', { name: 'Table' }).click();
    await expect(page).toHaveURL(/view=table/);
    await expect(categories.getByRole('table', { name: 'Components by licence category' })).toContainText('Needs review');
    await shot(page, 'licenses-org');
  });

  test('project view sits in the project sub-nav', async ({ page }) => {
    await login(page, 'developer');
    errors = watchConsole(page);
    projectId = await devProject(page);
    await page.goto(`/projects/${encodeURIComponent(projectId)}/findings`);
    await page.getByRole('navigation', { name: /project/i }).getByRole('link', { name: 'Licences' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/licenses$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Licences' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Component licences' }).getByRole('row')).toHaveCount(13);
    // Edit stays visible, disabled, with the reason (docs/UX.md §6).
    await expect(page.getByRole('button', { name: 'Edit policy' })).toBeDisabled();
    await expect(page.getByText(/Needs the Manage projects permission/)).toBeVisible();
  });

  test('an org admin denies a category and the view follows at once; reset restores the default', async ({ page }) => {
    await login(page, 'admin');
    errors = watchConsole(page);
    await devProject(page);
    await page.goto('/licenses');
    await page.getByRole('button', { name: 'Edit policy' }).click();
    const dialog = page.getByRole('dialog', { name: 'Licence policy' });
    await dialog.getByRole('group', { name: 'Unknown' }).getByRole('radio', { name: 'Denied' }).check();
    await expect(dialog.getByRole('group', { name: 'Unknown' }).getByRole('radio', { name: 'Allowed' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save policy' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Denied: 2, by your policy' })).toBeVisible();
    await page.getByRole('button', { name: 'Denied: 2, by your policy' }).click();
    await expect(page.getByRole('table', { name: 'Component licences' })).toContainText('unknown: no licence declared');
    await page.getByRole('button', { name: 'Edit policy' }).click();
    await page.getByRole('dialog', { name: 'Licence policy' }).getByRole('button', { name: 'Reset to default' }).click();
    await expect(page.getByRole('button', { name: 'Denied: 0, by your policy' })).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`licence screens have no serious axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await login(page, 'admin');
      errors = watchConsole(page);
      projectId = await devProject(page);
      const problems: string[] = [];
      for (const path of ['/licenses', '/licenses?view=table', '/licenses?category=unknown', `/projects/${encodeURIComponent(projectId)}/licenses`]) {
        await page.goto(path);
        await expect(page.getByRole('table', { name: 'Component licences' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        problems.push(...(await seriousAxe(page)).map((p) => `${path}: ${p}`));
      }
      await page.getByRole('button', { name: 'Edit policy' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      // Let the open animation finish: mid-fade the dialog is translucent and axe reads blended colours.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
      problems.push(...(await seriousAxe(page)).map((p) => `dialog: ${p}`));
      await shot(page, `licenses-policy-${scheme}`);
      expect(problems).toEqual([]);
    });
  }
});
