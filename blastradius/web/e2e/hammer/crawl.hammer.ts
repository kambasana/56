/**
 * The crawl: for every role x theme x viewport, click every sidebar item, then open every screen
 * of every project on the server and audit it (console, failed API calls, overflow, clipped
 * text, overlapping controls, images/icons, axe serious/critical incl. contrast), with a
 * full-page screenshot under shots/<role>/<theme>/<viewport>/<page>.png. Pages a role may not
 * see are opened by direct URL too and must show the 403 state (or redirect, for `/`).
 *
 * One Playwright test per combination; each page is a step that records pass/fail with its
 * reasons, and the test fails at the end if any page failed.
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { axeProblems, fullShot, layoutProblems, settle, slug, watch, type Watcher } from './lib/checks';
import { readState, ROLES, SHOT_PREFIX, SHOTS_DIR, THEMES, VIEWPORTS, type HammerProject, type Role, type Theme, type Viewport } from './lib/env';
import { probeGraph } from './lib/feature';
import { record, statusOf } from './lib/report';
import { closeMobileNav, mobileNavOpen, NAV_LABEL, navLinks, openAs, openMobileNav, ROLE_PAGES, type PagePerm } from './lib/session';

interface PageSpec {
  key: string;
  path: string;
  perm: PagePerm | null;
  /** Content assertions specific to the page; return reasons. */
  check?: (page: Page) => Promise<string[]>;
}

const FORBIDDEN_TITLE = "You don't have access to this page";

async function h1(page: Page, text: string | RegExp): Promise<string[]> {
  const h = page.locator('h1').first();
  try {
    await expect(h).toBeVisible({ timeout: 5_000 });
    await expect(h).toHaveText(text, { timeout: 5_000 });
    return [];
  } catch {
    const got = (await h.innerText().catch(() => '')) || '(no h1)';
    return [`expected page title ${String(text)}, got "${got.trim().slice(0, 80)}"`];
  }
}

async function noErrorState(page: Page): Promise<string[]> {
  const err = page.getByText('Could not load this page');
  if (await err.count()) return [`page shows its error state: ${(await page.getByRole('alert').first().innerText().catch(() => '')).slice(0, 200)}`];
  return [];
}

function projectPages(p: HammerProject, withOrgExposure: boolean): PageSpec[] {
  const base = `/projects/${encodeURIComponent(p.id)}`;
  const n = `${p.name}/`;
  const pages: PageSpec[] = [
    { key: `${n}changes`, path: `${base}/changes`, perm: 'changes', check: async (pg) => [...(await h1(pg, 'Changes')), ...(await noErrorState(pg))] },
    {
      key: `${n}findings`,
      path: `${base}/findings`,
      perm: 'findings',
      check: async (pg) => {
        const r = [...(await h1(pg, 'Findings')), ...(await noErrorState(pg))];
        if (p.lastScanStatus === 'succeeded' && p.findings > 0) {
          const count = await pg.getByTestId('datatable-count').innerText().catch(() => '');
          const m = /Showing ([\d,]+) of ([\d,]+)/.exec(count);
          if (!m) r.push(`findings footer did not show a row count ("${count}")`);
          else if (Number(m[2]!.replace(/,/g, '')) !== p.findings) r.push(`findings footer says ${m[2]} findings, project list says ${p.findings}`);
          if ((await pg.locator('tbody tr[data-row-id]').count()) === 0) r.push('findings table rendered no rows');
        }
        return r;
      },
    },
    { key: `${n}exposure`, path: `${base}/exposure`, perm: 'exposure', check: async (pg) => [...(await h1(pg, 'Exposure matrix')), ...(await noErrorState(pg))] },
    { key: `${n}investigate`, path: `${base}/investigate`, perm: 'investigate', check: async (pg) => [...(await h1(pg, 'Investigate')), ...(await noErrorState(pg))] },
    {
      key: `${n}scans`,
      path: `${base}/scans`,
      perm: 'scans',
      check: async (pg) => {
        const r = [...(await h1(pg, 'Scans')), ...(await noErrorState(pg))];
        if (p.lastScanStatus && (await pg.locator('tbody tr[data-row-id]').count()) === 0) r.push('scans table rendered no rows');
        return r;
      },
    },
  ];
  if (p.topFindingId) {
    const fid = encodeURIComponent(p.topFindingId);
    pages.push({
      key: `${n}finding`,
      path: `${base}/findings/${fid}`,
      perm: 'findings',
      check: async (pg) => {
        const r = await noErrorState(pg);
        const t = (await pg.locator('h1').first().innerText().catch(() => '')).trim();
        if (!t.includes('@')) r.push(`finding page title is "${t}", expected name@version`);
        return r;
      },
    });
    pages.push({
      key: `${n}investigate-graph`,
      path: `${base}/investigate?finding=${fid}`,
      perm: 'investigate',
      check: async (pg) => {
        const r = await noErrorState(pg);
        const g = await probeGraph(pg, '[role=img][aria-label^="Graph centred on"]');
        if (!g || g.nodes < 1) r.push(`investigate graph has ${g?.nodes ?? 0} nodes`);
        else {
          if (g.badPositions.length) r.push(`${g.badPositions.length} graph node(s) at NaN positions`);
          if (g.inked < 0.002) r.push('graph canvas is blank');
          if (g.labelOverlaps.length) r.push(`${g.labelOverlaps.length} pair(s) of graph labels overlap, e.g. ${g.labelOverlaps.slice(0, 2).join('; ')}`);
          if (g.encodedLabels.length) r.push(`graph labels show URL escapes: ${g.encodedLabels.slice(0, 2).join(', ')}`);
        }
        return r;
      },
    });
  }
  if (withOrgExposure) pages.push({ key: 'exposure-org', path: `${base}/exposure?scope=org`, perm: 'exposure', check: async (pg) => [...(await h1(pg, 'Exposure matrix')), ...(await noErrorState(pg))] });
  return pages;
}

