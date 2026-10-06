import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { devProject, login, navLabels, shot, watchConsole, type DevRole } from './helpers';

const ALL_PAGES = ['Home', 'Projects', 'Reports', 'Integrations', 'Changes', 'Findings', 'Exposure matrix', 'Investigate', 'Scans'];

// PLAN §12 default roles: Org admin everything; AppSec and Developer every page but Settings; Auditor only Reports.
const EXPECTED_NAV: Record<DevRole, { has: string[]; lacks: string[] }> = {
  admin: { has: [...ALL_PAGES, 'Settings'], lacks: [] },
  appsec: { has: ALL_PAGES, lacks: ['Settings'] },
  developer: { has: ALL_PAGES, lacks: ['Settings'] },
  auditor: { has: ['Reports'], lacks: [...ALL_PAGES.filter((p) => p !== 'Reports'), 'Settings', 'Incident KB'] },
};

test.describe('navigation per default role', () => {
  for (const role of Object.keys(EXPECTED_NAV) as DevRole[]) {
    test(`${role} sees the pages PLAN §12 grants`, async ({ page }) => {
      await login(page, role);
      // The signed-out /api/me 401 before login is expected; watch from here on.
      const errors = watchConsole(page);
      await page.reload();
      if (role !== 'auditor') {
        // The project group appears once the seeded project is known.
        await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Findings' })).toBeVisible();
      } else {
        await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' })).toBeVisible();
      }
      const labels = await navLabels(page);
      for (const l of EXPECTED_NAV[role].has) expect(labels, `${role} nav has ${l}`).toContain(l);
      for (const l of EXPECTED_NAV[role].lacks) expect(labels, `${role} nav lacks ${l}`).not.toContain(l);
      if (role === 'auditor') {
        expect(labels).toEqual(['Reports']);
        await shot(page, 'auditor-nav');
      } else {
        expect(errors()).toEqual([]);
      }
    });
  }
});

test('server denies the auditor GET /api/findings with 403', async ({ page }) => {
  await login(page, 'admin');
  const project = await devProject(page);
  await page.request.post('/api/auth/logout', { headers: { 'X-Requested-With': 'blastradius' } });
  await login(page, 'auditor');
  const res = await page.request.get(`/api/findings?project=${encodeURIComponent(project)}`);
  expect(res.status()).toBe(403);
  const home = await page.request.get('/api/home');
  expect(home.status()).toBe(403);
  const reports = await page.request.get('/api/reports');
  expect(reports.status()).toBe(200);
});

test.describe('admin screens', () => {
  let project = '';
  let errors: () => string[] = () => [];

  test.beforeEach(async ({ page }) => {
    await login(page, 'admin');
    errors = watchConsole(page);
    project = await devProject(page);
  });

  test.afterEach(async () => {
    expect(errors(), 'console errors').toEqual([]);
  });

  test('Org home', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('cell', { name: /payments-platform/ }).first()).toBeVisible();
    await shot(page, 'org-home');
  });

  test('Findings lists event-stream and flatmap-stream as critical and opens the side panel', async ({ page }) => {
    await page.goto(`/projects/${project}/findings`);
    const table = page.getByRole('table').first();
    for (const name of ['event-stream', 'flatmap-stream']) {
      // Match the component cell exactly: reason text of one row can mention the other package.
      const row = table.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
      await expect(row).toHaveCount(1);
      await expect(row).toBeVisible();
      await expect(row).toContainText(/critical/i);
    }
    await shot(page, 'findings');
    await table.getByText('flatmap-stream', { exact: true }).click();
    const panel = page.getByRole('complementary').or(page.getByRole('dialog')).first();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('flatmap-stream@0.1.1');
    await expect(page).toHaveURL(/[?&]f=/);
    await shot(page, 'findings-panel');
    await panel.getByRole('link', { name: /open finding/i }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/findings/`));
    await expect(page.getByText('flatmap-stream').first()).toBeVisible();
    await shot(page, 'finding');
  });

  test('Exposure matrix', async ({ page }) => {
    await page.goto(`/projects/${project}/exposure`);
    await expect(page.getByText('event-stream').first()).toBeVisible();
    await shot(page, 'exposure');
    await page.goto(`/projects/${project}/exposure?scope=org`);
    await expect(page.getByText('payments-platform').first()).toBeVisible();
    await shot(page, 'exposure-org');
  });

  test('Changes', async ({ page }) => {
    await page.goto(`/projects/${project}/changes`);
    await expect(page.getByRole('heading', { name: 'Changes' }).first()).toBeVisible();
    await expect(page.getByText(/first scan|no changes|nothing changed|added|new/i).first()).toBeVisible();
    await shot(page, 'changes');
  });

  test('Scans', async ({ page }) => {
    await page.goto(`/projects/${project}/scans`);
    await expect(page.getByText(/succeeded/i).first()).toBeVisible();
    await shot(page, 'scans');
  });

  test('Investigate draws a graph scoped to event-stream', async ({ page }) => {
    const graph = page.waitForResponse((r) => r.url().includes('/api/graph') && r.status() === 200);
    await page.goto(`/projects/${project}/investigate?node=${encodeURIComponent('pkg:npm/event-stream@3.3.6')}`);
    const res = await graph;
    const body = (await res.json()) as { nodes: { label?: string; id: string }[] };
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.nodes)).toContain('event-stream');
    const canvas = page.getByRole('img', { name: /graph/i }).first();
    await expect(canvas).toBeVisible();
    await expect(canvas.locator('canvas').first()).toBeAttached();
    await shot(page, 'investigate');
  });

  test('Reports lists the fixture scan and downloads the HTML report', async ({ page }) => {
    await page.goto('/reports');
    const link = page.getByRole('link', { name: /^Download HTML report for payments-platform/ }).first();
    await expect(link).toBeVisible();
    await shot(page, 'reports');
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    const path = await download.path();
    expect(readFileSync(path, 'utf8')).toContain('flatmap-stream');
  });

  test('Integrations', async ({ page }) => {
    await page.goto('/integrations');
    await expect(page.getByText(/github/i).first()).toBeVisible();
    await shot(page, 'integrations');
  });

  test('Settings shows the permission matrix', async ({ page }) => {
    await page.goto('/settings');
    const matrix = page.getByRole('table').filter({ hasText: 'Org admin' }).first();
    await expect(matrix).toBeVisible();
    await expect(matrix).toContainText('Auditor');
    await shot(page, 'settings');
    await page.goto('/settings?tab=project');
    await expect(page.getByText('payments-platform').first()).toBeVisible();
    await shot(page, 'settings-project');
    await page.goto('/settings?tab=audit');
    await expect(page.getByRole('heading', { name: /audit/i }).first()).toBeVisible();
    await shot(page, 'settings-audit');
  });
});
