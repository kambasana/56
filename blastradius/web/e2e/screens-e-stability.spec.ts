/**
 * Stability labels on the seeded fixture (payments-platform, replayed offline as of 2018-11-27 with
 * the recorded npm packuments and the recorded event-stream git history): the Maintenance tab,
 * the side panel with the facts behind a label, the Package page section, the Changes page S5a
 * section, and axe in light and dark (docs/WHO-BEHIND-PLAN.md §4, P3).
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

test.describe('stability labels', () => {
  let errors: () => string[] = () => [];

  test.afterEach(async () => {
    expect(errors(), 'console errors').toEqual([]);
  });

  test('Maintenance tab: labels with counts, Watch for event-stream, facts in the side panel', async ({ page }) => {
    await login(page, 'appsec');
    errors = watchConsole(page);
    const projectId = await devProject(page);
    await page.goto(`/projects/${encodeURIComponent(projectId)}/findings?view=health`);
    const section = page.getByRole('region', { name: 'Stability' });
    await expect(section.getByText(/Fragile 0 · Watch \d+ · Steady \d+ · Unknown \d+/)).toBeVisible();
    await expect(section.getByText(/not a security verdict/)).toBeVisible();
    const table = section.getByRole('table', { name: 'Stability labels' });
    const es = table.getByRole('row').filter({ hasText: 'event-stream' });
    await expect(es).toContainText('Watch');
    await expect(es).toContainText('Single active contributor (CAF 1)');
    await es.getByText('event-stream').click();
    const panel = page.getByRole('complementary', { name: 'Stability details' });
    await expect(panel.getByRole('heading', { name: 'Watch: CAF = 1' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Watch: S5a release continuity' })).toBeVisible();
    await expect(panel.getByText('Release 3.3.5 was made by an account first seen in this repository 1 days earlier.').first()).toBeVisible();
    await expect(panel.getByText(/Funding not yet assessed/)).toBeVisible();
    // Packages without a recorded history say what is missing.
    await expect(table.getByRole('row').filter({ hasText: /^ms/ }).first()).toContainText('Unknown');
    await shot(page, 'stability-maintenance');
  });

  test('Package page shows the label; Changes page shows S5a observations', async ({ page }) => {
    await login(page, 'appsec');
    errors = watchConsole(page);
    const projectId = await devProject(page);
    await page.goto('/packages?name=event-stream');
    const section = page.getByRole('region', { name: 'Stability' });
    await expect(section.getByText('Watch', { exact: true }).first()).toBeVisible();
    await expect(section.getByText(/From the scan of payments-platform/)).toBeVisible();
    await page.goto(`/projects/${encodeURIComponent(projectId)}/changes`);
    const s5a = page.getByRole('region', { name: 'Release continuity (S5a)' });
    await expect(s5a.getByRole('list', { name: 'Release continuity observations' })).toContainText('event-stream');
    await expect(s5a).toContainText('Release 3.3.5 was made by an account first seen in this repository 1 days earlier.');
    await shot(page, 'stability-changes');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe: no serious or critical violations (${scheme})`, async ({ page }) => {
      await login(page, 'appsec');
      errors = watchConsole(page);
      await page.emulateMedia({ colorScheme: scheme });
      const projectId = await devProject(page);
      const problems: string[] = [];
      for (const path of [`/projects/${encodeURIComponent(projectId)}/findings?view=health`, '/packages?name=event-stream', `/projects/${encodeURIComponent(projectId)}/changes`]) {
        await page.goto(path);
        await expect(page.getByRole('region', { name: /Stability|Release continuity/ }).first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        problems.push(...(await seriousAxe(page)).map((p) => `${path}: ${p}`));
      }
      await page.goto(`/projects/${encodeURIComponent(projectId)}/findings?view=health`);
      await page.getByRole('table', { name: 'Stability labels' }).getByText('event-stream').click();
      await expect(page.getByRole('complementary', { name: 'Stability details' })).toBeVisible();
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
      problems.push(...(await seriousAxe(page)).map((p) => `panel: ${p}`));
      await shot(page, `stability-${scheme}`);
      expect(problems).toEqual([]);
    });
  }
});
