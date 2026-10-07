/**
 * RBAC at the API, per role, against real project/scan/finding ids (PLAN §12 and the endpoint
 * table in docs/WEB-API.md): every read answers 200 exactly when the role holds the page
 * permission and 403 otherwise; every write is refused with 403 for roles without the action,
 * and for the admin reaches validation (400/404/409) without changing anything. CSRF and
 * signed-out requests are refused too. Direct-URL page checks per role live in the crawl.
 */
import { expect, request, test } from '@playwright/test';
import { BASE_URL, ROLES, userFor, type Role } from './lib/env';
import { api, Check, getJson, scannedProjects } from './lib/feature';
import { ROLE_PAGES } from './lib/session';

type Need = { any: string[] } | 'auth';

function allowed(role: Role, need: Need): boolean {
  if (need === 'auth') return true;
  if (role === 'admin') return true;
  return need.any.some((p) => (ROLE_PAGES[role] as readonly string[]).includes(p));
}

for (const role of ROLES) {
  test(`API permissions: ${role}`, async () => {
    const c = new Check(`api matrix`, role, 'light', undefined, 'rbac');
    const p = scannedProjects().find((x) => x.topFindingId)!;
    const admin = await api('admin');
    const scans = await getJson<{ items: { id: string }[] }>(admin, `/api/projects/${encodeURIComponent(p.id)}/scans?limit=1`);
    await admin.dispose();
    const pid = encodeURIComponent(p.id);
    const fid = encodeURIComponent(p.topFindingId!);
    const purl = encodeURIComponent(p.topFindingPurl!);
    const sid = scans.items[0]!.id;
    const reads: [string, Need][] = [
      ['/api/me', 'auth'],
      ['/api/orgs', 'auth'],
      ['/api/home', { any: ['home'] }],
      [`/api/projects/${pid}`, { any: ['projects', 'home'] }],
      [`/api/projects/${pid}/scans`, { any: ['scans'] }],
      [`/api/scans/${sid}`, { any: ['scans'] }],
      [`/api/findings?project=${pid}&limit=1`, { any: ['findings'] }],
      [`/api/findings/${fid}`, { any: ['findings'] }],
      [`/api/exposure?project=${pid}`, { any: ['exposure'] }],
      [`/api/changes?project=${pid}`, { any: ['changes'] }],
      [`/api/graph?finding=${fid}`, { any: ['investigate', 'findings'] }],
      [`/api/graph?project=${pid}&node=${purl}`, { any: ['investigate'] }],
      [`/api/investigate/search?project=${pid}&q=${encodeURIComponent(p.topFindingPurl!.slice(8, 12))}`, { any: ['investigate'] }],
      [`/api/investigate/node?project=${pid}&id=${purl}`, { any: ['investigate'] }],
      ['/api/reports', { any: ['reports'] }],
      [`/api/reports/${sid}.json`, { any: ['reports'] }],
      [`/api/reports/${sid}.sarif`, { any: ['reports'] }],
      ['/api/integrations', { any: ['integrations'] }],
      ['/api/roles', { any: ['settings'] }],
      ['/api/bindings', { any: ['settings'] }],
      ['/api/members', { any: ['settings'] }],
      ['/api/audit', { any: ['settings'] }],
    ];
    const ctx = await api(role);
    for (const [path, need] of reads) {
      const r = await ctx.get(path);
      const want = allowed(role, need) ? 200 : 403;
      if (r.status() !== want) c.fail(`GET ${path.split('?')[0]} -> ${r.status()}, expected ${want}`);
    }
    // /api/projects is filtered rather than refused.
    const list = await ctx.get('/api/projects?limit=500');
    if (list.status() !== 200) c.fail(`GET /api/projects -> ${list.status()}`);
    else {
      const n = ((await list.json()) as { items: unknown[] }).items.length;
      if (role === 'auditor' && n !== 0) c.fail(`auditor sees ${n} projects in GET /api/projects`);
      if (role !== 'auditor' && n === 0) c.fail(`${role} sees no projects`);
    }

    // Writes go to a throwaway project, so a broken permission check cannot damage a scenario.
    const adm = await api('admin');
    const tmp = await adm.post('/api/projects', { data: { name: `hammer-rbac-${role}-${Date.now()}`, tier: 'Small', target: 'https://github.com/telefonicaid/logops' } });
    if (tmp.status() !== 201) throw new Error(`create throwaway project: HTTP ${tmp.status()} ${await tmp.text()}`);
    const tid = encodeURIComponent(((await tmp.json()) as { id: string }).id);
    // Writes. For the admin each body is invalid on purpose: the permission check passes and
    // validation refuses it, so nothing changes. Others must get 403 before validation.
    // Non-admins send VALID bodies (a real attempt; any 2xx is a permission bypass and fails
    // loudly). The admin sends invalid ones (validation refuses them, nothing changes).
    const valid = role !== 'admin';
    const writes: { method: 'post' | 'patch' | 'delete'; path: string; data?: unknown; adminWant: number[]; skipAdmin?: boolean }[] = [
      { method: 'post', path: '/api/projects', data: valid ? { name: `hammer-rbac-bypass-${role}`, tier: 'Small', target: 'https://github.com/telefonicaid/logops' } : {}, adminWant: [400] },
      { method: 'patch', path: `/api/projects/${tid}`, data: valid ? { owner: 'hammer rbac' } : { tier: 'Gigantic' }, adminWant: [400] },
      { method: 'delete', path: `/api/projects/${tid}`, adminWant: [], skipAdmin: true },
      { method: 'post', path: `/api/projects/${tid}/scans`, data: valid ? {} : { bogus: true }, adminWant: [400] },
      { method: 'patch', path: `/api/findings/${fid}`, data: valid ? { status: 'reviewed', note: 'hammer rbac' } : { status: 'bogus' }, adminWant: [400] },
      { method: 'patch', path: `/api/findings/${fid}`, data: valid ? { status: 'accepted_risk', note: 'hammer rbac' } : { status: 'bogus' }, adminWant: [400] },
      { method: 'post', path: '/api/roles', data: valid ? { name: `hammer-rbac-${role}`, template: 'auditor' } : {}, adminWant: [400] },
      { method: 'patch', path: '/api/roles/appsec', data: valid ? { description: 'hammer rbac' } : { permissions: 'all' }, adminWant: [400] },
      { method: 'post', path: '/api/roles/appsec/reset', adminWant: [], skipAdmin: true },
      { method: 'delete', path: '/api/roles/appsec', adminWant: [409] },
      { method: 'post', path: '/api/bindings', data: valid ? { roleId: 'org_admin', subject: { kind: 'group', group: `hammer-rbac-${role}` }, scope: { kind: 'org' } } : {}, adminWant: [400] },
      { method: 'delete', path: '/api/bindings/no-such-binding', adminWant: [404] },
      { method: 'post', path: '/api/members', data: valid ? { email: `hammer-rbac-${role}-${Date.now()}@hammer.test`, name: 'RBAC probe', bindings: [{ roleId: 'org_admin', scope: { kind: 'org' } }] } : {}, adminWant: [400] },
    ];
    for (const wr of writes) {
      if (role === 'admin' && wr.skipAdmin) continue;
      const r = await ctx[wr.method](wr.path, wr.data !== undefined ? { data: wr.data } : {});
      const want = role === 'admin' ? wr.adminWant : [403];
      if (!want.includes(r.status())) c.fail(`${wr.method.toUpperCase()} ${wr.path} -> ${r.status()}, expected ${want.join('/')}`);
    }
    const del = await adm.delete(`/api/projects/${tid}`);
    if (!del.ok()) c.fail(`admin DELETE of the throwaway project -> ${del.status()}`);
    await adm.dispose();
    await ctx.dispose();
    c.done();
  });
}

