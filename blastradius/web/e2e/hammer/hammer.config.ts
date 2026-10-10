/**
 * Playwright hammer suite: every screen and feature, every role, light and dark, desktop and
 * mobile, against a LIVE server that the scenario runner (blastradius/test/hammer) populated
 * with scans of real public repositories. No mocks, no fixtures, no route interception.
 *
 *   HAMMER_BASE_URL=http://127.0.0.1:8000 HAMMER_ADMIN_EMAIL=admin@local HAMMER_ADMIN_PASSWORD=... \
 *     npm run hammer:e2e
 *
 * Optional: HAMMER_WORKERS (default 4), HAMMER_PROJECT_LIMIT (crawl only the first N projects),
 * HAMMER_GREP (Playwright --grep), PW_CHROMIUM (Chromium executable).
 * Output: e2e/hammer/out/report.md, screenshots under e2e/hammer/shots/<role>/<theme>/<viewport>/.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
const chromium = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: here,
  testMatch: '**/*.hammer.ts',
  outputDir: join(here, 'test-results'),
  globalSetup: join(here, 'global-setup.ts'),
  globalTeardown: join(here, 'global-teardown.ts'),
  fullyParallel: true,
  workers: Number(process.env.HAMMER_WORKERS ?? 4),
  retries: 0,
  // Crawls visit a hundred pages each; a whole combo gets an hour.
  timeout: 60 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: join(here, 'playwright-report'), open: 'never' }]],
  use: {
    baseURL: (process.env.HAMMER_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, ''),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: 'chromium',
      grepInvert: /@perf/,
      // Timing checks run as this project's teardown: after every other test, pass or fail.
      teardown: 'perf',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...(chromium ? { launchOptions: { executablePath: chromium } } : {}) },
    },
    {
      // Runs alone, so parallel workers do not skew its timings.
      name: 'perf',
      grep: /@perf/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...(chromium ? { launchOptions: { executablePath: chromium } } : {}) },
    },
  ],
});
