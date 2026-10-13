/**
 * Page audits for the hammer crawl. Each check returns human-readable failure reasons; nothing
 * is retried or softened. A page passes only when every list is empty.
 *
 *  - console errors and uncaught exceptions
 *  - failed requests: any /api response >= 400 (except 403s the caller expects), any failed
 *    image/font/script/style load
 *  - horizontal page overflow (document wider than the viewport)
 *  - text overflowing its box without ellipsis / line-clamp / a scroll container
 *  - overlapping interactive elements (after clipping by scroll containers)
 *  - images that did not decode, icons that rendered at 0x0
 *  - axe-core violations with impact serious or critical (colour contrast included)
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

export interface Watcher {
  /** Problems seen since the last reset. */
  problems: () => string[];
  /** 403 responses seen (always recorded, for RBAC checks). */
  forbidden: () => string[];
  reset: () => void;
  /** Allow 403 from /api paths matching this pattern until the next reset. */
  allow403: (re: RegExp) => void;
  /** Allow 401 from /api/me (signed-out pages). */
  allow401: (re: RegExp) => void;
}

const MAX_TEXT = 300;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

function apiPath(url: string): string | null {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/api/') ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

/** Start recording console errors, page errors and failed requests for `page`. */
export function watch(page: Page): Watcher {
  let problems: string[] = [];
  let forbidden: string[] = [];
  let allowed403: RegExp[] = [];
  let allowed401: RegExp[] = [];
  const allowedUrls = new Set<string>();

  const onConsole = (m: ConsoleMessage) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const loc = m.location()?.url ?? '';
    // Chromium logs every non-2xx resource as a console error; those are judged in onResponse.
    if (/^Failed to load resource: the server responded with a status of \d+/.test(text) && allowedUrls.has(loc)) return;
    if (/^Failed to load resource: the server responded with a status of \d+/.test(text) && apiPath(loc)) return;
    problems.push(`console error: ${clip(text)}${loc ? ` (${clip(loc)})` : ''}`);
  };
  const onPageError = (e: Error) => problems.push(`uncaught exception: ${clip(e.message)}`);
  const onResponse = (r: Response) => {
    const status = r.status();
    if (status < 400) return;
    const url = r.url();
    const path = apiPath(url);
    if (path) {
      if (status === 403) forbidden.push(path);
      if (status === 403 && allowed403.some((re) => re.test(path))) {
        allowedUrls.add(url);
        return;
      }
      if (status === 401 && allowed401.some((re) => re.test(path))) {
        allowedUrls.add(url);
        return;
      }
      problems.push(`HTTP ${status} ${r.request().method()} ${clip(path)}`);
      return;
    }
    const type = r.request().resourceType();
    if (['image', 'font', 'script', 'stylesheet', 'document'].includes(type)) problems.push(`HTTP ${status} loading ${type} ${clip(url)}`);
  };
  const onRequestFailed = (req: Request) => {
    const err = req.failure()?.errorText ?? 'failed';
    // Aborted by navigation or by the app's AbortController (useApi unmount): not a failure.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(err)) return;
    const type = req.resourceType();
    const path = apiPath(req.url());
    if (path || ['image', 'font', 'script', 'stylesheet', 'document', 'fetch', 'xhr'].includes(type)) {
      problems.push(`request failed (${err}) ${type} ${clip(path ?? req.url())}`);
    }
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    problems: () => [...problems],
    forbidden: () => [...forbidden],
    reset: () => {
      problems = [];
      forbidden = [];
      allowed403 = [];
      allowed401 = [];
      allowedUrls.clear();
    },
    allow403: (re) => allowed403.push(re),
    allow401: (re) => allowed401.push(re),
  };
}

/**
 * Wait until the page has settled: network idle, no skeletons, no "Loading…" status. Returns a
 * reason when it never settled (a page stuck loading is a failure, not something to wait out).
 */