function orgPages(): PageSpec[] {
  return [
    {
      key: 'home',
      path: '/',
      perm: 'home',
      check: async (pg) => {
        const r = [...(await h1(pg, 'Home')), ...(await noErrorState(pg))];
        const state = readState();
        for (const p of state.projects.slice(0, 50)) {
          if (!(await pg.getByText(p.name, { exact: true }).count())) r.push(`Org home does not list project ${p.name}`);
        }
        return r;
      },
    },
    { key: 'reports', path: '/reports', perm: 'reports', check: async (pg) => [...(await h1(pg, 'Reports')), ...(await noErrorState(pg))] },
    { key: 'integrations', path: '/integrations', perm: 'integrations', check: async (pg) => [...(await h1(pg, 'Integrations')), ...(await noErrorState(pg))] },
    ...['members', 'roles', 'bindings', 'project', 'audit'].map(
      (tab): PageSpec => ({
        key: `settings-${tab}`,
        path: tab === 'members' ? '/settings' : `/settings?tab=${tab}`,
        perm: 'settings',
        check: async (pg) => [...(await h1(pg, 'Settings')), ...(await noErrorState(pg))],
      }),
    ),
    { key: 'not-found', path: '/no-such-page', perm: null, check: async (pg) => ((await pg.getByText('Page not found').count()) ? [] : ['unknown route does not show "Page not found"']) },
  ];
}

async function audit(page: Page, w: Watcher, spec: PageSpec, role: Role | 'anonymous', theme: Theme, vp: Viewport, forbidden: boolean): Promise<boolean> {
  w.reset();
  if (forbidden) w.allow403(/.*/);
  if (role === 'anonymous') w.allow401(/^\/api\/me/);
  const reasons: string[] = [];
  const started = Date.now();
  try {
    await page.goto(spec.path);
  } catch (e) {
    reasons.push(`navigation failed: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]}`);
  }
  const unsettled = await settle(page);
  if (unsettled) reasons.push(unsettled);
  const ms = Date.now() - started;
  if (forbidden) {
    if (spec.path === '/') {
      if (new URL(page.url()).pathname === '/') reasons.push('a role without home was not redirected away from /');
    } else if (!(await page.getByText(FORBIDDEN_TITLE).count())) {
      reasons.push(`direct URL to a forbidden page did not show the 403 state (url ${new URL(page.url()).pathname})`);
    }
  } else if (spec.check) {
    try {
      reasons.push(...(await spec.check(page)));
    } catch (e) {
      reasons.push(`content check threw: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]}`);
    }
  }
  reasons.push(...w.problems());
  try {
    reasons.push(...(await layoutProblems(page)));
  } catch (e) {
    reasons.push(`layout check threw: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]}`);
  }
  try {
    reasons.push(...(await axeProblems(page)));
  } catch (e) {
    reasons.push(`axe threw: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]}`);
  }
  const name = forbidden ? `forbidden.${spec.key}` : spec.key;
  const shot = join(SHOTS_DIR, role, theme, vp.name, `${SHOT_PREFIX}${slug(name)}.png`);
  try {
    await fullShot(page, shot);
  } catch (e) {
    reasons.push(`screenshot failed: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]}`);
  }
  record({ area: 'crawl', page: name, role, theme, viewport: vp.name, status: statusOf(reasons), reasons, url: spec.path, shot, ms, facts: forbidden ? { api403: w.forbidden().length } : {} });
  return reasons.length === 0;
}

const limit = Number(process.env.HAMMER_PROJECT_LIMIT ?? 0);

