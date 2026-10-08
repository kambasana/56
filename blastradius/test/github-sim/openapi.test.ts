/**
 * Simulator honesty (no network): every REST response the simulator gives, on every endpoint it
 * implements, validates against GitHub's OpenAPI description (@octokit/openapi, pinned); every
 * webhook it sends has the shape of the @octokit/webhooks-examples payload it was built from, no
 * example data left in it, and a valid X-Hub-Signature-256.
 */
import { createSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitHubAdapter, verifyGitHubSignature } from '../../src/server/sources/github.js';
import { openApi, shapeDiff } from './honesty.js';
import { GitHubSim } from './sim.js';
import { exampleFor } from './webhooks.js';

vi.setConfig({ testTimeout: 60_000 });

const received: { headers: Record<string, string>; body: string }[] = [];
let hook: Server;
let hookUrl = '';
const sim = new GitHubSim({ capture: true });

async function api(path: string, opts: { token?: string; accept?: string; method?: string; body?: unknown; basic?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: opts.accept ?? 'application/vnd.github+json' };
  if (opts.token) headers.authorization = `token ${opts.token}`;
  if (opts.basic) headers.authorization = `Basic ${opts.basic}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${sim.urls.api}${path}`, { method: opts.method ?? 'GET', headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}

let installationId = 0;
let adapter: GitHubAdapter;

beforeAll(async () => {
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body });
      res.writeHead(202).end('{}');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  await sim.start();
  sim.hookUrl = hookUrl;
  sim.callbackUrl = `${hookUrl}/callback`;
  sim.addOrg('acme-sim');
  sim.addOrg('other-org', ['other-admin']);
  await sim.createRepo('acme-sim', 'a11y-map', { from: 'Esri/a11y-map' });
  await sim.createRepo('acme-sim', 'mocha', { from: 'mochajs/mocha' });
  await sim.createRepo('acme-sim', 'private-app', { files: { 'package.json': '{"name":"p","version":"1.0.0"}\n', 'docs/a.md': '# a\n' }, private: true });
  await sim.createRepo('other-org', 'secret', { from: 'telefonicaid/logops', private: true });
  const env = sim.env();
  adapter = new GitHubAdapter({ appId: env.BLASTRADIUS_GITHUB_APP_ID, privateKey: env.BLASTRADIUS_GITHUB_PRIVATE_KEY, webhookSecret: env.BLASTRADIUS_GITHUB_WEBHOOK_SECRET, clientId: env.BLASTRADIUS_GITHUB_CLIENT_ID, clientSecret: env.BLASTRADIUS_GITHUB_CLIENT_SECRET, apiUrl: env.BLASTRADIUS_GITHUB_API_URL, webUrl: env.BLASTRADIUS_GITHUB_WEB_URL });
}, 60_000);

afterAll(async () => {
  await sim.close();
  await new Promise<void>((r) => hook.close(() => r()));
});

