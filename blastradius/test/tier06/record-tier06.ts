/**
 * Record the Tier 0.6 fixtures ONCE (needs network; never run in tests or CI):
 *   npx tsx test/tier06/record-tier06.ts
 * Output: test/fixtures/tier06/tier06.json.gz and test/fixtures/stability/recorded/history/tier06-<slug>.json.
 *
 *   (4) @great-expectations/jsonforms-antd-renderers 2.3.5 (superset's re-scan): its 2.2.8 S5a item.
 *       Trimmed packument (no e-mail addresses), deps.dev project, sibling answers, the history
 *       through the real collector with npm-publisher links, and which versions an npm publisher
 *       released from an address at the candidate organisation domain greatexpectations.io (only
 *       the yes/no per version is kept). The npm provenance attestations of the versions published
 *       in the 400 days before recording (SLSA statement payload only; the Sigstore certificate is
 *       dropped). GitHub's /orgs API (the organisation's verified domain) answered 403 from the
 *       recording session, so the test states that answer itself.
 *   (5) READMEs: aws-sdk (v2, "End-of-support") and tslint ("TSLint is deprecated"), from npm.
 *   (6) PyPI: click-plugins 1.1.1 and geographiclib 2.0 (superset), through the real enrichers.
 *   (7) The deprecated @types stub packages of the four re-scans, at the versions in use.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installEnvProxy } from '../../src/core/proxy.js';
import type { Inventory } from '../../src/core/types.js';
import { encodeFixture } from '../history/fixture.js';
import { STABILITY_DIR } from '../stability/fixture.js';
import { getJson, recordHistory, recordPackage, recordProject, type Json } from '../stability/record-lib.js';
import { trimResponse } from '../stability/record-tier05-pypi.js';

export const TIER06_DIR = join(import.meta.dirname, '..', 'fixtures', 'tier06');
export const JSONFORMS = { slug: 'jsonforms-antd-renderers', name: '@great-expectations/jsonforms-antd-renderers', version: '2.3.5', repo: 'https://github.com/great-expectations/jsonforms-antd-renderers', owner: 'great-expectations', domain: 'greatexpectations.io', asOf: '2026-10-12T23:28:56Z' };
export const STUBS: Record<string, string[]> = {
  '@types/long': ['4.0.2', '4.0.1'],
  '@types/mime': ['1.3.5'],
  '@types/parse-json': ['4.0.0', '4.0.2'],
  '@types/color-convert': ['2.0.4'],
  '@types/expect': ['1.20.4'],
  '@types/mapbox-gl': ['3.4.1'],
  '@types/pako': ['1.0.7', '2.0.4'],
};
export const PYPI = [
  { name: 'click-plugins', version: '1.1.1' },
  { name: 'geographiclib', version: '2.0' },
];
export const README_PACKAGES = ['aws-sdk', 'tslint'];

if (process.argv[1]?.endsWith('record-tier06.ts')) {
  await installEnvProxy();
  const { HttpClient } = await import('../../src/core/http.js');
  const { npmSiblingRelease, isAtDomain } = await import('../../src/enrich/history/index.js');
  const { createDepsDevEnricher } = await import('../../src/enrich/depsdev/index.js');
  const { createPypiEnricher } = await import('../../src/enrich/pypi/index.js');
  const { pypiPurl } = await import('../../src/ingest/python.js');
  const http = new HttpClient({ cacheDir: false });
  const recordedAt = new Date();
  const out: Json = { _note: `Recorded live ${recordedAt.toISOString()} by test/tier06/record-tier06.ts. npm packuments trimmed (no e-mail addresses), READMEs verbatim, PyPI / deps.dev responses trimmed as record-tier05-pypi.ts trims them, npm provenance statements (payload only).`, recordedAt: recordedAt.toISOString() };

  // (4) jsonforms-antd-renderers.
  const r = (await recordPackage(JSONFORMS.name, [JSONFORMS.version]))!;
  const entry: Json = r.pkg;
  const project = await recordProject(JSONFORMS.repo);
  if (project) entry.project = project;
  const siblings: Json = {};
  for (const account of [...r.emails.keys()].sort()) siblings[account] = (await npmSiblingRelease({ http }, account, JSONFORMS.owner, JSONFORMS.name)) ?? null;
  entry.siblings = { owner: JSONFORMS.owner, byAccount: siblings };
  const raw = (await getJson(`https://registry.npmjs.org/${JSONFORMS.name.replace('/', '%2f')}`)).body!;
  const orgVersions = Object.entries(raw.versions as Json).filter(([, m]) => typeof m?._npmUser?.email === 'string' && isAtDomain(m._npmUser.email, JSONFORMS.domain)).map(([v]) => v).sort();
  const provenance: Json = {};
  const since = recordedAt.getTime() - 400 * 86_400_000;
  for (const [v, t] of Object.entries(raw.time as Json)) {
    if (!raw.versions[v] || Date.parse(t) < since) continue;
    const a = await getJson(`https://registry.npmjs.org/-/npm/v1/attestations/${JSONFORMS.name.replace('/', '%2f')}@${v}`);
    provenance[v] = a.body ? { attestations: (a.body.attestations ?? []).map((x: Json) => ({ predicateType: x.predicateType, bundle: { dsseEnvelope: { payload: x.bundle?.dsseEnvelope?.payload, payloadType: x.bundle?.dsseEnvelope?.payloadType } } })) } : null;
  }
  entry.provenance = provenance;
  const cacheDir = mkdtempSync(join(process.env.BR_RECORD_TMP ?? tmpdir(), 'br-tier06-'));
  try {
    const rec = await recordHistory(JSONFORMS.repo, r.emails, randomBytes(32), cacheDir);
    if ('error' in rec) throw new Error(rec.error);
    rec.npmOrgDomain = JSONFORMS.domain;
    rec.npmOrgDomainVersions = orgVersions;
    writeFileSync(join(STABILITY_DIR, 'history', `tier06-${JSONFORMS.slug}.json`), `${JSON.stringify(encodeFixture(rec, `Recorded live ${recordedAt.toISOString()} by test/tier06/record-tier06.ts from ${JSONFORMS.repo}. Emails and display names hashed with a random salt that was discarded; npmOrgDomainVersions: versions whose npm publisher address is at ${JSONFORMS.domain} (addresses not kept).`, recordedAt))}\n`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
  out.jsonforms = entry;

  // (5) READMEs, verbatim.
  out.readmes = {};
  for (const n of README_PACKAGES) out.readmes[n] = (await getJson(`https://registry.npmjs.org/${n}`)).body?.readme ?? null;

  // (6) PyPI, through the real enrichers (responses trimmed).
  const asset = { id: 'repo:superset', kind: 'repo' as const, name: 'superset', environment: 'prod' as const, criticality: 3 as const, sourceFile: 'requirements/base.txt' };
  const inventory: Inventory = { assets: [asset], components: PYPI.map((p) => ({ purl: pypiPurl(p.name, p.version), ecosystem: 'pypi' as const, name: p.name, version: p.version })), edges: PYPI.map((p) => ({ from: asset.id, to: pypiPurl(p.name, p.version), scope: 'runtime' as const, direct: true })) };
  const responses: Json = {};
  const orig = http.fetchJsonOrNull.bind(http);
  http.fetchJsonOrNull = (async (url: string, o?: any) => {
    const res = await orig(url, o);
    responses[url] = trimResponse(url, res as Json | null);
    return res;
  }) as typeof http.fetchJsonOrNull;
  const ctx = { http, now: recordedAt, offline: false, warn: (m: string) => console.log(`  warn: ${m}`) };
  await createDepsDevEnricher({ dependents: false }).enrich(inventory, ctx);
  await createPypiEnricher().enrich(inventory, ctx);
  http.fetchJsonOrNull = orig;
  out.pypi = { inventory, responses };

  // (7) @types stubs.
  out.stubs = {};
  for (const [n, vs] of Object.entries(STUBS)) out.stubs[n] = (await recordPackage(n, vs))!.pkg;

  mkdirSync(TIER06_DIR, { recursive: true });
  writeFileSync(join(TIER06_DIR, 'tier06.json.gz'), gzipSync(`${JSON.stringify(out)}\n`));
  console.log(`  org-domain versions: ${orgVersions.join(', ')}; provenance for ${Object.keys(provenance).length} versions; PyPI responses ${Object.keys(responses).length}`);
}
