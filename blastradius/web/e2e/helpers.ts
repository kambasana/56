import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = process.env.BLASTRADIUS_DEV_PASSWORD || 'blastradius-dev';

export type DevRole = 'admin' | 'appsec' | 'developer' | 'auditor';

/** Sign in through the login form and wait for the sidebar. */
export async function login(page: Page, role: DevRole): Promise<void> {
  await page.goto('/');
  await page.locator('#email').fill(`${role}@local`);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Labels of the sidebar links, in order. */
export async function navLabels(page: Page): Promise<string[]> {
  const nav = page.getByRole('navigation', { name: 'Main' });
  return (await nav.locator('li').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
}

/** Wait until the seeded fixture scan has succeeded and return the dev project's id. */
export async function devProject(page: Page): Promise<string> {
  const res = await page.request.get('/api/projects');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const project = body.items.find((p) => p.name === 'payments-platform');
  expect(project, 'dev seed project').toBeTruthy();
  const id = project!.id;
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/api/projects/${encodeURIComponent(id)}/scans`);
        if (!r.ok()) return `http ${r.status()}`;
        const s = (await r.json()) as { items: { status: string }[] };
        return s.items.some((x) => x.status === 'succeeded') ? 'succeeded' : s.items.map((x) => x.status).join(',');
      },
      { timeout: 45_000 },
    )
    .toBe('succeeded');
  return id;
}

/** Collect console errors and uncaught exceptions; call the returned function to read them. */
export function watchConsole(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return () => errors;
}

/** Full-page screenshot into $BR_SCREENSHOTS/<name>.png when that variable is set. */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.BR_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}
