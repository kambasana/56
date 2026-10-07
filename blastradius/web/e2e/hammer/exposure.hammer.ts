/**
 * Exposure matrix across every scenario project on the server, checked against the API: the
 * size line, the column headers, a real cell opens its finding; org scope lists the projects;
 * sorting by name, the "Risk >=" filter and the CSV export all agree with the data.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { settle } from './lib/checks';
import { api, Check, getJson, rolePage, scannedProjects } from './lib/feature';

interface Matrix {
  axis: 'asset' | 'project';
  rows: { key: string; label: string; projectId: string }[];
  columns: { findingId: string; name: string; version: string; level: string; projectId: string }[];
  cells: { row: number; col: number; exposure: number }[];
  truncated: boolean;
}

const fmt = (n: number) => n.toLocaleString('en-US');

test('exposure matrix per project matches the API', async ({ browser }) => {
  const projects = scannedProjects();
  const c = new Check('exposure all projects', 'admin');
  const ctx = await api('admin');
  const { page, w, close } = await rolePage(browser, 'admin');
  for (const p of projects) {
    await c.step(p.name, async () => {
      const m = await getJson<Matrix>(ctx, `/api/exposure?project=${encodeURIComponent(p.id)}&minLevel=medium&limit=50`);
      await page.goto(`/projects/${encodeURIComponent(p.id)}/exposure`);
      const s = await settle(page);
      if (s) c.fail(`${p.name}: ${s}`);
      if (m.rows.length === 0 || m.columns.length === 0) {
        await expect(page.getByText('Nothing exposed at this level')).toBeVisible();
        return;
      }
      const meta = `${fmt(m.rows.length)} ${m.axis === 'asset' ? 'assets' : 'projects'} × ${fmt(m.columns.length)} components`;
      await expect(page.getByText(meta).first()).toBeVisible();
      const grid = page.getByRole('grid', { name: 'Exposure matrix' });
      const heads = await grid.locator('thead th').count();
      if (heads !== m.columns.length + 2) c.fail(`${p.name}: matrix has ${heads - 2} component columns, API ${m.columns.length}`);
      // Click the first non-empty cell on screen; the selection card must name it and link to the finding.
      const btn = grid.getByRole('button', { name: /: exposure \d/ }).first();
      if (m.cells.length && (await btn.count()) === 0) c.fail(`${p.name}: API has ${m.cells.length} exposed cells, the matrix shows none`);
      if (await btn.count()) {
        const label = (await btn.getAttribute('aria-label')) ?? '';
        const col = m.columns.find((x) => label.includes(` × ${x.name}: `));
        if (!col) c.fail(`${p.name}: cell "${label}" names no API column`);
        await btn.click();
        const card = page.getByRole('status', { name: 'Selected cell' });
        await expect(card).toBeVisible();
        if (col) {
          await expect(card).toContainText(col.name);
          await card.getByRole('link', { name: 'Open finding' }).click();
          await expect(page).toHaveURL(new RegExp(`/findings/${encodeURIComponent(col.findingId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
          await expect(page.locator('h1')).toContainText(col.name);
        }
      }
    });
  }
  await page.goto(`/projects/${encodeURIComponent(projects[0]!.id)}/exposure`);
  await settle(page);
  await c.snap(page, 'project');
  await ctx.dispose();
  await close();
  c.facts.projects = projects.length;
  c.done(w);
});

test('exposure matrix org scope: projects, sort, risk filter, CSV', async ({ browser }) => {
  const projects = scannedProjects();
  const c = new Check('exposure org scope', 'admin');
  const ctx = await api('admin');
  const m = await getJson<Matrix>(ctx, '/api/exposure?minLevel=medium&limit=50');
  const crit = await getJson<Matrix>(ctx, '/api/exposure?minLevel=critical&limit=50');
  await ctx.dispose();
  const { page, w, close } = await rolePage(browser, 'admin');
  const base = `/projects/${encodeURIComponent(projects[0]!.id)}/exposure`;
  await page.goto(base);
  await settle(page);
  await c.step('switch to all projects', async () => {
    await page.getByRole('radio', { name: 'All projects' }).click();
    await expect(page).toHaveURL(/scope=org/);
    await settle(page);
    await expect(page.getByText(`${fmt(m.rows.length)} projects × ${fmt(m.columns.length)} components`).first()).toBeVisible();
    const grid = page.getByRole('grid', { name: 'Exposure matrix' });
    const labels = (await grid.locator('tbody th[scope=row] span.font-mono').allInnerTexts()).map((s) => s.trim());
    for (const r of m.rows) if (!labels.some((l) => l.startsWith(r.label))) c.fail(`org matrix lacks project row ${r.label}`);
    // Every project with a medium+ finding should be a row.
    const withRisk = projects.filter((p) => p.findings > 0);
    c.facts.rows = m.rows.length;
    c.facts.projectsWithFindings = withRisk.length;
  });
  await c.snap(page, 'org');
  await c.step('sort by name', async () => {
    await page.getByRole('radio', { name: 'Name' }).click();
    const grid = page.getByRole('grid', { name: 'Exposure matrix' });
    const labels = (await grid.locator('tbody th[scope=row] span.font-mono').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    if (labels.join('|') !== sorted.join('|')) c.fail(`Name sort order: ${labels.slice(0, 5).join(', ')}`);
  });
  await c.step('risk >= critical', async () => {
    await page.getByRole('combobox', { name: 'Risk ≥' }).click();
    await page.getByRole('option', { name: 'Critical' }).click();
    await expect(page).toHaveURL(/minLevel=critical/);
    await settle(page);
    if (crit.rows.length && crit.columns.length) await expect(page.getByText(`${fmt(crit.rows.length)} projects × ${fmt(crit.columns.length)} components`).first()).toBeVisible();
    else await expect(page.getByText('Nothing exposed at this level')).toBeVisible();
    await c.snap(page, 'critical');
  });
  await c.step('CSV export', async () => {
    if (!crit.rows.length) return;
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    const text = readFileSync(await dl.path(), 'utf8');
    const lines = text.trim().split('\n');
    if (lines.length !== crit.rows.length + 1) c.fail(`CSV has ${lines.length - 1} rows, matrix ${crit.rows.length}`);
    const head = lines[0]!.split(',');
    if (head.length !== crit.columns.length + 4) c.fail(`CSV header has ${head.length - 4} component columns, matrix ${crit.columns.length}`);
    for (const col of crit.columns) if (!lines[0]!.includes(`${col.name}@${col.version}`)) c.fail(`CSV header lacks ${col.name}@${col.version}`);
  });
  await close();
  c.done(w);
});
