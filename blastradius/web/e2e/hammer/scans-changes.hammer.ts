/**
 * Scans and Changes, end to end on a real repository: telefonicaid/logops, whose tag 2.1.1
 * locks colors 1.3.3 and whose HEAD (tag 2.1.2, commit 5310b75, 2022-01-10) locks the sabotaged
 * colors 1.4.2 (KB INC-2022-0001).
 *
 *  1. "New project" dialog creates the project with a github.com target;
 *  2. the first scan is queued at ref 2.1.1 through the API (the UI has no ref picker), and the
 *     Scans page must poll it to Succeeded without a reload;
 *  3. "Run scan" (confirm dialog) scans HEAD, again polled to Succeeded;
 *  4. Changes must show colors@1.4.2 as a new critical finding, with tab counts equal to the API.
 * The project is deleted afterwards. Needs github.com (the server clones it, shallow, no hooks).
 */
import { expect, test } from '@playwright/test';
import { settle } from './lib/checks';
import { readState, SERVER_AS_OF } from './lib/env';
import { api, Check, getJson, rolePage } from './lib/feature';

const REPO = 'https://github.com/telefonicaid/logops';
const OLD_REF = '2.1.1';
const HEAD_COMMIT = '5310b7516caf';
const SCAN_TIMEOUT = 8 * 60_000;

test('scans run and poll, then changes after a rescan (logops colors 1.3.3 -> 1.4.2)', async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  // A replay server pins every scan to its reference date; this flow is about today's HEAD.
  test.skip(SERVER_AS_OF !== null && SERVER_AS_OF !== 'now', `server is a replay as of ${SERVER_AS_OF}`);
  const state = readState();
  const c = new Check('scans + changes (logops)', 'admin');
  if (!state.sources['github.com']) {
    c.blocked.push('github.com');
    c.done();
    return;
  }
  const ctx = await api('admin');
  const { page, w, close } = await rolePage(browser, 'admin');
  const anyProject = state.projects[0];
  const name = `hammer-logops-${state.runId}`;
  let projectId = '';

  await c.step('create project in the New project dialog', async () => {
    await page.goto(anyProject ? `/projects/${encodeURIComponent(anyProject.id)}/scans` : '/');
    await settle(page);
    await page.getByRole('button', { name: 'New project' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'New project' });
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Name').fill(name);
    await dlg.getByLabel('Target').fill(REPO);
    await dlg.getByRole('combobox', { name: 'Size tier' }).click();
    await page.getByRole('option', { name: /^Small/ }).click();
    await c.snap(page, 'new-project');
    await dlg.getByRole('button', { name: 'Create project' }).click();
    await expect(dlg).toBeHidden();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/scans$/);
    projectId = decodeURIComponent(/\/projects\/([^/]+)\/scans/.exec(page.url())![1]!);
    await settle(page);
    await expect(page.getByText('No scans yet')).toBeVisible();
  });
  if (!projectId) {
    await close();
    c.done(w);
    return;
  }
  const pid = encodeURIComponent(projectId);
  const rows = page.locator('tbody tr[data-row-id]');

  await c.step(`first scan at ${OLD_REF} polls to Succeeded`, async () => {
    const r = await ctx.post(`/api/projects/${pid}/scans`, { data: { ref: OLD_REF } });
    if (r.status() !== 202) throw new Error(`queue scan: HTTP ${r.status()} ${await r.text()}`);
    await page.reload();
    await expect(rows).toHaveCount(1);
    const t0 = Date.now();
    await expect(rows.first()).toContainText(/Succeeded|Failed/, { timeout: SCAN_TIMEOUT });
    c.facts.firstScanMs = Date.now() - t0;
    await expect(rows.first()).toContainText('Succeeded');
  });

  await c.step('Run scan button + confirm dialog, polled to Succeeded', async () => {
    await page.getByRole('button', { name: 'Run scan' }).click();
    const dlg = page.getByRole('alertdialog');
    await expect(dlg).toContainText(`Run a scan of ${name}?`);
    await c.snap(page, 'confirm');
    await dlg.getByRole('button', { name: 'Run scan' }).click();
    await expect(page.getByText('Scan queued')).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(page.getByRole('button', { name: /Scan in progress|Starting/ })).toBeVisible();
    const t0 = Date.now();
    await expect(rows.first()).toContainText(/Succeeded|Failed/, { timeout: SCAN_TIMEOUT });
    c.facts.rescanMs = Date.now() - t0;
    await expect(rows.first()).toContainText('Succeeded');
    await expect(page.getByRole('button', { name: 'Run scan' })).toBeEnabled();
    await c.snap(page, 'scans');
  });

  await c.step('scan side panel', async () => {
    await rows.first().click();
    const panel = page.getByRole('complementary', { name: 'Scan details' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(HEAD_COMMIT);
    await expect(panel.getByText('Summary')).toBeVisible();
    for (const f of ['HTML', 'JSON', 'SARIF']) await expect(panel.getByRole('link', { name: f })).toBeVisible();
    await c.snap(page, 'scan-panel');
    await page.keyboard.press('Escape');
  });

  await c.step('Changes shows colors@1.4.2 as new and critical', async () => {
    const ch = await getJson<{ fromScan: unknown; items: { type: string; purl: string; name?: string; version?: string; toLevel?: string }[]; counts: Record<string, number> }>(ctx, `/api/changes?project=${pid}`);
    c.facts.changes = ch.items.length;
    if (!ch.fromScan) c.fail('API changes has no fromScan after two scans');
    const colors = ch.items.find((i) => i.purl === 'pkg:npm/colors@1.4.2');
    if (!colors) c.fail('API changes has no entry for pkg:npm/colors@1.4.2');
    else if (colors.type !== 'new_finding') c.fail(`colors@1.4.2 change type is ${colors.type}, expected new_finding`);
    await page.goto(`/projects/${pid}/changes`);
    await settle(page);
    await expect(page.getByText('→').first()).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Change type' });
    for (const [t, label] of [['new_finding', 'New finding'], ['resolved', 'Resolved'], ['risk_up', 'Risk up'], ['risk_down', 'Risk down'], ['new_reason', 'New reason']] as const) {
      const tab = tabs.getByRole('tab', { name: new RegExp(`^${label}`) });
      const txt = (await tab.innerText()).replace(/\s+/g, ' ');
      const n = Number(/(\d[\d,]*)\s*$/.exec(txt)?.[1]?.replace(/,/g, '') ?? -1);
      if (n !== (ch.counts[t] ?? 0)) c.fail(`tab ${label} shows ${n}, API ${ch.counts[t] ?? 0}`);
    }
    const row = page.locator('tbody tr[data-row-id]').filter({ hasText: 'colors@1.4.2' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('New finding');
    await expect(row).toContainText(/critical/i);
    await c.snap(page, 'changes');
    await row.click();
    await expect(page.getByRole('complementary', { name: 'Change details' })).toBeVisible();
    await c.snap(page, 'change-panel');
    await page.keyboard.press('Escape');
  });

  await c.step('delete the project', async () => {
    const r = await ctx.delete(`/api/projects/${pid}`);
    if (!r.ok()) throw new Error(`DELETE project: HTTP ${r.status()}`);
  });
  await ctx.dispose();
  await close();
  c.done(w);
});