describe('GitHub simulator: the install flow and the adapter, end to end over HTTP', () => {
  it('install page → callback with installation_id, setup_action, state and code', async () => {
    const start = await adapter.installUrl('st4te');
    expect(start).toBe(`${sim.urls.web}/apps/blastradius-sim/installations/new?state=st4te`);
    const pick = await (await fetch(start)).text();
    const href = /data-account="acme-sim" href="([^"]+)"/.exec(pick)![1]!.replace(/&amp;/g, '&');
    const page = await (await fetch(new URL(href, sim.urls.web))).text();
    expect(page).toContain('<title>Install Blastradius (simulated) on acme-sim: all repos / selected</title>');
    const ids = [...page.matchAll(/name="repository_ids" value="(\d+)"/g)].map((m) => m[1]!);
    const form = new URLSearchParams({ state: 'st4te', target_id: /name="target_id" value="(\d+)"/.exec(page)![1]!, repository_selection: 'selected' });
    for (const id of ids.slice(0, 2)) form.append('repository_ids', id);
    const res = await fetch(`${sim.urls.web}/apps/blastradius-sim/installations`, { method: 'POST', body: form, redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${hookUrl}/callback`);
    expect([...loc.searchParams.keys()]).toEqual(['code', 'installation_id', 'setup_action', 'state']);
    expect(loc.searchParams.get('setup_action')).toBe('install');
    expect(loc.searchParams.get('state')).toBe('st4te');
    installationId = Number(loc.searchParams.get('installation_id'));
    // The code proves the installer can see this installation, and nothing else.
    expect(await adapter.installerCanSee(loc.searchParams.get('code')!, String(installationId))).toBe(true);
    expect(await adapter.installerCanSee(loc.searchParams.get('code')!, String(installationId))).toBe(false); // single use
    const otherInst = (await sim.install('other-org', 'all', [], 'other-admin')).installation.id;
    expect(await adapter.installerCanSee(sim.issueCode(), String(otherInst))).toBe(false);
    expect(sim.userTokensRevoked).toBe(2);
  });

  it('the adapter lists, reads trees and files through installation tokens, all revoked', async () => {
    const inst = await adapter.getInstallation(String(installationId));
    expect(inst).toMatchObject({ account: 'acme-sim', repositorySelection: 'selected', suspended: false });
    const repos = await adapter.listRepos(String(installationId));
    expect(repos.map((r) => r.fullName).sort()).toEqual(['acme-sim/a11y-map', 'acme-sim/mocha']);
    expect(await adapter.getRepo(String(installationId), 'other-org/secret')).toBeNull();
    const listing = await adapter.findLockfiles(String(installationId), 'acme-sim/mocha', 'main');
    expect(listing.commit).toBe('a9fc5296831641fbbcc8862e561e498549d840dc');
    const files = await adapter.readFiles(String(installationId), 'acme-sim/mocha', listing.commit, listing.files.map((f) => f.path));
    expect(files.size).toBe(29);
    // A fresh adapter has no blob ids remembered: it reads through the contents API (raw).
    const env = sim.env();
    const cold = new GitHubAdapter({ appId: env.BLASTRADIUS_GITHUB_APP_ID, privateKey: env.BLASTRADIUS_GITHUB_PRIVATE_KEY, webhookSecret: env.BLASTRADIUS_GITHUB_WEBHOOK_SECRET, apiUrl: env.BLASTRADIUS_GITHUB_API_URL });
    const raw = await cold.readFiles(String(installationId), 'acme-sim/a11y-map', 'main', ['package.json']);
    expect(Buffer.from(raw.get('package.json')!).toString('utf8')).toBe(sim.readFile('acme-sim/a11y-map', 'package.json'));
    expect(sim.tokensRevoked).toBe(sim.tokensMinted);
  });

  it('the remaining endpoints and error answers, called directly', async () => {
    const tok = async (id: number) => ((await (await fetch(`${sim.urls.api}/app/installations/${id}/access_tokens`, { method: 'POST', headers: { authorization: `Bearer ${await appJwt()}`, accept: 'application/vnd.github+json' } })).json()) as { token: string }).token;
    const appJwt = async () => {
      const now = Math.floor(Date.now() / 1000);
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const head = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 30, exp: now + 540, iss: sim.appMeta.id })}`;
      return `${head}.${createSign('RSA-SHA256').update(head).sign(sim.key.privateKey).toString('base64url')}`;
    };
    const jwt = await appJwt();
    expect((await api('/app/installations/999', { token: jwt })).status).toBe(404);
    const t = await tok(installationId);
    expect((await api('/repos/acme-sim/mocha/commits/main', { token: t })).status).toBe(200);
    expect((await api('/repos/acme-sim/mocha/commits/no-such-ref', { token: t })).status).toBe(422);
    expect((await api('/repos/acme-sim/mocha/git/trees/main', { token: t })).status).toBe(200);
    const tree = (await (await api('/repos/acme-sim/mocha/git/trees/main?recursive=1', { token: t })).json()) as { tree: { path: string; sha: string; type: string }[] };
    const sub = tree.tree.find((e) => e.type === 'tree')!;
    const subTree = (await (await api(`/repos/acme-sim/mocha/git/trees/${sub.sha}`, { token: t })).json()) as { sha: string };
    expect(subTree.sha).toBe(sub.sha);
    const pj = tree.tree.find((e) => e.path === 'package.json')!;
    expect((await api(`/repos/acme-sim/mocha/git/blobs/${pj.sha}`, { token: t })).status).toBe(200);
    expect((await api('/repos/acme-sim/mocha/contents/package.json', { token: t })).status).toBe(200);
    expect((await api('/repos/acme-sim/mocha/contents/lib', { token: t })).status).toBe(200);
    expect((await api('/repos/acme-sim/mocha/contents/nope.txt', { token: t })).status).toBe(404);
    expect((await api('/repos/other-org/secret', { token: t })).status).toBe(404);
    expect((await api('/installation/repositories?per_page=1', { token: t })).headers.get('link')).toMatch(/rel="last"/);
    expect((await api('/installation/repositories', { token: 'ghs_not_a_token' })).status).toBe(401);
    expect((await api('/installation/repositories')).status).toBe(401);
    // Public repos read without a token; private ones are 404 to strangers.
    expect((await api('/repos/acme-sim/a11y-map')).status).toBe(200);
    expect((await api('/repos/acme-sim/private-app')).status).toBe(404);
    expect((await fetch(`${sim.urls.raw}/acme-sim/a11y-map/main/package.json`)).status).toBe(200);
    // A suspended installation cannot mint tokens; an expired JWT is refused.
    await sim.suspend(installationId);
    const suspended = await fetch(`${sim.urls.api}/app/installations/${installationId}/access_tokens`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` } });
    expect(suspended.status).toBe(403);
    await sim.unsuspend(installationId);
    sim.advance(11 * 60_000);
    expect((await api('/app', { token: jwt })).status).toBe(401);
    sim.advance(-11 * 60_000);
    const basic = Buffer.from(`${sim.appMeta.clientId}:${sim.clientSecret}`).toString('base64');
    expect((await api(`/applications/${sim.appMeta.clientId}/token`, { method: 'DELETE', basic, body: { access_token: 'ghu_unknown' } })).status).toBe(422);
  });

  it("every response on every implemented endpoint validates against GitHub's OpenAPI description", () => {
    const oa = openApi();
    const failures: string[] = [];
    for (const c of sim.captured) {
      const { validate, documented } = oa.validator(c.method, c.route, c.status);
      if (!documented) {
        failures.push(`${c.method} ${c.route} → ${c.status}: status not in the OpenAPI description`);
        continue;
      }
      if (validate) {
        if (c.body === undefined) {
          // Media-type answers (sha, raw) are documented as alternatives to the JSON body.
          if (c.status !== 200 || !/vnd\.github\.(sha|raw)/.test(c.contentType)) failures.push(`${c.method} ${c.route} → ${c.status}: no JSON body`);
        } else if (!validate(c.body)) {
          failures.push(`${c.method} ${c.route} → ${c.status}: ${JSON.stringify(validate.errors?.slice(0, 5))}`);
        }
      } else if (c.body !== undefined) {
        failures.push(`${c.method} ${c.route} → ${c.status}: body where the description has none`);
      }
    }
    expect(failures).toEqual([]);
    // The validator is not vacuous: a repository without its id, or with a null owner, fails.
    const repoBody = sim.captured.find((c) => c.route === '/repos/{owner}/{repo}' && c.status === 200)!.body as Record<string, unknown>;
    const { id: _id, ...noId } = repoBody;
    expect(oa.validator('GET', '/repos/{owner}/{repo}', 200).validate!(noId)).toBe(false);
    expect(oa.validator('GET', '/repos/{owner}/{repo}', 200).validate!({ ...repoBody, owner: null })).toBe(false);
    // Every endpoint the simulator implements was exercised with a success answer.
    const routes = (sim as unknown as { routes: { method: string; template: string }[] }).routes;
    for (const r of routes) {
      expect(oa.spec.paths[r.template]?.[r.method.toLowerCase()], `${r.method} ${r.template} is in the description`).toBeDefined();
      expect(sim.captured.some((c) => c.method === r.method && c.route === r.template && c.status < 300 && c.body !== undefined) || r.method === 'DELETE', `${r.method} ${r.template} answered with JSON`).toBe(true);
      expect(sim.captured.some((c) => c.method === r.method && c.route === r.template && c.status < 300), `${r.method} ${r.template} succeeded`).toBe(true);
    }
  });

  it('webhooks: example shapes filled with simulator state, signed like GitHub', async () => {
    await sim.addRepoToInstallation(installationId, 'acme-sim/private-app');
    await sim.push('acme-sim/a11y-map', { bump: 'ua-parser-js@0.7.29' });
    await sim.revoke(installationId);
    const events = received.filter((r) => !r.headers['x-github-event']?.startsWith('x'));
    const seen = new Set<string>();
    for (const r of events) {
      const event = r.headers['x-github-event']!;
      const payload = JSON.parse(r.body) as Record<string, unknown>;
      const action = typeof payload.action === 'string' ? payload.action : null;
      seen.add(`${event}${action ? `.${action}` : ''}`);
      expect(verifyGitHubSignature(sim.webhookSecret, Buffer.from(r.body), r.headers['x-hub-signature-256']!)).toBe(true);
      expect(r.headers['x-github-delivery']).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.headers['x-github-hook-installation-target-type']).toBe('integration');
      const example = exampleFor(event, action, event === 'push' ? ['installation'] : []);
      expect(shapeDiff(example, payload), `${event}.${action}`).toEqual([]);
      expect(r.body, 'no example data left').not.toMatch(/Codertocat|Octocoders|Hello-World|octocat|api\.github\.com/);
    }
    expect([...seen].sort()).toEqual(['installation.created', 'installation.deleted', 'installation.suspend', 'installation.unsuspend', 'installation_repositories.added', 'push']);
  });
});
