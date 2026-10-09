/**
 * Regressions for bugs the hammer run found: axe serious/critical issues (contrast, aria,
 * scrollable regions), the sidebar rail over table rows, the mobile nav sheet staying open,
 * 403s from the nav for read-only roles, and the plain-word column labels.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
      // An incident to look at (idempotent: the same advisory raises its alerts once).
      const advisory = JSON.parse(readFileSync(new URL('../../test/replay/data/advisories/GHSA-mh6f-8j2x-4483.json', import.meta.url), 'utf8')) as unknown;
      expect((await page.request.post('/api/alerts/check', { data: { advisories: [advisory] }, headers: { 'X-Requested-With': 'blastradius' } })).status()).toBe(200);
      const paths = [
        '/',
        '/findings',
        '/findings?group=project&severity=critical',
        '/projects',
        '/incidents',
        '/incidents/GHSA-mh6f-8j2x-4483',
        '/alerts',
        '/alerts?rule=new',
        '/packages?name=event-stream&version=3.3.6',
        '/packages?name=flatmap-stream&view=table',
        '/packages/behind?name=event-stream',
        '/packages/behind?name=event-stream&view=table&unreviewed=1',
        '/exposure',
        '/exposure?view=table',
        '/reports',
        '/integrations',
        '/settings',
        '/settings?tab=roles',
        '/settings?tab=bindings',
        '/settings?tab=project',
        '/settings?tab=audit',
        ...['changes', 'findings', 'findings?view=health', 'exposure', 'investigate', 'scans'].map((p) => `/projects/${project}/${p}`),
      ];
      const list = await page.request.get(`/api/findings?project=${project}&level=critical&limit=1`);
      const fid = ((await list.json()) as { items: { id: string }[] }).items[0]!.id;
      paths.push(`/projects/${project}/findings/${fid}`, `/findings?group=project&peek=${fid}`);
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
  for (const path of ['/', '/findings', '/incidents', '/alerts', '/projects', '/reports', '/no-such-page', '/reports']) {
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

  test('Findings use plain words: Package, no Blast or Purl column shown by default', async ({ page }) => {
    await login(page, 'admin');
    const project = await devProject(page);
    await page.goto(`/projects/${project}/findings`);
    const table = page.getByRole('table').first();
    await expect(table.getByRole('columnheader', { name: /Package/ }).first()).toBeVisible();
    const headers = await table.getByRole('columnheader').allInnerTexts();
    for (const h of headers) expect(h).not.toMatch(/Blast|Purl|noisy/i);
    await expect(page.getByText(/noisy-OR|Upkeep signals|Snapshot/)).toHaveCount(0);
  });
});

test('mobile: the nav sheet closes after choosing a page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'admin').catch(() => undefined); // the nav is in the closed sheet on mobile
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  const project = await devProject(page);
  await page.goto(`/projects/${project}/findings`);
  for (const name of ['Projects', 'Reports', 'Findings']) {
    await page.getByRole('button', { name: 'Toggle Sidebar' }).first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('link', { name, exact: true }).click();
    await expect(sheet).toBeHidden();
  }
});

test.describe('hammer round 2', () => {
  test('Findings: Escape closes the peek sheet and the list keeps its scroll position on Back', async ({ page }) => {
    await login(page, 'admin');
    await devProject(page);
    await page.setViewportSize({ width: 1280, height: 300 });
    await page.goto('/findings?group=project');
    const table = page.getByRole('table', { name: 'Findings' });
    const rows = table.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const last = rows.last();
    await last.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const y = await page.evaluate(() => window.scrollY);
    expect(y, 'the list scrolls at this height').toBeGreaterThan(100);
    await last.locator('td').nth(2).getByRole('button').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page).not.toHaveURL(/peek=/);
    await last.locator('td').nth(2).getByRole('button').click();
    await page.getByRole('dialog').getByRole('link', { name: 'Open full page' }).click();
    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible();
    await page.goBack();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 80);
  });

  test('user menu stays open through a transient viewport resize (full-page screenshot)', async ({ page }) => {
    // A short viewport makes the page taller than the window, so Chromium resizes it (through
    // 1x1) to take a full-page capture. That used to flip the sidebar to its mobile tree and
    // back, remounting the open user menu closed.
    await page.setViewportSize({ width: 1440, height: 400 });
    await login(page, 'developer');
    await settle(page);
    await page.getByTestId('nav-user').click();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
    await page.getByRole('menuitem', { name: 'Sign out' }).click({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('Reports: the SHA-256 shown equals sha256 of the JSON download', async ({ page }) => {
    await login(page, 'admin');
    const project = await devProject(page);
    await page.goto(`/reports?project=${project}`);
    const table = page.getByRole('table').first();
    const row = table.locator('tbody tr').first();
    await expect(row).toBeVisible();
    // The full hash is in the tooltip of the short one.
    const headers = await table.getByRole('columnheader').allInnerTexts();
    const idx = headers.findIndex((h) => /SHA-256/.test(h));
    expect(idx).toBeGreaterThanOrEqual(0);
    await row.locator('td').nth(idx).locator('span[tabindex="0"]').focus();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveText(/^[0-9a-f]{64}$/);
    const shown = (await tip.innerText()).trim();

    await row.getByRole('button', { name: /More download formats/ }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Download JSON report/ }).click()]);
    const file = await download.path();
    const bytes = readFileSync(file);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(shown);
  });
});

test('Findings: maintenance-only signals sit in their own tab, apart from findings (noise rule)', async ({ page }) => {
  await login(page, 'admin');
  const project = await devProject(page);
  const health = await page.request.get(`/api/projects/${project}/health`);
  expect(health.status()).toBe(200);
  const items = ((await health.json()) as { items: { purl: string }[] }).items;
  await page.goto(`/projects/${project}/findings`);
  await settle(page);
  const upkeep = page.getByRole('tab', { name: /Maintenance/ });
  await expect(upkeep).toContainText(`(${items.length})`);
  await upkeep.click();
  await expect(page).toHaveURL(/[?&]view=health/);
  const table = page.getByRole('table', { name: 'Maintenance' });
  await expect(table).toBeVisible();
  if (items.length) await expect(table.locator('tbody tr').first()).toBeVisible();
  // No purl is both a finding and an upkeep entry.
  const findings = await page.request.get(`/api/findings?project=${project}&limit=500`);
  const fpurls = new Set(((await findings.json()) as { items: { purl: string }[] }).items.map((f) => f.purl));
  expect(items.filter((i) => fpurls.has(i.purl))).toEqual([]);
});

test('Overview: an advisory check raises an incident banner that opens the incident', async ({ page }) => {
  await login(page, 'admin');
  await devProject(page);
  const advisory = JSON.parse(readFileSync(new URL('../../test/replay/data/advisories/GHSA-mh6f-8j2x-4483.json', import.meta.url), 'utf8')) as unknown;
  const res = await page.request.post('/api/alerts/check', { data: { advisories: [advisory] }, headers: { 'X-Requested-With': 'blastradius' } });
  expect(res.status()).toBe(200);
  await page.goto('/');
  await settle(page);
  const banner = page.getByRole('link', { name: /Active incident/ });
  await expect(banner).toContainText('GHSA-mh6f-8j2x-4483');
  await expect(banner).toContainText(/projects? affected · \d+ in production/);
  await expect(banner).toHaveAttribute('href', '/incidents/GHSA-mh6f-8j2x-4483');
});