test('CSRF and signed-out requests are refused', async () => {
  const c = new Check('csrf + unauthenticated', 'admin', 'light', undefined, 'rbac');
  const noHeader = await request.newContext({ baseURL: BASE_URL, storageState: userFor('admin').storageState });
  const r1 = await noHeader.post('/api/projects', { data: {} });
  if (r1.status() !== 403) c.fail(`POST without X-Requested-With -> ${r1.status()}, expected 403 csrf`);
  else expect(((await r1.json()) as { error: { code: string } }).error.code).toBe('csrf');
  const r2 = await noHeader.post('/api/projects', { data: {}, headers: { 'X-Requested-With': 'blastradius', Origin: 'https://evil.example' } });
  if (r2.status() !== 403) c.fail(`POST with a foreign Origin -> ${r2.status()}, expected 403`);
  await noHeader.dispose();
  const anon = await request.newContext({ baseURL: BASE_URL });
  for (const path of ['/api/me', '/api/home', '/api/projects', '/api/reports', '/api/audit']) {
    const r = await anon.get(path);
    if (r.status() !== 401) c.fail(`signed-out GET ${path} -> ${r.status()}, expected 401`);
  }
  const h = await anon.get('/api/health');
  if (h.status() !== 200) c.fail(`GET /api/health -> ${h.status()}`);
  await anon.dispose();
  c.done();
});
