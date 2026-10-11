/**
 * Licences API (docs/WEB-API.md "Licences"): the dev-seed scan of the e2e fixture repo, replayed
 * offline with recorded deps.dev / ClearlyDefined responses (test/fixtures/licenses/e2e-repo),
 * the org policy applied at read time, policy validation and permissions, and SBOM downloads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as CDX from '@cyclonedx/cyclonedx-library';
import { HttpClient } from '../core/http.js';
import { DEFAULT_LICENSE_POLICY } from '../licenses/policy.js';
import type { LicensePolicyResponse, LicensesResponse, ListAuditResponse } from './api-types.js';
import type { ScanResult } from '../core/types.js';
import { createServer, FIXTURE_AS_OF, FIXTURES_DIR, seedDevData } from './serve.js';
import { get, getScanResult } from './store/index.js';

type App = ReturnType<typeof createServer>;
const XRW = { 'X-Requested-With': 'blastradius' };

let srv: App;
let projectId: string;
let scanId: string;
const cookies: Record<string, string> = {};

async function call(method: string, path: string, opts: { as?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method !== 'GET' ? XRW : {}) };
  if (opts.as) headers.Cookie = `br_session=${cookies[opts.as]}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return srv.app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}

beforeAll(async () => {
  srv = createServer({
    devMode: true,
    offline: true,
    fixturesDir: FIXTURES_DIR,
    asOf: FIXTURE_AS_OF,
    webDir: null,
    scanOptions: {
      http: new HttpClient({ offline: true, fixturesDir: FIXTURES_DIR, cacheDir: false, minIntervalMs: 0, transport: async (r) => Promise.reject(new Error(`network in test: ${r.url}`)) }),
      cacheDir: false,
    },
    log: () => {},
  });
  const seed = await seedDevData(srv.deps);
  projectId = seed.projectId;
  scanId = seed.scanId!;
  await srv.jobs.waitFor(scanId);
  for (const u of ['admin', 'appsec', 'auditor']) {
    const res = await call('POST', '/api/auth/login', { body: { email: `${u}@local`, password: 'blastradius-dev' } });
    expect(res.status).toBe(200);
    cookies[u] = /br_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  }
}, 60_000);

afterAll(() => srv.jobs.stop());

describe('licences in the stored scan', () => {
  it('keeps every component licence with its source, replayed without network', () => {
    const orgId = get<{ org_id: string }>(srv.store, 'SELECT org_id FROM scan WHERE id = ?', scanId)!.org_id;
    const result: ScanResult = getScanResult(srv.store, orgId, scanId)!.result;
    expect(result.licenses?.components).toHaveLength(12);
    // The two GitHub Actions have no package metadata, and a replay does not use today's
    // repository licence: unknown, counted, never allowed by default.
    expect(result.licenses!.components.filter((c) => c.ecosystem === 'githubactions').map((c) => [c.source, c.category])).toEqual([
      ['none', 'unknown'],
      ['none', 'unknown'],
    ]);
    expect(result.warnings?.filter((w) => w.startsWith('licenses:'))).toEqual([]);
    const ms = result.licenses!.components.find((c) => c.name === 'ms')!;
    expect(ms).toMatchObject({ expressions: ['MIT'], category: 'permissive', source: 'depsdev' });
    expect(ms.sources.map((s) => s.source)).toEqual(['depsdev', 'clearlydefined']);
    // event-stream 3.3.6 has no licence on deps.dev; ClearlyDefined's curated value is shown, with its source.
    expect(result.licenses!.components.find((c) => c.name === 'event-stream')).toMatchObject({ source: 'clearlydefined', expressions: ['MIT'] });
  });
});

describe('GET /api/licenses', () => {
  it('lists the project licences with the default policy applied', async () => {
    const res = await call('GET', `/api/licenses?project=${projectId}`, { as: 'appsec' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LicensesResponse;
    expect(body.scope).toBe('project');
    expect(body.policyIsDefault).toBe(true);
    expect(body.counts.components).toBe(12);
    expect(body.counts.byCategory).toMatchObject({ permissive: 10, unknown: 2 });
    expect(body.counts.byDecision).toEqual({ allow: 10, review: 2, deny: 0 });
    expect(body.rows.find((r) => r.name === 'actions/checkout')).toMatchObject({ decision: 'review', rule: 'unknown: no licence declared' });
    expect(body.rows.find((r) => r.name === 'through')).toMatchObject({ decision: 'allow', rule: 'category Permissive (MIT)', projects: [{ id: projectId }] });
    expect(body.note).toMatch(/not legal advice/);
    expect(body.classification.map((c) => c.license)).toEqual(['CC0-1.0', 'CC0-1.0', 'CC-BY-4.0']);
  });

  it('is org-wide without a project and needs the exposure page', async () => {
    const org = (await (await call('GET', '/api/licenses', { as: 'auditor' })).json()) as LicensesResponse;
    expect(org.scope).toBe('org');
    expect(org.scans.map((s) => s.project.id)).toContain(projectId);
    expect((await call('GET', '/api/licenses')).status).toBe(401);
  });
});

describe('licence policy', () => {
  it('applies a saved policy at once, audits it, and resets to the default', async () => {
    const denyPermissive = { ...DEFAULT_LICENSE_POLICY, categories: { ...DEFAULT_LICENSE_POLICY.categories, permissive: 'review' }, ids: [{ id: 'MIT', decision: 'deny' }] };
    const put = await call('PUT', '/api/license-policy', { as: 'admin', body: denyPermissive });
    expect(put.status).toBe(200);
    expect(((await put.json()) as LicensePolicyResponse).isDefault).toBe(false);
    const body = (await (await call('GET', `/api/licenses?project=${projectId}`, { as: 'appsec' })).json()) as LicensesResponse;
    expect(body.policyIsDefault).toBe(false);
    expect(body.rows.find((r) => r.name === 'ms')).toMatchObject({ decision: 'deny', rule: 'licence MIT' });
    // "MIT OR Apache-2.0" from ClearlyDefined is not the value shown (deps.dev says MIT), so the
    // decision follows the shown value; the HTML report uses the same policy.
    const html = await (await call('GET', `/api/reports/${scanId}.html`, { as: 'admin' })).text();
    expect(html).toContain('Policy: org policy');
    expect(html).toContain('licence MIT');
    const audit = (await (await call('GET', '/api/audit', { as: 'admin' })).json()) as ListAuditResponse;
    expect(audit.items.some((e) => e.action === 'license_policy.update')).toBe(true);
    const reset = (await (await call('DELETE', '/api/license-policy', { as: 'admin' })).json()) as LicensePolicyResponse;
    expect(reset).toMatchObject({ isDefault: true, policy: DEFAULT_LICENSE_POLICY });
  });

  it('rejects an invalid policy with the field, and an allowed unknown', async () => {
    const bad = await call('PUT', '/api/license-policy', { as: 'admin', body: { ...DEFAULT_LICENSE_POLICY, categories: { ...DEFAULT_LICENSE_POLICY.categories, unknown: 'allow' } } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toMatch(/categories\.unknown/);
    expect((await call('PUT', '/api/license-policy', { as: 'admin', body: { version: 2 } })).status).toBe(400);
  });

  it('needs manage_projects to change, any reader to read', async () => {
    expect((await call('PUT', '/api/license-policy', { as: 'appsec', body: DEFAULT_LICENSE_POLICY })).status).toBe(403);
    expect((await call('DELETE', '/api/license-policy', { as: 'auditor' })).status).toBe(403);
    expect((await call('GET', '/api/license-policy', { as: 'auditor' })).status).toBe(200);
  });
});

describe('SBOM downloads', () => {
  it('serves a CycloneDX 1.6 SBOM with licences that validates against the schema', async () => {
    const res = await call('GET', `/api/reports/${scanId}.cdx.json`, { as: 'auditor' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/vnd\.cyclonedx\+json/);
    expect(res.headers.get('content-disposition')).toContain(`blastradius-${scanId}.cdx.json`);
    const text = await res.text();
    expect(await new CDX.Validation.JsonStrictValidator(CDX.Spec.Version.v1dot6).validate(text)).toBeNull();
    const bom = JSON.parse(text) as { components: { name: string; licenses?: unknown[] }[] };
    expect(bom.components.find((c) => c.name === 'ms')?.licenses).toEqual([{ license: { id: 'MIT', acknowledgement: 'declared' } }]);
  });

  it('serves an SPDX 2.3 SBOM', async () => {
    const res = await call('GET', `/api/reports/${scanId}.spdx.json`, { as: 'auditor' });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { spdxVersion: string; packages: { name: string; licenseDeclared: string }[] };
    expect(doc.spdxVersion).toBe('SPDX-2.3');
    expect(doc.packages.find((p) => p.name === 'ms')?.licenseDeclared).toBe('MIT');
    expect((await call('GET', `/api/reports/${scanId}.xml`, { as: 'auditor' })).status).toBe(404);
  });
});
