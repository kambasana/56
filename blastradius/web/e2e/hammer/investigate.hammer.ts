/**
 * Investigate on real scan data: search, pick, graph centred on the pick; fit, zoom in/out,
 * layout toggle (positions must change and stay finite), clicking a real node opens the node
 * sheet, "Centre graph here" re-centres; the Nodes, Where-it-appears and Links tabs agree with
 * the API. Runs in light and dark (the canvas re-reads theme colours).
 */
import { expect, test } from '@playwright/test';
import { settle } from './lib/checks';
import { api, Check, getJson, probeGraph, rolePage, scannedProjects } from './lib/feature';
import type { Theme } from './lib/env';

const GRAPH = '[role=img][aria-label^="Graph centred on"]';

for (const theme of ['light', 'dark'] as Theme[]) {
  test(`investigate graph interactions (${theme})`, async ({ browser }) => {
    // Prefer a project with a critical finding (a real incident) so the graph has entities.
    const proj = scannedProjects().sort((a, b) => b.critical - a.critical)[0];
    if (!proj?.topFindingPurl) throw new Error('No scanned project with findings');
    const c = new Check(`investigate ${proj.name}`, 'admin', theme);
    const { page, w, close } = await rolePage(browser, 'admin', theme);
    const pid = encodeURIComponent(proj.id);
    const name = proj.topFindingPurl.replace(/^pkg:npm\//, '').replace(/@[^@]*$/, '').replace(/%40/g, '@');
    const ctx = await api('admin');
    const search = await getJson<{ items: { kind: string; id: string; label: string }[] }>(ctx, `/api/investigate/search?project=${pid}&q=${encodeURIComponent(name)}`);

    await page.goto(`/projects/${pid}/investigate`);
    await settle(page);
    await c.step('search', async () => {
      await page.getByRole('searchbox').fill(name);
      await settle(page);
      const results = page.getByRole('complementary', { name: 'Results' }).getByRole('button');
      if (search.items.length === 0) c.fail(`API search for "${name}" returned nothing`);
      await expect(results.first()).toBeVisible();
      const n = await results.count();
      if (n < Math.min(search.items.length, 1)) c.fail(`UI lists ${n} results, API ${search.items.length}`);
      const comp = page.getByRole('group', { name: 'Packages' }).getByRole('button').first();
      await (await comp.count() ? comp : results.first()).click();
      await expect(page).toHaveURL(/[?&]node=/);
      await page.locator(GRAPH).waitFor({ state: 'visible' });
      await settle(page);
    });
    await c.snap(page, 'picked');

    const nodeId = new URL(page.url()).searchParams.get('node') ?? '';
    const graph = await getJson<{ nodes: { id: string; label: string }[]; edges: unknown[]; centre: string }>(ctx, `/api/graph?project=${pid}&node=${encodeURIComponent(nodeId)}`);
    const nodeInfo = await getJson<{ appearances: unknown[]; links: unknown[] }>(ctx, `/api/investigate/node?project=${pid}&id=${encodeURIComponent(nodeId)}`).catch(() => null);
    await ctx.dispose();
    c.facts.nodes = graph.nodes.length;

    await c.step('graph drawn', async () => {
      const g = await probeGraph(page, GRAPH);
      if (!g) throw new Error('no Cytoscape instance');
      if (g.nodes !== graph.nodes.length) c.fail(`graph draws ${g.nodes} nodes, API ${graph.nodes.length}`);
      if (g.badPositions.length) c.fail(`${g.badPositions.length} node(s) at NaN positions`);
      if (g.inked < 0.002) c.fail('graph canvas is blank');
      if (g.encodedLabels.length) c.fail(`node labels show URL escapes: ${g.encodedLabels.slice(0, 3).join(', ')}`);
    });

    await c.step('zoom in / out / fit', async () => {
      const z0 = (await probeGraph(page, GRAPH))!.zoom;
      await page.getByRole('button', { name: 'Zoom in' }).click();
      const z1 = (await probeGraph(page, GRAPH))!.zoom;
      if (!(z1 > z0 * 1.1) && z0 < 3.9) c.fail(`Zoom in: zoom ${z0.toFixed(3)} -> ${z1.toFixed(3)}`);
      await page.getByRole('button', { name: 'Zoom out' }).click();
      await page.getByRole('button', { name: 'Zoom out' }).click();
      const z2 = (await probeGraph(page, GRAPH))!.zoom;
      if (!(z2 < z1)) c.fail(`Zoom out: zoom ${z1.toFixed(3)} -> ${z2.toFixed(3)}`);
      await page.getByRole('button', { name: 'Fit to view' }).click();
      const g = (await probeGraph(page, GRAPH))!;
      const outside = g.rendered.filter((n) => n.x < 0 || n.y < 0 || n.x > g.width || n.y > g.height);
      if (outside.length) c.fail(`after Fit, ${outside.length}/${g.nodes} nodes are outside the canvas`);
    });

    await c.step('layout toggle', async () => {
      const before = (await probeGraph(page, GRAPH))!.rendered.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`).join(' ');
      for (const l of ['Force', 'Concentric', 'Layered']) {
        await page.getByRole('radio', { name: l }).click();
        await expect(page.getByRole('radio', { name: l })).toHaveAttribute('aria-checked', 'true');
        await page.waitForTimeout(400);
        const g = (await probeGraph(page, GRAPH))!;
        if (g.badPositions.length) c.fail(`${l} layout: ${g.badPositions.length} NaN positions`);
        if (g.nodes !== graph.nodes.length) c.fail(`${l} layout draws ${g.nodes} nodes`);
        if (g.labelOverlaps.length) c.fail(`${l} layout: ${g.labelOverlaps.length} pair(s) of node labels overlap, e.g. ${g.labelOverlaps.slice(0, 2).join('; ')}`);
        if (l === 'Force' && graph.nodes.length > 2 && g.rendered.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`).join(' ') === before) c.fail('Force layout did not move any node');
        await c.snap(page, `layout-${l}`);
      }
    });

    await c.step('click a node -> node sheet', async () => {
      const g = (await probeGraph(page, GRAPH))!;
      const box = (await page.locator(GRAPH).boundingBox())!;
      const target = g.rendered.find((n) => n.id !== graph.centre) ?? g.rendered[0]!;
      await page.mouse.click(box.x + target.x, box.y + target.y);
      const sheet = page.getByRole('complementary', { name: 'Node details' });
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(target.label.replace(/ \(\d+\)$/, ''));
      await c.snap(page, 'node-sheet');
      const centreBtn = sheet.getByRole('button', { name: 'Centre graph here' });
      if (await centreBtn.count()) {
        await centreBtn.click();
        await expect(page).toHaveURL(new RegExp(`node=${encodeURIComponent(target.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        await settle(page);
        const g2 = await probeGraph(page, GRAPH);
        if (!g2 || g2.nodes < 1) c.fail('re-centred graph is empty');
        await page.goBack();
        await settle(page);
      } else {
        await sheet.getByRole('button', { name: 'Close panel' }).click();
      }
    });

    await c.step('tabs', async () => {
      await page.getByRole('tab', { name: /^Nodes/ }).click();
      const nodesTable = page.getByRole('table', { name: 'Graph nodes' });
      await expect(nodesTable).toBeVisible();
      const count = await page.getByTestId('datatable-count').first().innerText();
      if (!count.includes(`of ${graph.nodes.length}`)) c.fail(`Nodes tab says "${count}", graph has ${graph.nodes.length}`);
      await c.snap(page, 'nodes');
      const appear = page.getByRole('tab', { name: /^Where it appears/ });
      if (nodeInfo && (await appear.isEnabled())) {
        await appear.click();
        await expect(appear).toHaveText(new RegExp(`\\(${nodeInfo.appearances.length}\\)`));
        await page.getByRole('tab', { name: /^Links and sources/ }).click();
        await expect(page.getByRole('tab', { name: /^Links and sources/ })).toHaveText(new RegExp(`\\(${nodeInfo.links.length}\\)`));
        await c.snap(page, 'links');
      }
    });
    await close();
    c.done(w);
  });
}
