/**
 * Findings at scale and the finding detail page, on the real project with the most findings:
 * time to first row and to interactive (fail > 3 s), scroll smoothness, filtering, sorting,
 * column visibility, side panel, keyboard navigation, the Blast column against the API, and the
 * finding page's tabs with a Cytoscape graph that has nodes at finite positions.
 */
import { expect, test, type Page } from '@playwright/test';
import { settle } from './lib/checks';
import { api, Check, getJson, probeGraph, rolePage, scannedProjects } from './lib/feature';
import type { HammerProject } from './lib/env';

const STRESS_ROWS = 5000;
const INTERACTIVE_MS = 3000;

interface Row {
  id: string;
  name: string;
  version: string;
  purl: string;
  level: string;
  score: number;
  blastScore: number;
  status: string;
  reach: { assets: number; prodAssets: number };
}

async function allFindings(projectId: string): Promise<Row[]> {
  const ctx = await api('admin');
  const out: Row[] = [];
  let cursor = '';
  for (;;) {
    const page = await getJson<{ items: Row[]; nextCursor: string | null }>(ctx, `/api/findings?project=${encodeURIComponent(projectId)}&limit=500&sort=-score${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  await ctx.dispose();
  return out;
}

const rowsLoc = (page: Page) => page.locator('[data-testid="datatable-scroll"] tbody tr[data-row-id]');

async function footerCount(page: Page): Promise<{ shown: number; of: number } | null> {
  const t = await page.getByTestId('datatable-count').first().innerText();
  const m = /Showing ([\d,]+) of ([\d,]+)/.exec(t);
  return m ? { shown: Number(m[1]!.replace(/,/g, '')), of: Number(m[2]!.replace(/,/g, '')) } : null;
}

function largest(): HammerProject {
  const p = scannedProjects()[0];
  if (!p) throw new Error('No project with a succeeded scan on the server');
  return p;
}

test.describe('findings at scale', () => {
  // Tagged @perf: the config runs it alone after everything else, so timings are not skewed by
  // other workers.
  test('time to first row, time to interactive, scroll smoothness @perf', async ({ browser }) => {
    const proj = largest();
    const c = new Check(`findings-perf ${proj.name}`, 'admin', 'light', undefined, 'perf');
    const { page, w, close } = await rolePage(browser, 'admin');
    const url = `/projects/${encodeURIComponent(proj.id)}/findings`;
    c.facts.project = proj.name;
    c.facts.rows = proj.findings;
    await c.step('load', async () => {
      // Warm the JS bundle once so the timing measures data + render, not first-visit download.
      await page.goto('/reports');
      await settle(page);
      const t0 = Date.now();
      await page.goto(url);
      await rowsLoc(page).first().waitFor({ state: 'visible', timeout: 30_000 });
      const firstRow = Date.now() - t0;
      // Interactive: the filter accepts input and the table re-renders for it.
      const filter = page.getByRole('searchbox').first();
      await filter.fill('zzzz-no-such-package');
      await expect(page.getByText('No rows match the filter').or(page.getByText('No findings match these filters'))).toBeVisible({ timeout: 30_000 });
      const interactive = Date.now() - t0;
      await filter.fill('');
      await rowsLoc(page).first().waitFor();
      c.facts.firstRowMs = firstRow;
      c.facts.interactiveMs = interactive;
      if (interactive > INTERACTIVE_MS) c.fail(`time to interactive ${interactive} ms > ${INTERACTIVE_MS} ms (${proj.findings} rows)`);
    });
    await c.step('virtualised', async () => {
      const f = await footerCount(page);
      if (!f) throw new Error('no row count in the footer');
      if (f.of !== proj.findings) c.fail(`footer says ${f.of} findings, API says ${proj.findings}`);
      const rendered = await rowsLoc(page).count();
      c.facts.renderedRows = rendered;
      if (proj.findings > 200 && rendered >= proj.findings) c.fail(`all ${rendered} rows are in the DOM: the table is not virtualised`);
    });
    await c.step('scroll smoothness', async () => {
      const stats = await page.getByTestId('datatable-scroll').evaluate(async (el) => {
        // A fast but human scroll: 400 px per frame from top to bottom, one frame at a time.
        const frames: number[] = [];
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        el.scrollTop = 0;
        await frame();
        let last = performance.now();
        // scrollHeight grows as rows are measured, so stop only when truly at the bottom.
        for (let guard = 0; guard < 5000; guard++) {
          el.scrollTop = el.scrollTop + 400;
          await frame();
          const now = performance.now();
          frames.push(now - last);
          last = now;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) break;
        }
        for (let i = 0; i < 10; i++) {
          el.scrollTop = el.scrollHeight;
          await frame();
        }
        frames.sort((a, b) => a - b);
        const p95 = frames[Math.floor(frames.length * 0.95)] ?? 0;
        const long = frames.filter((f) => f > 50).length;
        const lastRow = Math.max(...Array.from(el.querySelectorAll<HTMLElement>('tr[data-index]')).map((r) => Number(r.dataset.index)));
        return { p95, long, frames: frames.length, lastRow };
      });
      c.facts.scrollP95Ms = Math.round(stats.p95);
      c.facts.longFrames = stats.long;
      if (stats.p95 > 50) c.fail(`scroll p95 frame ${Math.round(stats.p95)} ms > 50 ms`);
      if (stats.long > stats.frames * 0.1) c.fail(`${stats.long}/${stats.frames} scroll frames longer than 50 ms`);
      if (stats.lastRow !== proj.findings - 1) c.fail(`after scrolling to the bottom the last rendered row is #${stats.lastRow}, expected #${proj.findings - 1}`);
    });
    await c.snap(page);
    if (proj.findings < STRESS_ROWS) c.blocked.push(`data: the largest real project (${proj.name}) has ${proj.findings} findings, fewer than ${STRESS_ROWS}; the 5k-row target is unverified`);
    await close();
    c.done(w);
  });

  test('filtering, sorting, columns, side panel, keyboard', async ({ browser }) => {
    const proj = largest();
    const rows = await allFindings(proj.id);
    const c = new Check(`findings-table ${proj.name}`, 'admin');
    const { page, w, close } = await rolePage(browser, 'admin');
    const url = `/projects/${encodeURIComponent(proj.id)}/findings`;
    await page.goto(url);
    await settle(page);
    const table = page.getByRole('table', { name: 'Findings' });

    await c.step('text filter', async () => {
      const target = rows[0]!;
      await page.getByRole('searchbox').first().fill(target.purl);
      await expect(page).toHaveURL(/[?&]q=/);
      const want = rows.filter((r) => [r.purl, r.name, r.version].some((s) => s.toLowerCase().includes(target.purl.toLowerCase()))).length;
      const f = await footerCount(page);
      if (!f || f.shown < 1) c.fail(`filtering by ${target.purl} shows no rows`);
      else if (f.shown > Math.max(want, 1) + 2) c.fail(`filtering by ${target.purl} shows ${f.shown} rows`);
      await expect(rowsLoc(page).first()).toContainText(target.name);
      await page.getByRole('searchbox').first().fill('');
    });

    await c.step('level facet', async () => {
      const crit = rows.filter((r) => r.level === 'critical').length;
      await page.getByRole('button', { name: /^Filter by level/ }).click();
      await page.getByRole('option', { name: /Critical/ }).click();
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/[?&]level=critical/);
      const f = await footerCount(page);
      if (!f) throw new Error('no footer count');
      if (f.shown !== crit) c.fail(`Critical filter shows ${f.shown} rows, API has ${crit} critical findings`);
      const levels = await rowsLoc(page).locator('td:first-child').allInnerTexts();
      const off = levels.filter((t) => !/critical/i.test(t));
      if (off.length) c.fail(`Critical filter still shows ${off.length} non-critical rows`);
      await c.snap(page, 'critical');
      await page.getByRole('button', { name: /^Filter by level/ }).click();
      await page.getByRole('option', { name: /Critical/ }).click();
      await page.keyboard.press('Escape');
      await expect(page).not.toHaveURL(/[?&]level=/);
    });

    await c.step('status filter', async () => {
      const fresh = rows.filter((r) => r.status === 'new').length;
      await page.getByRole('combobox', { name: 'Filter by status' }).click();
      await page.getByRole('option', { name: 'New', exact: true }).click();
      await expect(page).toHaveURL(/[?&]status=new/);
      const f = await footerCount(page);
      if (f && f.shown !== fresh) c.fail(`status New shows ${f.shown} rows, API has ${fresh}`);
      await page.getByRole('combobox', { name: 'Filter by status' }).click();
      await page.getByRole('option', { name: 'All statuses' }).click();
    });

    await c.step('sorting', async () => {
      const risk = table.getByRole('columnheader', { name: /Risk/ });
      await expect(risk).toHaveAttribute('aria-sort', 'descending');
      const firstScores = async () => (await rowsLoc(page).locator('td:nth-child(2)').allInnerTexts()).slice(0, 15).map((s) => Number(s.trim()));
      const desc = await firstScores();
      if (desc.some((v, i) => i > 0 && v > desc[i - 1]!)) c.fail(`Risk descending is not sorted: ${desc.join(',')}`);
      await risk.getByRole('button').click();
      await expect(risk).toHaveAttribute('aria-sort', 'ascending');
      const asc = await firstScores();
      if (asc.some((v, i) => i > 0 && v < asc[i - 1]!)) c.fail(`Risk ascending is not sorted: ${asc.join(',')}`);
      const minScore = Math.min(...rows.map((r) => Math.round(r.score)));
      if (asc[0] !== minScore) c.fail(`lowest risk shown first is ${asc[0]}, API minimum is ${minScore}`);
      const comp = table.getByRole('columnheader', { name: /Component/ });
      await comp.getByRole('button').click();
      const names = (await rowsLoc(page).locator('td:nth-child(5) span.font-mono').allInnerTexts()).slice(0, 20);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      if (names.join('|') !== sorted.join('|') && names.join('|') !== [...sorted].reverse().join('|')) c.fail(`Component sort is not alphabetical: ${names.slice(0, 6).join(', ')}`);
      // Back to the default.
      await page.goto(url);
      await settle(page);
    });

    await c.step('blast column matches the API', async () => {
      const shown = (await rowsLoc(page).locator('td:nth-child(3)').allInnerTexts()).slice(0, 10).map((s) => s.trim());
      const api10 = rows.slice(0, 10);
      const zeroed = api10.filter((r, i) => r.blastScore > 0 && shown[i] === '0');
      if (zeroed.length) c.fail(`Blast column shows "0" for ${zeroed.length}/10 top rows whose API blastScore is > 0 (e.g. ${zeroed[0]!.name} blastScore ${zeroed[0]!.blastScore}): values are rounded to integers`);
    });

    await c.step('column visibility', async () => {
      await page.getByRole('button', { name: 'Columns' }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Version' }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Purl' }).click();
      await page.keyboard.press('Escape');
      await expect(table.getByRole('columnheader', { name: 'Version' })).toHaveCount(0);
      await expect(table.getByRole('columnheader', { name: /Purl/ })).toHaveCount(1);
      await c.snap(page, 'columns');
      await page.getByRole('button', { name: 'Columns' }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Version' }).click();
      await page.getByRole('menuitemcheckbox', { name: 'Purl' }).click();
      await page.keyboard.press('Escape');
      await expect(table.getByRole('columnheader', { name: /Version/ })).toHaveCount(1);
    });

    await c.step('side panel', async () => {
      const top = rows[0]!;
      await rowsLoc(page).first().click();
      const panel = page.getByRole('complementary', { name: 'Finding details' });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(`${top.name}@${top.version}`);
      await expect(page).toHaveURL(new RegExp(`[?&]f=${encodeURIComponent(top.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      for (const s of [/Why it scored/, 'Paths to assets', "Who's behind it", 'Evidence']) await expect(panel.getByText(s).first()).toBeVisible();
      await c.snap(page, 'panel');
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(page).not.toHaveURL(/[?&]f=/);
      const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.rowId ?? null);
      if (focused !== top.id) c.fail(`closing the panel did not return focus to its row (focus on ${focused})`);
    });

    await c.step('keyboard navigation', async () => {
      await rowsLoc(page).first().focus();
      const idx = async () => page.evaluate(() => Number((document.activeElement as HTMLElement | null)?.dataset.index ?? -1));
      // One key per frame at most, like a held key; focus moves on the next animation frame.
      for (let i = 1; i <= 3; i++) {
        await page.keyboard.press('ArrowDown');
        await expect.poll(idx, { timeout: 2_000 }).toBe(i);
      }
      await page.keyboard.press('End');
      await expect.poll(idx, { timeout: 5_000 }).toBe(rows.length - 1);
      await page.keyboard.press('Home');
      await expect.poll(idx, { timeout: 5_000 }).toBe(0);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('complementary', { name: 'Finding details' })).toBeVisible();
      await page.keyboard.press('Escape');
    });
    await close();
    c.done(w);
  });
});

test('finding detail: tabs and the scoped graph', async ({ browser }) => {
  // The highest-risk finding on the server (a real incident, if the scenarios found one).
  const projects = scannedProjects().filter((p) => p.topFindingId);
  const proj = [...projects].sort((a, b) => b.critical - a.critical)[0];
  if (!proj) throw new Error('No scanned project with findings');
  const c = new Check(`finding-detail ${proj.name}`, 'admin');
  const { page, w, close } = await rolePage(browser, 'admin');
  const ctx = await api('admin');
  const detail = await getJson<{ id: string; name: string; version: string; reasons: unknown[]; assets: unknown[]; level: string; score: number }>(ctx, `/api/findings/${encodeURIComponent(proj.topFindingId!)}`);
  const graph = await getJson<{ nodes: { id: string }[]; edges: unknown[]; centre: string }>(ctx, `/api/graph?finding=${encodeURIComponent(proj.topFindingId!)}`);
  await ctx.dispose();
  await page.goto(`/projects/${encodeURIComponent(proj.id)}/findings/${encodeURIComponent(proj.topFindingId!)}`);
  await settle(page);
  await c.step('summary', async () => {
    await expect(page.locator('h1')).toHaveText(`${detail.name}@${detail.version}`);
    for (const s of [/Why it scored \d+/, "Who's behind it", 'Evidence', 'History', 'Affected assets']) await expect(page.getByText(s).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: `Paths (${detail.assets.length})` })).toHaveAttribute('aria-selected', 'true');
  });
  await c.snap(page, 'paths');
  await c.step('graph tab', async () => {
    await page.getByRole('tab', { name: 'Graph' }).click();
    const sel = '[role=img][aria-label="Graph scoped to this finding"]';
    await page.locator(sel).waitFor({ state: 'visible' });
    await page.waitForTimeout(600);
    const g = await probeGraph(page, sel);
    if (!g) throw new Error('no Cytoscape instance in the finding graph');
    c.facts.nodes = g.nodes;
    c.facts.edges = g.edges;
    if (g.nodes !== graph.nodes.length) c.fail(`graph draws ${g.nodes} nodes, API returned ${graph.nodes.length}`);
    if (g.nodes < 2) c.fail(`graph has only ${g.nodes} node(s)`);
    if (g.badPositions.length) c.fail(`${g.badPositions.length} node(s) at NaN/Infinity positions: ${g.badPositions.slice(0, 3).join(', ')}`);
    const outside = g.rendered.filter((n) => n.x < -5 || n.y < -5 || n.x > g.width + 5 || n.y > g.height + 5);
    if (outside.length) c.fail(`${outside.length} node(s) drawn outside the visible canvas`);
    if (g.inked < 0.002) c.fail(`the graph canvas is blank (${(g.inked * 100).toFixed(2)}% inked)`);
    if (g.labelOverlaps.length) c.fail(`${g.labelOverlaps.length} pair(s) of node labels overlap, e.g. ${g.labelOverlaps.slice(0, 2).join('; ')}`);
    if (g.encodedLabels.length) c.fail(`node labels show URL escapes: ${g.encodedLabels.slice(0, 3).join(', ')}`);
  });
  await c.snap(page, 'graph');
  await c.step('open in graph', async () => {
    await page.getByRole('link', { name: 'Open in graph' }).click();
    await expect(page).toHaveURL(/\/investigate\?finding=/);
  });
  await close();
  c.done(w);
});
