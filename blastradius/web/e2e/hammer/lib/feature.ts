/** Shared plumbing for feature checks: a reasons list, a watcher, a recorded result. */
import { join } from 'node:path';
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { request as pwRequest } from '@playwright/test';
import { fullShot, settle, slug, watch, type Watcher } from './checks';
import { BASE_URL, readState, SHOT_PREFIX, SHOTS_DIR, userFor, type HammerProject, type Role, type Theme, type Viewport } from './env';
import { record, type Status } from './report';
import { openAs } from './session';

export const DESKTOP: Viewport = { name: 'desktop', width: 1440, height: 900 };
export const MOBILE: Viewport = { name: 'mobile', width: 390, height: 844 };

export class Check {
  readonly reasons: string[] = [];
  readonly facts: Record<string, string | number | boolean> = {};
  blocked: string[] = [];
  shot: string | undefined;
  constructor(
    readonly name: string,
    readonly role: Role | 'anonymous',
    readonly theme: Theme = 'light',
    readonly viewport: Viewport = DESKTOP,
    readonly area = 'feature',
  ) {}

  fail(reason: string): void {
    this.reasons.push(reason);
  }

  /** Run `fn`; an exception becomes a failure reason instead of aborting the other checks. */
  async step(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.reasons.push(`${label}: ${(e as Error).message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 400)}`);
    }
  }

  async snap(page: Page, suffix = ''): Promise<void> {
    const path = join(SHOTS_DIR, this.role, this.theme, this.viewport.name, `${SHOT_PREFIX}${this.area}.${slug(this.name)}${suffix ? `.${slug(suffix)}` : ''}.png`);
    try {
      await fullShot(page, path);
      this.shot ??= path;
    } catch (e) {
      this.reasons.push(`screenshot failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  /** Record and assert. Blocked checks are recorded as blocked and fail the test too: blocked is not a pass. */
  done(w?: Watcher): void {
    if (w) this.reasons.push(...w.problems());
    const status: Status = this.reasons.length === 0 && this.blocked.length === 0 ? 'pass' : this.blocked.length > 0 ? 'blocked' : 'fail';
    const reasons = this.blocked.length ? [...this.blocked.map((h) => `blocked: ${h}`), ...this.reasons] : this.reasons;
    record({ area: this.area, page: this.name, role: this.role, theme: this.theme, viewport: this.viewport.name, status, reasons, ...(this.shot ? { shot: this.shot } : {}), facts: this.facts });
    expect(reasons, `${this.area} ${this.name} (${this.role}/${this.theme}/${this.viewport.name})`).toEqual([]);
  }
}

export async function rolePage(browser: Browser, role: Role, theme: Theme = 'light', vp: Viewport = DESKTOP): Promise<{ page: Page; w: Watcher; close: () => Promise<void> }> {
  const { context, page } = await openAs(browser, role, theme, vp);
  const w = watch(page);
  return { page, w, close: () => context.close() };
}

/** An API client signed in as `role` (reuses the saved session; no extra sign-in). */
export async function api(role: Role): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: BASE_URL, storageState: userFor(role).storageState, extraHTTPHeaders: { 'X-Requested-With': 'blastradius' } });
}

export async function getJson<T>(ctx: APIRequestContext, path: string): Promise<T> {
  const r = await ctx.get(path);
  if (!r.ok()) throw new Error(`GET ${path}: HTTP ${r.status()}`);
  return (await r.json()) as T;
}

/** Projects whose latest scan succeeded, most findings first. */
export function scannedProjects(): HammerProject[] {
  return readState()
    .projects.filter((p) => p.lastScanStatus === 'succeeded')
    .sort((a, b) => b.findings - a.findings);
}

export async function gotoSettled(page: Page, path: string, c: Check): Promise<void> {
  await page.goto(path);
  const s = await settle(page);
  if (s) c.fail(`${path}: ${s}`);
}

/** The live Cytoscape instance behind a graph container (cytoscape keeps it on container._cyreg). */
export interface CyProbe {
  nodes: number;
  edges: number;
  zoom: number;
  pan: { x: number; y: number };
  badPositions: string[];
  /** Node rendered positions relative to the container. */
  rendered: { id: string; x: number; y: number; label: string }[];
  width: number;
  height: number;
  /** Fraction of sampled canvas pixels that are not the background colour. */
  inked: number;
  /** Pairs of node labels whose rendered boxes overlap (unreadable text). */
  labelOverlaps: string[];
  /** Labels that still contain URL escapes such as %40. */
  encodedLabels: string[];
}

export async function probeGraph(page: Page, selector: string): Promise<CyProbe | null> {
  const el = page.locator(selector).first();
  if (!(await el.count())) return null;
  return el.evaluate((d) => {
    type Pos = { x: number; y: number };
    type BB = { x1: number; x2: number; y1: number; y2: number; w: number; h: number };
    type N = { id: () => string; position: () => Pos; renderedPosition: () => Pos; data: (k: string) => unknown; renderedBoundingBox: (o: object) => BB };
    type Cy = { nodes: () => { length: number; map: <T>(f: (n: N) => T) => T[] }; edges: () => { length: number }; zoom: () => number; pan: () => Pos; width: () => number; height: () => number };
    const cy = (d as unknown as { _cyreg?: { cy?: Cy } })._cyreg?.cy;
    if (!cy) return null;
    const bad: string[] = [];
    const rendered = cy.nodes().map((n) => {
      const p = n.position();
      const r = n.renderedPosition();
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) bad.push(n.id());
      return { id: n.id(), x: r.x, y: r.y, label: String(n.data('label') ?? '') };
    });
    // Sample the canvases: a drawn graph has non-background pixels.
    let inked = 0;
    let total = 0;
    for (const c of Array.from(d.querySelectorAll('canvas'))) {
      const ctx = c.getContext('2d');
      if (!ctx || c.width === 0 || c.height === 0) continue;
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const step = 4 * 37;
      for (let i = 0; i < data.length; i += step) {
        total++;
        if (data[i + 3]! > 20) inked++;
      }
    }
    const boxes = cy.nodes().map((n) => ({ label: String(n.data('label') ?? ''), b: n.renderedBoundingBox({ includeNodes: false, includeEdges: false, includeLabels: true }) }));
    const labelOverlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (!a.label || !b.label || a.b.w <= 0 || b.b.w <= 0) continue;
        const w = Math.min(a.b.x2, b.b.x2) - Math.max(a.b.x1, b.b.x1);
        const h = Math.min(a.b.y2, b.b.y2) - Math.max(a.b.y1, b.b.y1);
        if (w > 3 && h > 3) labelOverlaps.push(`"${a.label}" / "${b.label}"`);
      }
    }
    const encodedLabels = boxes.map((x) => x.label).filter((l) => /%[0-9A-Fa-f]{2}/.test(l));
    return { nodes: cy.nodes().length, edges: cy.edges().length, zoom: cy.zoom(), pan: cy.pan(), badPositions: bad, rendered, width: cy.width(), height: cy.height(), inked: total ? inked / total : 0, labelOverlaps, encodedLabels };
  });
}

export { readState, settle };
