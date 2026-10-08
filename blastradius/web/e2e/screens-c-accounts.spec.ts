/**
 * Account index on the seeded fixture (payments-platform locks event-stream 3.3.6, published by
 * right9ctrl; the registry data comes from the recorded packuments, offline): "Who's behind it"
 * opens the Account page, "Mark as compromised" opens an incident listing the exposure, Exposure
 * shows who can publish the production dependencies, and the new screens are axe clean in light
 * and dark. Named to run after screens-b: the account incident it opens would otherwise be the
 * newest incident the earlier specs look at.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devProject, login, shot, watchConsole } from './helpers';

/** The account index fills in after the seeded scan (asynchronously): wait for it. */
async function indexed(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await page.request.get('/api/accounts/npm/right9ctrl');
        if (!r.ok()) return `http ${r.status()}`;
        const d = (await r.json()) as { packages: { name: string; projects: number }[] };
        return d.packages.find((p) => p.name === 'event-stream')?.projects ?? 0;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
}

async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.impact} ${v.id}: ${n.target.join(' ')} ${n.any[0]?.message ?? ''}`.slice(0, 300)));
}

test.describe('accounts', () => {
  let errors: () => string[] = () => [];

  test.beforeEach(async ({ page }) => {
    await login(page, 'appsec');
    errors = watchConsole(page);
    await devProject(page);
    await indexed(page);
  });

  test.afterEach(async () => {
    expect(errors(), 'console errors').toEqual([]);
  });

  test("who's behind it opens the account; marking it compromised opens an incident listing the exposure", async ({ page }) => {
    await page.goto('/packages/behind?name=event-stream&view=table');
    await page.getByRole('table', { name: 'Links' }).getByRole('link', { name: 'npm · right9ctrl' }).click();
    await expect(page).toHaveURL(/\/accounts\/npm\/right9ctrl$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('npm account right9ctrl');

    const exposure = page.getByRole('table', { name: 'Exposure' });
    const row = exposure.getByRole('row').nth(1);
    await expect(row).toContainText('payments-platform');
    await expect(row).toContainText('Production');
    await expect(row).toContainText('event-stream@3.3.6');
    await expect(row).toContainText('direct dependency');
    await expect(row).toContainText('Payments · fixture repo');
    await expect(row).toContainText('Maintainer · High');
    await expect(page.getByRole('list', { name: 'Recent publishes' })).toContainText('event-stream@3.3.6');
    await expect(page.getByText(/Context only, never an alert/)).toBeVisible();
    await shot(page, 'account');

    await page.getByRole('button', { name: 'Mark as compromised' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Published since/).fill('2018-09-01T00:00');
    await dialog.getByRole('button', { name: 'Mark as compromised' }).click();

    await expect(page).toHaveURL(/\/incidents\/ACCOUNT-npm-right9ctrl$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('npm account right9ctrl');
    const where = page.getByRole('table', { name: 'Where it is' });
    await expect(where.getByRole('row').nth(1)).toContainText('event-stream@3.3.6');
    await expect(where.getByRole('row').nth(1)).toContainText('Production');
    await expect(page.getByRole('complementary', { name: 'Timeline' })).toContainText('marked right9ctrl as compromised');
    await shot(page, 'account-incident');

    // Incidents list: the account incident, and back to the account from the incident.
    await page.goto('/incidents');
    await expect(page.getByRole('table', { name: 'Incidents' })).toContainText('npm account right9ctrl');
    await page.goto('/incidents/ACCOUNT-npm-right9ctrl');
    await page.getByRole('complementary', { name: 'Timeline' }).getByRole('link', { name: 'npm · right9ctrl' }).click();
    await expect(page).toHaveURL(/\/accounts\/npm\/right9ctrl$/);
    await expect(page.getByRole('link', { name: 'Open the incident' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update the incident' })).toBeEnabled();
  });

  test('exposure shows who can publish the production dependencies, with a table view', async ({ page }) => {
    await page.goto('/exposure');
    const section = page.getByRole('region', { name: 'Who can publish your production dependencies' });
    await expect(section).toContainText('All projects');
    await expect(section.getByRole('link', { name: 'right9ctrl' }).first()).toBeVisible();
    await section.getByRole('button', { name: 'Table' }).click();
    await expect(page).toHaveURL(/cview=table/);
    const table = section.getByRole('table', { name: 'Publishing accounts' });
    await expect(table).toContainText('payments-platform');
    await table.getByRole('link', { name: 'right9ctrl' }).first().click();
    await expect(page).toHaveURL(/\/accounts\/npm\/right9ctrl$/);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`account screens have no serious axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const problems: string[] = [];
      for (const path of ['/accounts/npm/right9ctrl', '/accounts/github/dominictarr', '/accounts/npm/nobody-here', '/exposure', '/exposure?cview=table', '/incidents', '/incidents/ACCOUNT-npm-right9ctrl']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(300);
        problems.push(...(await seriousAxe(page)).map((p) => `${path}: ${p}`));
      }
      // The dialog too.
      await page.goto('/accounts/npm/right9ctrl');
      await page.getByRole('button', { name: /Mark as compromised|Update the incident/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      problems.push(...(await seriousAxe(page)).map((p) => `dialog: ${p}`));
      expect(problems).toEqual([]);
    });
  }
});

test('a read-only role sees "Mark as compromised" disabled with the reason', async ({ page }) => {
  await login(page, 'auditor');
  const errors = watchConsole(page);
  await page.goto('/accounts/npm/right9ctrl');
  await expect(page.getByRole('button', { name: /Mark as compromised|Update the incident/ })).toBeDisabled();
  await expect(page.getByText(/Needs the Triage permission/)).toBeVisible();
  expect(errors()).toEqual([]);
});
