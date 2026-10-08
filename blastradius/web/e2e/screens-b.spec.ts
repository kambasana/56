/**
 * Stage 2B screens on the seeded fixture (event-stream 3.3.6 → flatmap-stream in
 * payments-platform): an advisory becomes an incident, the incident page moves through its
 * status track, package reach and who's behind it render with their table views, Exposure cells
 * open findings, and an alert rule says what it would have sent.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { devProject, login, shot, watchConsole } from './helpers';

const ID = 'GHSA-mh6f-8j2x-4483';

test.describe('incidents and visual views', () => {
  let errors: () => string[] = () => [];

  test.beforeEach(async ({ page }) => {
    await login(page, 'admin');
    errors = watchConsole(page);
    await devProject(page);
    const advisory = JSON.parse(readFileSync(new URL(`../../test/replay/data/advisories/${ID}.json`, import.meta.url), 'utf8')) as unknown;
    expect((await page.request.post('/api/alerts/check', { data: { advisories: [advisory] }, headers: { 'X-Requested-With': 'blastradius' } })).status()).toBe(200);
  });

  test.afterEach(async () => {
    expect(errors(), 'console errors').toEqual([]);
  });

  test('an advisory becomes an incident: where it is, status and timeline', async ({ page }) => {
    await page.goto('/incidents');
    const table = page.getByRole('table', { name: 'Incidents' });
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText(/◆\s*Critical/);
    await shot(page, 'incidents');
    await table.getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/incidents/${ID}$`));
    const where = page.getByRole('table', { name: 'Where it is' });
    await expect(where.getByRole('row').nth(1)).toContainText('payments-platform');
    await expect(where).toContainText('event-stream@3.3.6');
    await expect(where.getByRole('link', { name: 'Open finding in payments-platform' }).first()).toBeVisible();
    // No knowledge pack and no webhook in the e2e server: both actions say why.
    await expect(page.getByRole('button', { name: 'Re-check all projects' })).toBeDisabled();
    await expect(page.getByText(/BLASTRADIUS_PACK/)).toBeVisible();
    await expect(page.getByText(/BLASTRADIUS_ALERT_WEBHOOK/)).toBeVisible();
    await page.getByRole('button', { name: /Set status/ }).click();
    await page.getByRole('menuitemradio', { name: 'Fixing' }).click();
    const track = page.getByRole('list', { name: 'Incident status' });
    await expect(track.locator('[aria-current="step"]')).toHaveText(/Fixing/);
    await expect(page.getByRole('list', { name: 'Timeline' })).toContainText('moved it to Fixing');
    await shot(page, 'incident');
    await page.reload();
    await expect(page.getByRole('list', { name: 'Incident status' }).locator('[aria-current="step"]')).toHaveText(/Fixing/);
    // Back to Investigating so the run can repeat.
    await page.getByRole('button', { name: /Set status/ }).click();
    await page.getByRole('menuitemradio', { name: 'Investigating' }).click();
    await expect(page.getByRole('list', { name: 'Incident status' }).locator('[aria-current="step"]')).toHaveText(/Investigating/);
    await page.getByRole('link', { name: 'How far it spreads' }).first().click();
    await expect(page).toHaveURL(/\/packages\?name=/);
  });

  test('package reach: Sankey, table, path tree and the selected path', async ({ page }) => {
    await page.goto('/packages?name=flatmap-stream&version=0.1.1');
    await expect(page.getByRole('heading', { name: 'flatmap-stream@0.1.1', level: 1 })).toBeVisible();
    await expect(page.getByRole('group', { name: /reaches 1 project/ })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Lifecycle' })).toContainText(ID);
    await expect(page.getByRole('link', { name: 'Open incident' })).toHaveAttribute('href', `/incidents/${ID}`);
    const row = page.getByRole('button', { name: /^payments-platform \(production\): .*event-stream@3\.3\.6 → flatmap-stream@0\.1\.1/ }).first();
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('list', { name: 'Selected path' })).toContainText('brought it in');
    await shot(page, 'package-reach');
    await page.getByRole('button', { name: 'Table' }).click();
    await expect(page).toHaveURL(/view=table/);
    await expect(page.getByRole('table', { name: 'Projects' })).toContainText('payments-platform');
    await page.goBack();
    await expect(page.getByRole('group', { name: /reaches 1 project/ })).toBeVisible();
  });

  test("who's behind it: one hop, sources, table", async ({ page }) => {
    await page.goto('/packages/behind?name=event-stream');
    await expect(page.getByText('Focused on event-stream')).toBeVisible();
    await expect(page.getByText('Public links with sources. Not a finding of wrongdoing.')).toBeVisible();
    const node = page.getByRole('button', { name: /npm · right9ctrl: maintains, High confidence/ });
    await node.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'npm · right9ctrl', level: 2 })).toBeVisible();
    await expect(page.getByRole('link', { name: /npmjs\.com\/package\/event-stream/ })).toBeVisible();
    await shot(page, 'behind');
    await page.getByRole('button', { name: 'Table' }).click();
    await expect(page.getByRole('table', { name: 'Links' })).toContainText('dominictarr');
  });

  test('exposure: a cell opens its finding, a column its reach', async ({ page }) => {
    await page.goto('/exposure');
    const heat = page.getByRole('table', { name: /Exposure heatmap/ });
    await expect(heat).toContainText('◆ C');
    await heat.getByRole('link', { name: /payments-platform · event-stream@3\.3\.6: Critical/ }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/findings\/[^/]+$/);
    await page.goBack();
    await page.getByRole('table', { name: /Exposure heatmap/ }).getByRole('link', { name: /^event-stream@3\.3\.6$/ }).click();
    await expect(page).toHaveURL(/\/packages\?name=event-stream&version=3\.3\.6/);
    await page.goto('/exposure?view=table');
    await expect(page.getByRole('table', { name: 'Exposure' })).toContainText('payments-platform');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    expect((await download).suggestedFilename()).toBe('blastradius-exposure.csv');
  });

  test('alerts: a rule says what it would have sent, and is saved', async ({ page }) => {
    await page.goto('/alerts');
    await expect(page.getByRole('table', { name: 'Alert rules' })).toBeVisible();
    await page.getByRole('button', { name: 'New rule' }).click();
    await expect(page.getByText(/Would have sent \d+ alerts? in the last 30 days/)).toBeVisible();
    await page.getByRole('radio', { name: /Low/ }).click();
    await expect(page.getByText(/Would have sent [1-9]\d* alerts? in the last 30 days/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send a test message' })).toBeDisabled();
    const name = `Any severity ${Date.now()}`;
    await page.getByRole('textbox', { name: /Name/ }).fill(name);
    await page.getByRole('textbox', { name: /Slack channel/ }).fill('#appsec-feed');
    await shot(page, 'alert-rule');
    await page.getByRole('button', { name: 'Save rule' }).click();
    const rule = page.getByRole('table', { name: 'Alert rules' }).getByRole('row', { name: new RegExp(name) });
    await expect(rule).toContainText('#appsec-feed');
    await expect(rule).toContainText(/[1-9]\d* alerts?/);
    // Clean up through the sheet.
    await rule.getByRole('button', { name }).click();
    await page.getByRole('button', { name: 'Delete rule' }).click();
    await expect(page.getByRole('table', { name: 'Alert rules' }).getByRole('row', { name: new RegExp(name) })).toHaveCount(0);
  });
});