export async function settle(page: Page, timeoutMs = 25_000): Promise<string | null> {
  const start = Date.now();
  await page.waitForLoadState('domcontentloaded');
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch {
    return `network still busy after ${timeoutMs} ms`;
  }
  const left = Math.max(2_000, timeoutMs - (Date.now() - start));
  try {
    await page.waitForFunction(
      () => {
        const busy = Array.from(document.querySelectorAll('[data-slot="skeleton"], [aria-busy="true"]')).filter((el) => (el as HTMLElement).checkVisibility?.() ?? true);
        const loading = Array.from(document.querySelectorAll('[role="status"]')).some((el) => /^(Loading|Searching)/i.test(((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim()));
        return busy.length === 0 && !loading;
      },
      undefined,
      { timeout: left, polling: 200 },
    );
  } catch {
    return `still showing loading skeletons after ${timeoutMs} ms`;
  }
  // Let fonts, layout and Cytoscape's first frame finish.
  await page.evaluate(() => document.fonts?.ready.then(() => undefined));
  await page.waitForTimeout(250);
  return null;
}

/** Layout checks run in the page: overflow, clipped text, overlapping controls, broken images. */
export async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = window.innerWidth;
    const de = document.documentElement;
    if (de.scrollWidth > vw + 1) {
      // Name the widest offenders so the report says what to fix.
      const wide = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > vw + 1 && r.width > 0 && el.checkVisibility();
        })
        .slice(0, 3)
        .map((el) => describe(el));
      out.push(`horizontal overflow: page is ${de.scrollWidth}px wide in a ${vw}px viewport (${wide.join('; ') || 'no single culprit'})`);
    }

    function describe(el: Element): string {
      const h = el as HTMLElement;
      const id = h.id ? `#${h.id}` : '';
      const slot = h.dataset?.slot ? `[data-slot=${h.dataset.slot}]` : '';
      const role = h.getAttribute('role') ? `[role=${h.getAttribute('role')}]` : '';
      const label = h.getAttribute('aria-label') ? `[aria-label="${h.getAttribute('aria-label')!.slice(0, 40)}"]` : '';
      const text = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
      return `<${el.tagName.toLowerCase()}${id}${slot}${role}${label}>${text ? ` "${text}"` : ''}`;
    }

    /** The part of `el` that is visible after every clipping ancestor (and the page width). */
    function visibleRect(el: Element): DOMRect | null {
      let r = el.getBoundingClientRect();
      let x1 = Math.max(r.left, 0);
      let x2 = Math.min(r.right, vw);
      let y1 = r.top;
      let y2 = r.bottom;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const pr = p.getBoundingClientRect();
          if (cs.overflowX !== 'visible') {
            x1 = Math.max(x1, pr.left);
            x2 = Math.min(x2, pr.right);
          }
          if (cs.overflowY !== 'visible') {
            y1 = Math.max(y1, pr.top);
            y2 = Math.min(y2, pr.bottom);
          }
        }
        if (cs.position === 'fixed') break;
      }
      if (x2 - x1 < 1 || y2 - y1 < 1) return null;
      r = new DOMRect(x1, y1, x2 - x1, y2 - y1);
      return r;
    }

    // Text that spills out of (or is cut off by) its own box.
    const textIssues: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
      if (!hasText) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'inline' || cs.display === 'contents') continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) continue; // sr-only
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      if (cs.textOverflow === 'ellipsis') continue;
      if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') continue;
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      if (!visibleRect(el)) continue;
      const how = cs.overflowX === 'visible' ? 'spills out of' : 'is cut off by';
      textIssues.push(`text ${how} its box (${el.scrollWidth}px in ${el.clientWidth}px): ${describe(el)}`);
    }
    out.push(...textIssues.slice(0, 8));
    if (textIssues.length > 8) out.push(`… and ${textIssues.length - 8} more text overflow issues`);

    // Interactive elements that overlap each other.
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [role=combobox], [role=link], [tabindex="0"]';
    const items: { el: HTMLElement; r: DOMRect }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (el.closest('[aria-hidden="true"]') && el.tabIndex < 0) continue;
      const r = visibleRect(el);
      if (!r || r.width < 4 || r.height < 4) continue;
      items.push({ el, r });
    }
    const layer = (el: Element) => el.closest('[role=dialog], [role=alertdialog], [data-slot=sheet-content], [data-radix-popper-content-wrapper]');
    const overlaps: string[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // Different layers (an open sheet/dialog over the page) are not an overlap.
        if (layer(a.el) !== layer(b.el)) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w >= 4 && h >= 4) overlaps.push(`overlapping controls (${Math.round(w)}x${Math.round(h)}px): ${describe(a.el)} and ${describe(b.el)}`);
      }
    }
    // Controls in the viewport that something else covers (e.g. a sticky bar on top of them).
    const covered: string[] = [];
    for (const { el, r } of items) {
      if (r.top < 0 || r.bottom > window.innerHeight) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top || el.contains(top) || top.contains(el)) continue;
      // Labels for checkboxes/inputs forward clicks; treat as part of the control.
      if (top instanceof HTMLLabelElement && (top.control === el || top.contains(el))) continue;
      // Open popovers/menus/dialogs legitimately cover the page.
      if (top.closest('[role=dialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper], [data-slot=sheet-overlay], [data-slot=dialog-overlay]')) continue;
      // Scrolled under a sticky header/footer of its own scroll container (e.g. a table's sticky
      // totals row): the control is scrolled out of view, not covered. Anything else still counts.
      const scroller = (() => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) return p;
        }
        return null;
      })();
      if (scroller && scroller.contains(top)) {
        let sticky = false;
        for (let p: Element | null = top; p && p !== scroller; p = p.parentElement) if (getComputedStyle(p).position === 'sticky') sticky = true;
        if (sticky) continue;
      }
      covered.push(`control covered by another element: ${describe(el)} under ${describe(top)}`);
    }
    out.push(...overlaps.slice(0, 6), ...covered.slice(0, 6));
    if (overlaps.length > 6) out.push(`… and ${overlaps.length - 6} more overlapping controls`);
    if (covered.length > 6) out.push(`… and ${covered.length - 6} more covered controls`);

    // Images and icons.
    for (const img of Array.from(document.images)) {
      if (!img.checkVisibility()) continue;
      if (!img.complete || img.naturalWidth === 0) out.push(`image did not load: ${img.currentSrc || img.src}`);
    }
    let zeroIcons = 0;
    for (const svg of Array.from(document.querySelectorAll<SVGSVGElement>('svg'))) {
      if (!svg.checkVisibility({ checkVisibilityCSS: true })) continue;
      const r = svg.getBoundingClientRect();
      const parent = svg.parentElement?.getBoundingClientRect();
      if ((r.width === 0 || r.height === 0) && parent && parent.width > 0 && parent.height > 0) zeroIcons++;
    }
    if (zeroIcons > 0) out.push(`${zeroIcons} icon(s) rendered at 0x0`);
    return out;
  });
}

/** axe-core serious/critical violations (WCAG 2.x A/AA + best practice, colour contrast included). */
export async function axeProblems(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => {
      const where = v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ');
      return `axe ${v.impact} ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'}: ${clip(where)})`;
    });
}

export async function fullShot(page: Page, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' });
}

/** File-system safe page name. */
export function slug(s: string): string {
  return s
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120) || 'root';
}
