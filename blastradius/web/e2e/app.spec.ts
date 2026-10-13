import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { devProject, login, navLabels, shot, watchConsole, type DevRole } from './helpers';

// One-level sidebar (docs/UX.md §2), Reports and Settings at the bottom.
const MAIN = ['Overview', 'Findings', 'Incidents', 'Projects', 'Alerts'];

// Default roles (docs/UX.md §9): every role reads every page but Settings; Settings opens
// Members (admin) or Sources (AppSec, Developer); the Auditor has no Settings at all.
const EXPECTED_NAV: Record<DevRole, string[]> = {
  admin: [...MAIN, 'Reports', 'Settings'],
  appsec: [...MAIN, 'Reports', 'Settings'],
  developer: [...MAIN, 'Reports', 'Settings'],
  auditor: [...MAIN, 'Reports'],
};

test.describe('navigation per default role', () => {
  for (const role of Object.keys(EXPECTED_NAV) as DevRole[]) {
    test(`${role} sees the pages docs/UX.md §9 grants`, async ({ page }) => {
      await login(page, role);
      // The signed-out /api/me 401 before login is expected; watch from here on.
      const errors = watchConsole(page);
      await page.reload();
      await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Findings' })).toBeVisible();
      const labels = await navLabels(page);
      expect(labels).toEqual(EXPECTED_NAV[role]);
      for (const gone of ['Home', 'Incident KB', 'Integrations', 'Exposure matrix']) expect(labels, `${role} nav lacks ${gone}`).not.toContain(gone);
      await expect(page.getByText(/coming soon/i)).toHaveCount(0);
      if (role === 'auditor') {
        await shot(page, 'auditor-nav');
        await page.goto('/reports');
        await expect(page.getByRole('link', { name: /^Download HTML report for payments-platform/ }).first()).toBeVisible();
        await shot(page, 'auditor-reports');
      }
      expect(errors()).toEqual([]);
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
  await shot(page, 'accept-invite');
  await page.getByRole('button', { name: 'Accept invite' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid, expired or already used');
});

test('the auditor reads findings but the server refuses changes and settings', async ({ page }) => {
  await login(page, 'admin');
  const project = await devProject(page);
  await page.request.post('/api/auth/logout', { headers: { 'X-Requested-With': 'blastradius' } });
  await login(page, 'auditor');
  const res = await page.request.get(`/api/findings?project=${encodeURIComponent(project)}`);
  expect(res.status()).toBe(200);
  const first = ((await res.json()) as { items: { id: string }[] }).items[0]!;
  const patch = await page.request.patch(`/api/findings/${first.id}`, { data: { status: 'reviewed' }, headers: { 'X-Requested-With': 'blastradius' } });
  expect(patch.status()).toBe(403);
  expect((await page.request.get('/api/roles')).status()).toBe(403);
  expect((await page.request.get('/api/reports')).status()).toBe(200);
  // The status control stays visible, disabled, and says why.
  await page.goto(`/projects/${project}/findings`);
  await page.getByRole('table', { name: 'Findings' }).getByText('flatmap-stream@0.1.1', { exact: true }).click();
  const form = page.getByRole('dialog').getByRole('form', { name: 'Finding status' });
  await expect(form.getByRole('combobox', { name: 'Status' })).toBeDisabled();
  await expect(form).toContainText('Needs the Triage permission: ask an admin.');
  await shot(page, 'auditor-status-disabled');
});

test('the developer triages findings in the project they are bound to', async ({ page }) => {
  await login(page, 'admin');
  const project = await devProject(page);
  await page.request.post('/api/auth/logout', { headers: { 'X-Requested-With': 'blastradius' } });
  await login(page, 'developer');
  await page.goto(`/projects/${project}/findings`);
  await page.getByRole('table', { name: 'Findings' }).getByText('flatmap-stream@0.1.1', { exact: true }).click();
  const form = page.getByRole('dialog').getByRole('form', { name: 'Finding status' });
  await expect(form.getByRole('combobox', { name: 'Status' })).toBeEnabled();
  // Accepting risk is not theirs: the option is disabled and the reason is shown.
  await expect(form).toContainText('Needs the Accept risk permission: ask an admin.');
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

  test('Overview: tiles open pre-filtered Findings; top packages and the projects table are one click away', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    const tiles = page.getByRole('region', { name: 'Needs attention' }).getByRole('link');
    await expect(tiles).toHaveCount(4);
    await expect(tiles.first()).toContainText('Critical open');
    await expect(page.getByRole('table', { name: 'Open findings by severity' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Packages in the most projects' }).getByRole('link').first()).toBeVisible();
    await shot(page, 'org-home');
    await tiles.first().click();
    await expect(page).toHaveURL(/\/findings\?severity=critical&status=new%2Creviewed%2Cfixing/);
    await expect(page.getByRole('list', { name: 'Applied filters' })).toContainText('Severity: Critical');
    await expect(page.getByRole('table', { name: 'Findings' }).getByText('event-stream@3.3.6', { exact: true })).toBeVisible();
    await page.goBack();
    await page.getByRole('link', { name: /All projects/ }).click();
    await expect(page.getByRole('cell', { name: /payments-platform/ }).first()).toBeVisible();
  });

  test('sidebar pages are real pages, and breadcrumbs are links', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    await page.goto('/');
    await nav.getByRole('link', { name: 'Projects' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
    await page.getByRole('table', { name: 'Projects' }).getByRole('cell', { name: /payments-platform/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/findings`));
    const sub = page.getByRole('navigation', { name: 'Project' });
    await sub.getByRole('link', { name: 'Scans' }).click();
    await expect(page.getByRole('heading', { name: 'Scans', level: 1 })).toBeVisible();
    const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
    await expect(crumbs.getByRole('link')).toHaveCount(3);
    await crumbs.getByRole('link', { name: 'payments-platform' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/findings`));
    await nav.getByRole('link', { name: 'Findings' }).click();
    await expect(page).toHaveURL(/\/findings$/);
    await expect(page.getByRole('heading', { name: 'Findings', level: 1 })).toBeVisible();
    for (const [link, heading] of [['Incidents', 'Incidents'], ['Alerts', 'Alerts'], ['Reports', 'Reports'], ['Settings', 'Settings']] as const) {
      await nav.getByRole('link', { name: link }).click();
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    }
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Sources' }).click();
    await expect(page).toHaveURL(/\/integrations$/);
    await shot(page, 'settings-sources');
  });

  test('⌘K answers "is it here?" for name@version and opens the package page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox', { name: 'Search packages, projects, people, settings' });
    await expect(box).toBeFocused();
    await box.fill('event-stream@3.3.6');
    const verdict = page.getByTestId('cmdk-verdict');
    await expect(verdict).toContainText(/Yes, it is here: 1 project, \d in production/);
    await expect(verdict).toHaveAttribute('aria-selected', 'true');
    await shot(page, 'cmdk-verdict');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/packages\?name=event-stream&version=3\.3\.6/);
    await expect(page.getByRole('heading', { name: 'event-stream@3.3.6', level: 1 })).toBeVisible();
    await expect(page.getByRole('group', { name: /event-stream@3\.3\.6 reaches 1 project/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^payments-platform \(production\)/ }).first()).toBeVisible();
    await shot(page, 'package');
    // A package nobody uses is a clear "not found".
    await page.keyboard.press('Control+k');
    await box.fill('left-pad 1.3.0');
    await expect(page.getByTestId('cmdk-verdict')).toContainText(/Not found in (any of \d+ projects|the 1 project searched)/);
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
    // The sidebar button opens the same palette, with settings and actions.
    await page.getByRole('button', { name: /Search or jump to/ }).click();
    await box.fill('sources');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/integrations$/);
  });

  test('dev "view as" lives in the top bar, not the user menu', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-user').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menu').getByText(/view as/i)).toHaveCount(0);
    await page.keyboard.press('Escape');
    const viewAs = async (email: RegExp) => {
      await expect(async () => {
        await page.getByTestId('dev-view-as').click();
        await expect(page.getByRole('menuitemradio', { name: email })).toBeVisible({ timeout: 1_000 });
      }).toPass();
      await page.getByRole('menuitemradio', { name: email }).click();
    };
    await viewAs(/appsec@local/);
    await expect(page.getByTestId('nav-role')).toContainText('AppSec');
    await viewAs(/admin@local/);
    await expect(page.getByTestId('nav-role')).toContainText('Org admin');
  });

  test('Findings: org-wide list, peek sheet, full page and Back to the same view', async ({ page }) => {
    await page.goto('/findings?group=project');
    const table = page.getByRole('table', { name: 'Findings' });
    for (const name of ['event-stream@3.3.6', 'flatmap-stream@0.1.1']) {
      const row = table.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Critical');
      await expect(row).toContainText('payments-platform');
    }
    const headers = (await table.getByRole('columnheader').allInnerTexts()).map((h) => h.trim()).filter(Boolean);
    expect(headers).toEqual(['Severity', 'Package', 'Projects', 'Introduced by', 'First seen', 'Status', 'Owner']);
    await shot(page, 'findings');
    // flatmap-stream comes in through event-stream.
    await expect(table.getByRole('row').filter({ has: page.getByText('flatmap-stream@0.1.1', { exact: true }) })).toContainText('event-stream');
    await table.getByText('flatmap-stream@0.1.1', { exact: true }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('flatmap-stream@0.1.1');
    await expect(page).toHaveURL(/[?&]peek=/);
    await shot(page, 'findings-peek');
    // K and J move to the previous and next row (replacing the history entry).
    // The fixture has two findings: flatmap-stream and event-stream.
    const order = await table.locator('tbody tr').allInnerTexts();
    const at = order.findIndex((t) => t.includes('flatmap-stream@0.1.1'));
    const [away, back] = at === 0 ? ['j', 'k'] : ['k', 'j'];
    await page.keyboard.press(away);
    await expect(sheet).toContainText('event-stream@3.3.6');
    await page.keyboard.press(back);
    await expect(sheet).toContainText('flatmap-stream@0.1.1');
    await sheet.getByRole('link', { name: 'Open full page' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/findings/`));
    await expect(page.getByRole('heading', { name: 'flatmap-stream@0.1.1', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Finding status' })).toBeVisible();
    for (const h of ['Where it reaches', 'What to do', "Who's behind it", 'Evidence', 'Timeline']) await expect(page.getByRole('region', { name: h })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('Affected');
    await shot(page, 'finding');
    await page.goBack();
    await expect(page).toHaveURL(/\/findings\?group=project&peek=/);
    await expect(page.getByRole('dialog')).toContainText('flatmap-stream@0.1.1');
  });

  test('Findings: bulk triage, owner and accepted risk with a reason and expiry', async ({ page }) => {
    await page.goto(`/projects/${project}/findings?sort=score`);
    const table = page.getByRole('table', { name: 'Findings' });
    await expect(table.locator('tbody tr').first()).toBeVisible();
    const first = table.locator('tbody tr').first();
    const pkg = (await first.locator('td').nth(2).locator('span').first().innerText()).trim();
    await first.getByRole('checkbox').click();
    const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
    await expect(bar).toContainText('1 selected');
    await expect(bar.getByRole('button', { name: /Create ticket/ })).toBeDisabled();
    await bar.getByRole('button', { name: /Set status/ }).click();
    await page.getByRole('menuitem', { name: 'Fixing' }).click();
    await expect(bar).toContainText('1 set to Fixing');
    await expect(table.getByRole('row').filter({ hasText: pkg })).toContainText('Fixing');
    await bar.getByRole('button', { name: /Assign/ }).click();
    await page.getByRole('menuitem', { name: 'Dev AppSec' }).click();
    await expect(table.getByRole('row').filter({ hasText: pkg })).toContainText('Dev AppSec');
    await bar.getByRole('button', { name: 'Accept risk…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason *').fill('Only in a sandboxed build step');
    await dialog.getByLabel('Expires on *').fill('2999-01-31');
    await dialog.getByRole('button', { name: 'Accept risk' }).click();
    await expect(table.getByRole('row').filter({ hasText: pkg })).toContainText('Accepted risk');
    // Put it back for later tests (the row is still selected).
    await expect(bar).toContainText('1 selected');
    await bar.getByRole('button', { name: /Set status/ }).click();
    await page.getByRole('menuitem', { name: 'Open' }).click();
    await expect(table.getByRole('row').filter({ hasText: pkg })).toContainText('Open');
  });

  test('Exposure matrix', async ({ page }) => {
    // The project matrix is the org-wide one, scoped to that project.
    await page.goto(`/projects/${project}/exposure`);
    await expect(page).toHaveURL(new RegExp(`/exposure\\?projects=${project}`));
    await expect(page.getByRole('heading', { name: 'Exposure', level: 1 })).toBeVisible();
    const heat = page.getByRole('table', { name: /Exposure heatmap/ });
    await expect(heat.getByRole('link', { name: /^event-stream@3\.3\.6$/ })).toBeVisible();
    await shot(page, 'exposure');
    await page.goto('/exposure');
    await expect(heat.getByRole('rowheader', { name: /payments-platform/ })).toBeVisible();
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
    await expect(canvas).toHaveAttribute('data-graph-ready', 'true');
    await expect(canvas).toHaveAttribute('data-node-count', String(body.nodes.length));
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
    // One radio item per organization, named by the org; the current one is checked.
    const current = menu.getByRole('menuitemradio', { checked: true });
    await expect(current).toHaveCount(1);
    await expect(current).toBeVisible();
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
    await expect(page.getByRole('region', { name: 'Needs attention' })).toBeVisible();
    await shot(page, 'dark-org-home');
    // The choice survives a reload.
    await page.goto(`/projects/${project}/findings`);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(page.getByText('flatmap-stream@0.1.1', { exact: true }).first()).toBeVisible();
    await shot(page, 'dark-findings');
    await page.goto(`/projects/${project}/investigate?node=${encodeURIComponent('pkg:npm/event-stream@3.3.6')}`);
    const darkGraph = page.getByRole('img', { name: /graph/i }).first();
    await expect(darkGraph).toHaveAttribute('data-graph-ready', 'true');
    await expect(darkGraph).not.toHaveAttribute('data-node-count', '0');
    await shot(page, 'dark-investigate');
    // Back to light so later tests in this browser context start from the default.
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
  });
});
