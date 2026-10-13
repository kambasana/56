/** Load the Tier 0.5 recorded fixtures and replay them through the product code (offline). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { HttpClient } from '../../src/core/http.js';
import type { Fact, StabilityReport } from '../../src/core/types.js';
import { createDepsDevEnricher } from '../../src/enrich/depsdev/index.js';
import { createPypiEnricher } from '../../src/enrich/pypi/index.js';
import { buildStabilityReport } from '../../src/stability/report.js';
import { STABILITY_DIR } from './fixture.js';
import type { Tier05PypiFixture } from './record-tier05-pypi.js';
import type { Tier05ReadmeFixture } from './record-tier05-readmes.js';

export function loadTier05Pypi(slug: string): Tier05PypiFixture {
  return JSON.parse(gunzipSync(readFileSync(join(STABILITY_DIR, `tier05-pypi-${slug}.json.gz`))).toString('utf8')) as Tier05PypiFixture;
}

export function loadTier05Readmes(): Tier05ReadmeFixture {
  return JSON.parse(gunzipSync(readFileSync(join(STABILITY_DIR, 'tier05-readmes.json.gz'))).toString('utf8')) as Tier05ReadmeFixture;
}

/** deps.dev + PyPI facts through the real enrichers on the recorded responses, and the stability report. */
export async function tier05PypiReport(slug: string): Promise<{ fx: Tier05PypiFixture; facts: Fact[]; report: StabilityReport; warnings: string[] }> {
  const fx = loadTier05Pypi(slug);
  const fixtures: Record<string, unknown> = {};
  for (const [url, body] of Object.entries(fx.responses)) fixtures[url] = body === null ? { status: 404, response: null } : { status: 200, response: body };
  const http = new HttpClient({ offline: true, cacheDir: false, fixtures });
  const now = new Date(fx.recordedAt);
  const warnings: string[] = [];
  const ctx = { http, now, offline: true, warn: (m: string) => warnings.push(m) };
  const facts = [...(await createDepsDevEnricher({ dependents: false }).enrich(fx.inventory, ctx)), ...(await createPypiEnricher().enrich(fx.inventory, ctx))];
  return { fx, facts, report: buildStabilityReport(fx.inventory, facts, now, {}), warnings };
}