for (const role of ROLES) {
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      test(`crawl ${role} ${theme} ${vp.name}`, async ({ browser }) => {
        const state = readState();
        const projects = limit > 0 ? state.projects.slice(0, limit) : state.projects;
        const { context, page } = await openAs(browser, role, theme, vp);
        const w = watch(page);
        const failed: string[] = [];
        const allowed = new Set(ROLE_PAGES[role]);

        // 1. Nav: exactly the pages PLAN §12 grants, and every item navigates.
        await test.step('nav items', async () => {
          w.reset();
          await page.goto(projects[0] ? `/projects/${encodeURIComponent(projects[0].id)}/${allowed.has('findings') ? 'findings' : 'scans'}` : '/');
          if (role === 'auditor') await page.goto('/');
          await settle(page);
          const reasons: string[] = [];
          let links: { label: string; href: string }[] = [];
          try {
            links = await navLinks(page, vp.name === 'mobile');
          } catch (e) {
            reasons.push(`could not read the sidebar: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]}`);
          }
          const labels = links.map((l) => l.label);
          for (const p of allowed) {
            if (['changes', 'findings', 'exposure', 'investigate', 'scans'].includes(p) && projects.length === 0) continue;
            if (!labels.includes(NAV_LABEL[p])) reasons.push(`nav lacks ${NAV_LABEL[p]}`);
          }
          for (const p of Object.keys(NAV_LABEL) as PagePerm[]) if (!allowed.has(p) && labels.includes(NAV_LABEL[p])) reasons.push(`nav shows ${NAV_LABEL[p]} but ${role} lacks that page`);
          // Click each item and check where it lands.
          const sheetStaysOpen: string[] = [];
          for (const l of links) {
            if (!l.href || l.href.startsWith('http')) continue;
            try {
              if (vp.name === 'mobile') await openMobileNav(page);
              await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: l.label, exact: true }).click();
              await settle(page, 20_000);
              if (vp.name === 'mobile') {
                // On a phone the nav sheet should get out of the way once a destination is picked.
                if (await mobileNavOpen(page)) {
                  sheetStaysOpen.push(l.label);
                  await closeMobileNav(page);
                }
              }
              const want = l.href.split('#')[0]!;
              const got = new URL(page.url()).pathname;
              if (got !== want) reasons.push(`nav "${l.label}" went to ${got}, expected ${want}`);
              if (await page.getByText(FORBIDDEN_TITLE).count()) reasons.push(`nav "${l.label}" opens a 403 page`);
            } catch (e) {
              reasons.push(`nav "${l.label}" click failed: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]}`);
            }
          }
          if (sheetStaysOpen.length) reasons.push(`mobile nav sheet stays open over the page after choosing ${sheetStaysOpen.join(', ')}`);
          reasons.push(...w.problems());
          const shot = join(SHOTS_DIR, role, theme, vp.name, `${SHOT_PREFIX}nav.png`);
          if (vp.name === 'mobile') await openMobileNav(page).catch(() => undefined);
          await fullShot(page, shot).catch(() => undefined);
          if (vp.name === 'mobile') {
            reasons.push(...(await layoutProblems(page).catch(() => [])));
            await closeMobileNav(page);
          }
          record({ area: 'crawl', page: 'nav', role, theme, viewport: vp.name, status: statusOf(reasons), reasons, shot, facts: { items: labels.join(' / ') } });
          if (reasons.length) failed.push('nav');
        });

        // 2. Every page.
        const specs: PageSpec[] = [...orgPages()];
        projects.forEach((p, i) => specs.push(...projectPages(p, i === 0)));
        for (const spec of specs) {
          const isForbidden = spec.perm !== null && !allowed.has(spec.perm) && !(spec.perm === 'home' && allowed.has('projects'));
          await test.step(`${isForbidden ? 'forbidden ' : ''}${spec.key}`, async () => {
            const ok = await audit(page, w, spec, role, theme, vp, isForbidden);
            if (!ok) failed.push(spec.key);
          });
        }
        await context.close();
        expect(failed, `${failed.length} of ${specs.length + 1} pages failed for ${role}/${theme}/${vp.name}; see out/report.md`).toEqual([]);
      });
    }
  }
}

for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    test(`crawl signed-out ${theme} ${vp.name}`, async ({ browser }) => {
      const { context, page } = await openAs(browser, null, theme, vp);
      const w = watch(page);
      const failed: string[] = [];
      const specs: PageSpec[] = [
        {
          key: 'login',
          path: '/login',
          perm: null,
          check: async (pg) => ((await pg.locator('#email').isVisible()) && (await pg.getByRole('button', { name: 'Sign in' }).isVisible()) ? [] : ['sign-in form not visible']),
        },
        {
          key: 'accept-invite',
          path: '/accept-invite',
          perm: null,
          check: async (pg) => ((await pg.getByRole('heading', { name: 'Accept your invite' }).count()) ? [] : ['accept-invite heading missing']),
        },
        {
          key: 'redirect-to-login',
          path: '/settings',
          perm: null,
          check: async (pg) => (new URL(pg.url()).pathname === '/login' ? [] : [`signed-out /settings went to ${new URL(pg.url()).pathname}, not /login`]),
        },
      ];
      for (const spec of specs) {
        await test.step(spec.key, async () => {
          if (!(await audit(page, w, spec, 'anonymous', theme, vp, false))) failed.push(spec.key);
        });
      }
      await context.close();
      expect(failed).toEqual([]);
    });
  }
}
