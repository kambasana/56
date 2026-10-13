/**
 * Reports: for the latest snapshot of every scanned project, download HTML (split button),
 * JSON and SARIF (dropdown) through the real UI and validate each file: HTML names the top
 * finding and is served with the strict CSP; JSON is schemaVersion 1 with as many findings as
 * the API; SARIF is 2.1.0 with one result per finding. The Auditor (Reports only) can download.
 * The SHA-256 shown must be the hash of the stored snapshot.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { settle } from './lib/checks';
import { DOWNLOADS_DIR, type Role } from './lib/env';
import { api, Check, getJson, rolePage, scannedProjects } from './lib/feature';

interface ReportRow {
  scanId: string;
  project: { id: string; name: string };
  counts: Record<string, number>;
  sha256: string;
}

async function download(page: Page, click: () => Promise<void>, name: string): Promise<string> {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), click()]);
  const path = join(DOWNLOADS_DIR, name);
  copyFileSync(await dl.path(), path);
  if (!dl.suggestedFilename().endsWith(name.slice(name.lastIndexOf('.')))) throw new Error(`download named ${dl.suggestedFilename()}, expected *${name.slice(name.lastIndexOf('.'))}`);
  return path;
}

for (const role of ['admin', 'auditor'] as Role[]) {
  test(`reports: download and validate HTML/JSON/SARIF (${role})`, async ({ browser }) => {
    const c = new Check('reports downloads', role);
    const ctx = await api(role);
    const admin = await api('admin');
    const list = await getJson<{ items: ReportRow[] }>(ctx, '/api/reports?limit=500');
    const { page, w, close } = await rolePage(browser, role);
    await page.goto('/reports');
    await settle(page);
    await c.snap(page);
    const projects = role === 'admin' ? scannedProjects() : scannedProjects().slice(0, 3);
    c.facts.snapshots = list.items.length;
    for (const p of projects) {
      const row = list.items.find((r) => r.project.id === p.id);
      if (!row) {
        c.fail(`${p.name}: no report row for its succeeded scan`);
        continue;
      }
      await c.step(p.name, async () => {
        const what = `${row.project.name} snapshot ${row.scanId}`;
        await page.getByRole('searchbox').first().fill(row.scanId);
        const htmlPath = await download(page, () => page.getByRole('link', { name: `Download HTML report for ${what}` }).click(), `${row.scanId}.html`);
        const html = readFileSync(htmlPath, 'utf8');
        if (!/<html[\s>]/i.test(html)) c.fail(`${p.name}: HTML report is not an HTML document`);
        if (p.topFindingPurl && !html.includes(p.topFindingPurl)) c.fail(`${p.name}: HTML report does not mention the top finding ${p.topFindingPurl}`);
        if (/<script/i.test(html)) c.fail(`${p.name}: HTML report contains a <script>`);

        await page.getByRole('button', { name: `More download formats for ${what}` }).click();
        const jsonPath = await download(page, () => page.getByRole('menuitem', { name: /JSON/ }).click(), `${row.scanId}.json`);
        const raw = readFileSync(jsonPath, 'utf8');
        const json = JSON.parse(raw) as { schemaVersion?: string; findings?: unknown[]; summary?: { findings: number } };
        if (json.schemaVersion !== '1') c.fail(`${p.name}: JSON schemaVersion ${json.schemaVersion}`);
        const total = Object.values(row.counts).reduce((a, b) => a + b, 0);
        if (json.findings?.length !== total) c.fail(`${p.name}: JSON has ${json.findings?.length} findings, report row counts ${total}`);
        if (json.summary && json.summary.findings !== json.findings?.length) c.fail(`${p.name}: JSON summary.findings ${json.summary.findings} != findings.length ${json.findings?.length}`);

        await page.getByRole('button', { name: `More download formats for ${what}` }).click();
        const sarifPath = await download(page, () => page.getByRole('menuitem', { name: /SARIF/ }).click(), `${row.scanId}.sarif`);
        const sarif = JSON.parse(readFileSync(sarifPath, 'utf8')) as { version?: string; $schema?: string; runs?: { tool?: { driver?: { name?: string; rules?: unknown[] } }; results?: { ruleId?: string; message?: { text?: string }; locations?: unknown[] }[] }[] };
        if (sarif.version !== '2.1.0') c.fail(`${p.name}: SARIF version ${sarif.version}`);
        const run = sarif.runs?.[0];
        if (!run?.tool?.driver?.name) c.fail(`${p.name}: SARIF has no tool.driver.name`);
        const results = run?.results ?? [];
        if (results.length === 0 && total > 0) c.fail(`${p.name}: SARIF has no results for ${total} findings`);
        if (results.some((r) => !r.ruleId || !r.message?.text)) c.fail(`${p.name}: SARIF results without ruleId or message`);

        // Headers and snapshot hash, straight from the server.
        const h = await ctx.get(`/api/reports/${row.scanId}.html`);
        if (!/attachment/.test(h.headers()['content-disposition'] ?? '')) c.fail(`${p.name}: HTML report is not served as an attachment`);
        if (!/default-src 'none'/.test(h.headers()['content-security-policy'] ?? '')) c.fail(`${p.name}: HTML report lacks the strict CSP`);
        const hash = createHash('sha256');
        const stored = await admin.get(`/api/reports/${row.scanId}.json`);
        hash.update(await stored.body());
        c.facts[`${p.name}.jsonDownloadHashEqualsShownSha256`] = hash.digest('hex') === row.sha256;
      });
    }
    await page.getByRole('searchbox').first().fill('');
    await ctx.dispose();
    await admin.dispose();
    await close();
    c.done(w);
  });
}

test('reports: project filter narrows the list', async ({ browser }) => {
  const c = new Check('reports project filter', 'admin');
  const p = scannedProjects()[0]!;
  const ctx = await api('admin');
  const list = await getJson<{ total: number }>(ctx, `/api/reports?project=${encodeURIComponent(p.id)}&limit=500`);
  await ctx.dispose();
  const { page, w, close } = await rolePage(browser, 'admin');
  await page.goto('/reports');
  await settle(page);
  await c.step('filter', async () => {
    await page.getByRole('combobox', { name: 'Project' }).click();
    await page.getByRole('option', { name: p.name, exact: true }).click();
    await expect(page).toHaveURL(/[?&]project=/);
    await settle(page);
    await expect(page.getByTestId('datatable-count')).toContainText(`of ${list.total}`);
    const names = await page.locator('tbody tr[data-row-id] td:first-child').allInnerTexts();
    if (names.some((n) => n.trim() !== p.name)) c.fail(`filtered list shows other projects: ${[...new Set(names)].join(', ')}`);
  });
  await c.snap(page);
  await close();
  c.done(w);
});
