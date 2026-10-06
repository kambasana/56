/**
 * Playwright e2e for the web app. Starts the built server against a throwaway SQLite file:
 *
 *   node dist/cli.js serve --dev-seed --offline --fixtures test/fixtures --db <tmp>
 *
 * Needs `npm run build` in both blastradius/ and blastradius/web/ first.
 * Run from blastradius/web: `npx playwright test -c e2e/playwright.config.ts`.
 * Set BR_SCREENSHOTS=<dir> to also write full-page screenshots of every screen.
 * Set PW_CHROMIUM=<path> to use a preinstalled Chromium instead of Playwright's download.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = join(here, '..', '..');
// Created once in the main process; workers re-evaluate this file but do not start the server.
const dbDir = process.env.BR_E2E_DB_DIR ?? (process.env.BR_E2E_DB_DIR = mkdtempSync(join(tmpdir(), 'br-e2e-')));
const port = Number(process.env.BR_E2E_PORT ?? 8000);
const baseURL = `http://127.0.0.1:${port}`;
const chromium = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: here,
  testMatch: '*.spec.ts',
  outputDir: join(here, '..', 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: join(here, '..', 'playwright-report'), open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...(chromium ? { launchOptions: { executablePath: chromium } } : {}) },
    },
  ],
  webServer: {
    command: `node dist/cli.js serve --dev-seed --offline --fixtures test/fixtures --db ${JSON.stringify(join(dbDir, 'e2e.db'))} --host 127.0.0.1 --port ${port}`,
    cwd: pkgRoot,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
