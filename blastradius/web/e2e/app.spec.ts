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
        await page.goto('/reports');
        await expect(page.getByRole('link', { name: /^Download HTML report for payments-platform/ }).first()).toBeVisible();
        await shot(page, 'auditor-reports');
      } else {
        expect(errors()).toEqual([]);
      }
    });
  }
});

test('sign-in page renders without console errors', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await shot(page, 'login');
});

test('accept-invite page is public and rejects an unknown token', async ({ page }) => {
  await page.goto('/accept-invite#token=not-a-real-token');
  await expect(page.getByRole('heading', { name: 'Accept your invite' })).toBeVisible();
  await page.getByLabel('Password').fill('a-brand-new-password');
  await expect(page.getByRole('button', { name: 'Accept invite' })).toBeEnabled();
  await page.waitForTimeout(250);
  await shot(page, 'accept-invite');
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid, expired or already used');
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
    // The graph tab loads Cytoscape on demand and draws the finding-scoped graph.
    await page.getByRole('tab', { name: 'Graph' }).click();
    const graph = page.getByRole('img', { name: 'Graph scoped to this finding' });
    await expect(graph.locator('canvas').first()).toBeAttached();
    await page.waitForTimeout(300);
    await shot(page, 'finding-graph');
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

  test('Settings shows members, the permission matrix, bindings, project and audit tabs', async ({ page }) => {
    await page.goto('/settings');
    // Members is the default tab.
    await expect(page.getByRole('tab', { name: 'Members' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('table', { name: 'Members' })).toContainText('admin@local');
    await shot(page, 'settings-members');
    await page.getByRole('tab', { name: 'Roles' }).click();
    await expect(page).toHaveURL(/[?&]tab=roles/);
    const matrix = page.getByRole('table').filter({ hasText: 'Org admin' }).first();
    await expect(matrix).toBeVisible();
    await expect(matrix).toContainText('Auditor');
    await shot(page, 'settings');
    await page.goto('/settings?tab=bindings');
    await expect(page.getByRole('table', { name: 'Role bindings' })).toBeVisible();
    await shot(page, 'settings-bindings');
    await page.goto('/settings?tab=project');
    await expect(page.getByText('payments-platform').first()).toBeVisible();
    await shot(page, 'settings-project');
    await page.goto('/settings?tab=audit');
    await expect(page.getByRole('heading', { name: /audit/i }).first()).toBeVisible();
    await shot(page, 'settings-audit');
  });

  test('admin invites a member in dev mode; the member appears and can sign in', async ({ page }) => {
    const email = `invitee-${Date.now()}@local`;
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Invite member' }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite member' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('Name').fill('Invited Developer');
    await dialog.getByRole('combobox', { name: 'Role' }).click();
    await page.getByRole('option', { name: 'Developer', exact: true }).click();
    await shot(page, 'settings-invite');
    await dialog.getByRole('button', { name: 'Send invite' }).click();
    const done = page.getByRole('dialog', { name: 'Member invited' });
    await expect(done).toBeVisible();
    const otp = await done.getByRole('textbox', { name: 'One-time password' }).inputValue();
    expect(otp.length).toBeGreaterThanOrEqual(12);
    await shot(page, 'settings-invite-result');
    await done.getByRole('button', { name: 'Done' }).click();
    await expect(done).toBeHidden();
    await expect(page.getByRole('table', { name: 'Members' })).toContainText(email);
    // The one-time password works on the normal sign-in form.
    expect(errors(), 'console errors before sign-out').toEqual([]);
    await page.request.post('/api/auth/logout', { headers: { 'X-Requested-With': 'blastradius' } });
    await page.goto('/');
    await expect(page.locator('#email')).toBeVisible();
    // The signed-out /api/me 401 on the sign-in page is expected; drop it.
    errors().splice(0);
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(otp);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByTestId('nav-role')).toContainText('Developer');
  });

  test('org switcher is visible and lists the current organization', async ({ page }) => {
    await page.goto('/');
    const switcher = page.getByRole('button', { name: /^Organization: .+\. Switch organization$/ });
    await expect(switcher).toBeVisible();
    await expect(page.getByTestId('nav-org')).not.toBeEmpty();
    await switcher.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Organizations');
    await expect(menu.getByLabel('Current organization')).toBeVisible();
    await shot(page, 'org-switcher');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('dark mode toggle switches the theme and renders screens without console errors', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.keyboard.press('Escape');
    // The background really changed (theme tokens, not hard-coded colours).
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toMatch(/^rgb\(255, 255, 255\)$/);
    await expect(page.getByRole('cell', { name: /payments-platform/ }).first()).toBeVisible();
    await shot(page, 'dark-org-home');
    // The choice survives a reload.
    await page.goto(`/projects/${project}/findings`);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(page.getByText('flatmap-stream', { exact: true }).first()).toBeVisible();
    await shot(page, 'dark-findings');
    await page.goto(`/projects/${project}/investigate?node=${encodeURIComponent('pkg:npm/event-stream@3.3.6')}`);
    await expect(page.getByRole('img', { name: /graph/i }).first().locator('canvas').first()).toBeAttached();
    await page.waitForTimeout(500);
    await shot(page, 'dark-investigate');
    // Back to light so later tests in this browser context start from the default.
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
  });

  test('Findings "Top reason" column shows readable reason text', async ({ page }) => {
    await page.goto(`/projects/${project}/findings`);
    const table = page.getByRole('table').first();
    const row = table.getByRole('row').filter({ has: page.getByText('flatmap-stream', { exact: true }) });
    await expect(row).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /Top reason/ })).toBeVisible();
    const headers = await table.getByRole('columnheader').allInnerTexts();
    const idx = headers.findIndex((h) => /Top reason/.test(h));
    expect(idx, `Top reason header in ${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0);
    const cell = row.getByRole('cell').nth(idx);
    const text = (await cell.innerText()).trim();
    // A real sentence, not an ellipsis-crushed sliver.
    expect(text.length).toBeGreaterThan(20);
    expect(text).toMatch(/[a-z]{3,}\s+[a-z]{3,}/i);
    const box = await cell.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(300);
    // Clamped to at most two lines but at least one full line of text is visible.
    const span = cell.locator('span.line-clamp-2').first();
    const h = await span.evaluate((el) => ({ client: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight) || 20 }));
    expect(h.client).toBeGreaterThanOrEqual(h.line * 0.9);
    expect(h.client).toBeLessThanOrEqual(h.line * 2 + 2);
  });
});
