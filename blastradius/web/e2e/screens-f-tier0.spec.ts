/**
 * Tier 0 trust pass on the seeded fixture (recorded real event-stream data: payments-platform locks
 * event-stream 3.3.6, published by right9ctrl; KB incident INC-2018-0001 names that version):
 *  - the Package page shows who is behind it (publish rights, publisher of the locked version,
 *    owner, funding pages) with the review state, and its breadcrumbs no longer say "Incidents";
 *  - "Who's behind it" says machine-derived and reviewed apart, and a Triage user can mark a link
 *    reviewed (the only way it becomes reviewed);
 *  - the Account page flags the known-bad version in place and lists the KB incident;
 *  - all of it axe clean in light and dark.
 * Named to run after the other screens: it records a review decision.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { devProject, login, shot, watchConsole } from './helpers';

async function indexed(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await page.request.get('/api/packages/behind?name=event-stream');
        if (!r.ok()) return `http ${r.status()}`;
        const d = (await r.json()) as { publishRights: unknown[] | null };
        return d.publishRights === null ? 'no registry data yet' : 'ok';
      },
      { timeout: 30_000 },
    )
    .toBe('ok');
}

async function seriousAxe(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.impact} ${v.id}: ${n.target.join(' ')} ${n.any[0]?.message ?? ''}`.slice(0, 300)));
}

test.describe('tier 0: who is behind, review state, account pivot', () => {
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

  test('the package page shows who is behind it, and its breadcrumbs lead to Exposure', async ({ page }) => {
    await page.goto('/packages?name=event-stream&version=3.3.6');
    const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
    await expect(crumbs).toContainText('Exposure');
    await expect(crumbs).not.toContainText('Incidents');
    const section = page.getByRole('region', { name: 'Who is behind it' });
    await expect(section.getByRole('list', { name: 'Publish rights' })).toBeVisible();
    const locked = section.getByRole('list', { name: 'Locked versions' });
    await expect(locked).toContainText('3.3.6');
    await expect(locked).toContainText('by right9ctrl');
    await expect(locked).toContainText('Known bad: INC-2018-0001');
    await expect(section).toContainText(/machine-derived from public registry and repository records; 0 reviewed/);
    await shot(page, 'package-who-is-behind');

    await section.getByRole('link', { name: 'Every link, with sources' }).click();
    await expect(page).toHaveURL(/\/packages\/behind\?name=event-stream/);
    await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText('Exposure');
  });

  test("who's behind it says machine-derived and reviewed apart; Triage marks a link reviewed", async ({ page }) => {
    await page.goto('/packages/behind?name=event-stream&view=table');
    const table = page.getByRole('table', { name: 'Links' });
    const row = table.getByRole('row').filter({ hasText: 'npm · right9ctrl' });
    await expect(row).toContainText('Machine-derived (deterministic)');
    await expect(table).not.toContainText(/\bReviewed\b/);
    await row.getByRole('button', { name: /^Mark reviewed: maintains npm · right9ctrl/ }).click();
    await expect(row).toContainText('Reviewed by');
    await shot(page, 'behind-reviewed');
    await row.getByRole('button', { name: /^Undo review: maintains npm · right9ctrl/ }).click();
    await expect(row).toContainText('Machine-derived (deterministic)');
  });

  test('the account page flags the known-bad version in place and lists the KB incident', async ({ page }) => {
    await page.goto('/accounts/npm/right9ctrl');
    const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
    await expect(crumbs).toContainText('Exposure');
    const known = page.getByRole('list', { name: 'Known incidents and malware' });
    await expect(known).toContainText('INC-2018-0001');
    await expect(known).toContainText('Knowledge base incident');
    await expect(known).toContainText('event-stream@3.3.6');
    await expect(known).toContainText('A bad version is locked in your projects');
    const pubs = page.getByRole('list', { name: 'Recent publishes' });
    await expect(pubs.getByRole('listitem').filter({ hasText: 'event-stream@3.3.6' })).toContainText('Known bad: INC-2018-0001');
    await expect(page.getByRole('table', { name: 'Exposure' }).getByRole('row').nth(1)).toContainText('Known bad: INC-2018-0001');
    await page.getByText('How these are counted').click();
    await expect(page.getByText(/counted by name/).first()).toBeVisible();
    await shot(page, 'account-known-bad');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`tier 0 screens have no serious axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const problems: string[] = [];
      for (const path of ['/packages?name=event-stream&version=3.3.6', '/packages/behind?name=event-stream&view=table', '/packages/behind?name=event-stream', '/accounts/npm/right9ctrl']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(300);
        problems.push(...(await seriousAxe(page)).map((p) => `${path}: ${p}`));
      }
      expect(problems).toEqual([]);
    });
  }
});

test('a read-only role sees no review buttons', async ({ page }) => {
  await login(page, 'auditor');
  const errors = watchConsole(page);
  await page.goto('/packages/behind?name=event-stream&view=table');
  const table = page.getByRole('table', { name: 'Links' });
  await expect(table).toContainText('Machine-derived');
  await expect(table.getByRole('button', { name: /Mark reviewed/ })).toHaveCount(0);
  expect(errors()).toEqual([]);
});
