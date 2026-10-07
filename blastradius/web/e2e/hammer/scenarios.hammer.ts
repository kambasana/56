/**
 * Real-world scenarios as a user sees them: for each scenario in test/hammer/scenarios.json the
 * project must exist with a succeeded scan, and every expected component must show in the
 * Findings table at the expected level (filtered by its purl, side panel opened). Controls must
 * show no critical / malware finding. The yarn.lock scenario must surface its coverage gap in
 * the Scans side panel. A miss on a scenario that needs a blocked host is reported as blocked.
 */
import { expect, test, type Page } from '@playwright/test';
import { settle } from './lib/checks';
import { blockedSources, loadScenarios, readState, scenariosForServer, type ScenarioExpect } from './lib/env';
import { api, Check, getJson, rolePage } from './lib/feature';

const RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function levelOk(want: string, got: string | null): boolean {
  if (want === 'present') return got !== null;
  if (want === 'none') return got === null;
  if (want.startsWith('>=')) return got !== null && (RANK[got] ?? 0) >= (RANK[want.slice(2)] ?? 9);
  return got === want;
}

async function uiLevel(page: Page, e: ScenarioExpect): Promise<string | null> {
  await page.getByRole('searchbox').first().fill(e.purl);
  // Wait for the filtered count to settle before reading rows.
  const count = page.getByTestId('datatable-count').first();
  let last = '';
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const now = await count.innerText();
    if (now === last) break;
    last = now;
  }
  const rows = page.locator('tbody tr[data-row-id]');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    await row.click();
    const panel = page.getByRole('complementary', { name: 'Finding details' });
    await panel.waitFor();
    const title = (await panel.locator('[data-slot=sheet-title]').innerText()).trim();
    if (title === decodeURIComponent(e.purl.replace(/^pkg:[^/]+\//, ''))) {
      const level = ((await row.locator('td').first().innerText()).trim().toLowerCase().match(/critical|high|medium|low/) ?? [null])[0];
      await page.keyboard.press('Escape');
      return level;
    }
    await page.keyboard.press('Escape');
  }
  return null;
}

// With run-all.mjs each server is checked for the scenarios of its reference date only.
for (const s of scenariosForServer(loadScenarios())) {
  test(`scenario ${s.id}`, async ({ browser }) => {
    const state = readState();
    const c = new Check(s.id, 'admin', 'light', undefined, 'scenario');
    c.facts.repo = `${s.repo}@${s.commit.slice(0, 8)}`;
    const pid = state.scenarioProjects[s.id];
    if (!pid) {
      c.fail(`no project for scenario ${s.id} on the server (the scenario runner did not create it)`);
      c.done();
      return;
    }
    const proj = state.projects.find((p) => p.id === pid)!;
    if (proj.lastScanStatus !== 'succeeded') {
      c.fail(`latest scan of ${proj.name} is ${proj.lastScanStatus ?? 'missing'}, not succeeded`);
      c.done();
      return;
    }
    const blocked = blockedSources(state, s.sources);
    const { page, w, close } = await rolePage(browser, 'admin');
    await page.goto(`/projects/${encodeURIComponent(pid)}/findings`);
    await settle(page, 60_000);
    const ctx = await api('admin');
    for (const e of s.expect) {
      await c.step(e.purl, async () => {
        const got = await uiLevel(page, e);
        c.facts[e.purl] = got ?? 'absent';
        if (!levelOk(e.level, got)) {
          const msg = `${e.purl}: expected ${e.level}, the Findings table shows ${got ?? 'no row'}${e.note ? ` (${e.note})` : ''}`;
          if (blocked.length) c.fail(`${msg} [sources blocked: ${blocked.join(', ')}]`);
          else c.fail(msg);
        }
      });
    }
    // An absence ("no critical", "no malware") cannot be judged while the sources that would
    // produce it are blocked: a clean result then is "blocked", never a pass (same rule as the
    // scenario runner: reason:malware needs api.osv.dev, anything else every scenario source).
    const absenceBlocked = new Set<string>();
    for (const a of s.expectAbsent ?? []) {
      for (const h of blockedSources(state, a === 'reason:malware' ? ['api.osv.dev'] : s.sources)) absenceBlocked.add(h);
      await c.step(a, async () => {
        const [kind, value] = a.split(':') as [string, string];
        const items: { purl: string; level: string; factors: string[] }[] = [];
        for (let cursor = ''; ; ) {
          const pg = await getJson<{ items: typeof items; nextCursor: string | null }>(ctx, `/api/findings?project=${encodeURIComponent(pid)}&limit=500&sort=-score${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
          items.push(...pg.items);
          if (!pg.nextCursor || pg.items.length === 0) break;
          cursor = pg.nextCursor;
        }
        const hits = kind === 'level' ? items.filter((f) => f.level === value) : items.filter((f) => f.factors.includes(value));
        if (hits.length) c.fail(`${a}: ${hits.length} finding(s), e.g. ${hits.slice(0, 3).map((h) => h.purl).join(', ')}`);
        if (kind === 'level') {
          await page.getByRole('searchbox').first().fill('');
          await page.getByRole('button', { name: /^Filter by level/ }).click();
          const opt = page.getByRole('option', { name: new RegExp(value, 'i') });
          const count = Number(((await opt.innerText()).match(/(\d[\d,]*)\s*$/)?.[1] ?? '-1').replace(/,/g, ''));
          await page.keyboard.press('Escape');
          if (count !== hits.length) c.fail(`Level facet shows ${count} ${value}, API ${hits.length}`);
        }
      });
    }
    if (s.lockfile === 'yarn.lock' || s.expect.some((e) => e.level === 'none')) {
      await c.step('coverage warning is visible', async () => {
        await page.goto(`/projects/${encodeURIComponent(pid)}/scans`);
        await settle(page);
        await page.locator('tbody tr[data-row-id]').first().click();
        const panel = page.getByRole('complementary', { name: 'Scan details' });
        await expect(panel).toBeVisible();
        const text = await panel.innerText();
        if (!/yarn\.lock/i.test(text) || !/unsupported|not supported/i.test(text)) c.fail('the scan panel does not warn that yarn.lock is unsupported');
        await c.snap(page, 'coverage');
      });
    } else {
      await page.getByRole('searchbox').first().fill(s.expect[0]?.purl ?? '');
      await c.snap(page);
    }
    if (blocked.length && c.reasons.length) c.blocked = blocked;
    else if (absenceBlocked.size && c.reasons.length === 0) c.blocked = [...absenceBlocked];
    await ctx.dispose();
    await close();
    c.done(w);
  });
}

