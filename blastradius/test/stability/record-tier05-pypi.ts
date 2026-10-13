/**
 * Record the Tier 0.5 PyPI upkeep fixture ONCE per target (needs network; never run in tests or CI):
 *   npx tsx test/stability/record-tier05-pypi.ts <slug> <checkout of the target at its pinned commit>
 *
 * Python upkeep must never read as clean (independent verification of the Tier 0 re-scans: flask's
 * 7 runtime PyPI packages and superset's 146 got no stability label at all). This records, for every
 * PyPI component of the target's inventory (ingested offline by the product code), the responses
 * the deps.dev and PyPI enrichers read, trimmed to the fields they use:
 *   deps.dev version (SOURCE_REPO links), deps.dev project / Scorecard API (Maintained check),
 *   PyPI JSON API (per release: first upload, yanked; the "Development Status" classifiers;
 *   info.version), PyPI Simple JSON (project-status; files with a Trusted Publishing attestation).
 * The tests replay them through the real enrichers (HttpClient fixtures, offline).
 * Output: test/fixtures/stability/recorded/tier05-pypi-<slug>.json.gz.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installEnvProxy } from '../../src/core/proxy.js';
import { HttpClient } from '../../src/core/http.js';
import type { Inventory } from '../../src/core/types.js';
import { versionOfFile } from '../../src/enrich/pypi/index.js';
import { STABILITY_DIR } from './fixture.js';

type Json = Record<string, any>;

export interface Tier05PypiFixture {
  _note: string;
  recordedAt: string;
  target: string;
  /** The PyPI part of the scanned inventory: PyPI components, the edges into them, their assets. */
  inventory: Inventory;
  /** URL → trimmed JSON response (null: 404 / no answer). */
  responses: Record<string, Json | null>;
}

/** Keep only what src/enrich/{depsdev,pypi} read. */
export function trimResponse(url: string, body: Json | null): Json | null {
  if (!body || typeof body !== 'object') return null;
  if (url.includes('/pypi/') && url.endsWith('/json')) {
    const releases: Json = {};
    for (const [v, files] of Object.entries((body.releases ?? {}) as Json)) {
      if (!Array.isArray(files) || files.length === 0) continue;
      const times = files.map((f: Json) => f?.upload_time_iso_8601).filter((t: unknown): t is string => typeof t === 'string').sort();
      const yanked = files.every((f: Json) => f?.yanked === true);
      const reason = files.find((f: Json) => typeof f?.yanked_reason === 'string' && f.yanked_reason)?.yanked_reason;
      releases[v] = [{ upload_time_iso_8601: times[0], yanked, ...(yanked && reason ? { yanked_reason: reason } : {}) }];
    }
    const classifiers = (Array.isArray(body.info?.classifiers) ? body.info.classifiers : []).filter((c: unknown) => typeof c === 'string' && c.startsWith('Development Status'));
    // Tier 0.6: the latest release's source links, and the opening of the description (the PyPI
    // README) where a project-level status declaration would be.
    const urls = body.info?.project_urls && typeof body.info.project_urls === 'object' ? body.info.project_urls : undefined;
    const description = typeof body.info?.description === 'string' ? body.info.description.slice(0, 3000) : undefined;
    return { info: { name: body.info?.name, version: body.info?.version, classifiers, ...(urls ? { project_urls: urls } : {}), ...(body.info?.home_page ? { home_page: body.info.home_page } : {}), ...(description ? { description } : {}) }, releases };
  }
  if (url.includes('/simple/')) {
    // Only files with a Trusted Publishing attestation (their name and the attestation URL).
    // One per version is enough to know the version went out through Trusted Publishing.
    const seen = new Set<string>();
    const files = (body.files ?? [])
      .filter((f: Json) => typeof f?.provenance === 'string' && f.provenance && typeof f.filename === 'string')
      .filter((f: Json) => {
        const v = versionOfFile(f.filename);
        if (!v || seen.has(v)) return false;
        seen.add(v);
        return true;
      })
      .map((f: Json) => ({ filename: f.filename, provenance: f.provenance }));
    return { ...(body['project-status'] ? { 'project-status': body['project-status'] } : {}), ...(files.length ? { files } : {}) };
  }
  if (url.includes('api.deps.dev') && url.includes('/versions/')) {
    return {
      relatedProjects: (body.relatedProjects ?? []).filter((r: Json) => r?.relationType === 'SOURCE_REPO'),
      links: (body.links ?? []).filter((l: Json) => l?.label === 'SOURCE_REPO'),
    };
  }
  if (url.includes('api.deps.dev') && url.includes('/projects/')) {
    const sc = body.scorecard;
    return { projectKey: body.projectKey, ...(sc ? { scorecard: { date: sc.date, repository: sc.repository, overallScore: sc.overallScore, checks: (sc.checks ?? []).filter((c: Json) => c?.name === 'Maintained') } } : {}) };
  }
  if (url.includes('securityscorecards') || url.includes('scorecard')) {
    return { score: body.score, date: body.date, repo: body.repo, checks: (body.checks ?? []).filter((c: Json) => c?.name === 'Maintained') };
  }
  return null;
}

if (process.argv[1]?.endsWith('record-tier05-pypi.ts')) {
  const [slug, target] = process.argv.slice(2);
  if (!slug || !target) throw new Error('usage: record-tier05-pypi.ts <slug> <target checkout>');
  await installEnvProxy();
  const { scan } = await import('../../src/pipeline.js');
  const { createDepsDevEnricher } = await import('../../src/enrich/depsdev/index.js');
  const { createPypiEnricher } = await import('../../src/enrich/pypi/index.js');
  const recordedAt = new Date();
  const ingested = await scan({ target, formats: [], offline: true, cacheDir: false, enrichers: () => [] });
  const inv = ingested.inventory;
  const pypi = new Set(inv.components.filter((c) => c.ecosystem === 'pypi').map((c) => c.purl));
  const edges = inv.edges.filter((e) => pypi.has(e.to));
  const assets = new Set(edges.map((e) => e.from));
  const inventory: Inventory = { assets: inv.assets.filter((a) => assets.has(a.id)), components: inv.components.filter((c) => pypi.has(c.purl)), edges };
  const responses: Record<string, Json | null> = {};
  const http = new HttpClient({ cacheDir: false });
  const orig = http.fetchJsonOrNull.bind(http);
  http.fetchJsonOrNull = (async (url: string, o?: any) => {
    const r = await orig(url, o);
    responses[url] = trimResponse(url, r as Json | null);
    return r;
  }) as typeof http.fetchJsonOrNull;
  const ctx = { http, now: recordedAt, offline: false, warn: (m: string) => console.log(`  warn: ${m}`) };
  await createDepsDevEnricher({ dependents: false }).enrich(inventory, ctx);
  await createPypiEnricher().enrich(inventory, ctx);
  const out: Tier05PypiFixture = {
    _note: `Recorded live ${recordedAt.toISOString()} by test/stability/record-tier05-pypi.ts from ${slug} (inventory ingested offline from the checkout): deps.dev, Scorecard and PyPI responses trimmed to the fields the enrichers read.`,
    recordedAt: recordedAt.toISOString(),
    target: slug,
    inventory,
    responses,
  };
  writeFileSync(join(STABILITY_DIR, `tier05-pypi-${slug}.json.gz`), gzipSync(`${JSON.stringify(out)}\n`));
  console.log(`  ${slug}: ${inventory.components.length} PyPI components, ${Object.keys(responses).length} responses`);
}
