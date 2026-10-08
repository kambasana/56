/**
 * /api/sources (repo connectors, docs/CONNECTORS.md) and /api/hooks/github.
 *
 * Every /api/sources route needs manage_projects in the org. The install callback has no session
 * (GitHub's redirect is cross-site, and the session cookie is SameSite=Strict): it is trusted only
 * through the signed single-use state, the creator's current permission, and the OAuth code.
 * The webhook has no session either: only a valid X-Hub-Signature-256 gets it processed.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type {
  GetSourceResponse,
  ListSourceReposResponse,
  ListSourcesResponse,
  OkResponse,
  StartSourceInstallResponse,
  UpdateSourceRepoResponse,
  WebhookAcceptedResponse,
} from '../api-types.js';
import { SOURCE_HOSTS } from '../api-types.js';
import { deps, requireOrgPerm, type AppEnv, type Ctx } from '../context.js';
import { badRequest, errorResponse } from '../errors.js';
import { idParam, parseBody, readBodyBytes } from '../request.js';
import { InstallError } from '../sources/service.js';
import { SourceAccessError } from '../sources/types.js';
import { getSource, getSourceRepo, isStoreError, listSourceRepos, listSources, publicRepo, publicSource, setSourceRepoWatching, updateSourceSettings } from '../store/index.js';

const StartBody = z.strictObject({ host: z.enum(SOURCE_HOSTS), autoWatch: z.boolean().optional() });
const UpdateSourceBody = z.strictObject({ autoWatch: z.boolean() });
const UpdateRepoBody = z.strictObject({ watching: z.boolean() });

/** GitHub caps webhook payloads at 25 MB. */
const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

function sourceInOrg(c: Ctx) {
  const id = idParam(c, 'id');
  const { session, orgId } = requireOrgPerm(c, 'manage_projects');
  const source = getSource(deps(c).store, orgId, id);
  if (!source) return { session, orgId, source: null };
  return { session, orgId, source };
}

export function registerSourceRoutes(app: Hono<AppEnv>): void {
  app.get('/api/sources', (c) => {
    const { orgId } = requireOrgPerm(c, 'manage_projects');
    const { store, sources } = deps(c);
    return c.json<ListSourcesResponse>({
      configured: { github: sources.configured('github') },
      items: listSources(store, orgId).map(publicSource),
      webhooks: { rejected: sources.rejectedDeliveries },
    });
  });

  /** Start an install: returns the host's install URL carrying a signed, single-use state. */
  app.post('/api/sources', async (c) => {
    const { session, orgId } = requireOrgPerm(c, 'manage_projects');
    const body = await parseBody(c, StartBody);
    const { sources } = deps(c);
    if (!sources.configured(body.host)) throw badRequest('The GitHub App is not configured on this server (BLASTRADIUS_GITHUB_APP_ID, _PRIVATE_KEY, _WEBHOOK_SECRET)', ['host']);
    const out = await sources.startInstall(orgId, session.user.id, body.autoWatch ?? true);
    return c.json<StartSourceInstallResponse>({ source: publicSource(out.source), installUrl: out.installUrl, expiresAt: out.expiresAt }, 201);
  });

  /**
   * GitHub's Setup URL (also the OAuth callback): ?installation_id=&setup_action=&state=&code=.
   * Redirects to the web app's Sources page with the outcome.
   */
  app.get('/api/sources/github/callback', async (c) => {
    const { sources } = deps(c);
    const q = (k: string) => {
      const v = c.req.query(k);
      return v && v.length <= 600 ? v : undefined;
    };
    const state = q('state');
    const installationId = q('installation_id');
    const back = (params: Record<string, string>) => c.redirect(`/sources?${new URLSearchParams(params).toString()}`, 302);
    if (q('setup_action') === 'request') return back({ install: 'requested' });
    // Repo selection changed in GitHub's settings: the installation_repositories webhook carries it.
    if (q('setup_action') === 'update' && !state) return back({ install: 'updated' });
    if (!state || !installationId) return back({ install: 'failed', reason: 'GitHub did not send the installation back' });
    try {
      const source = await sources.completeInstall({ state, installationId, code: q('code') });
      return back({ install: 'connected', source: source.id });
    } catch (err) {
      if (err instanceof InstallError) return back({ install: 'failed', reason: err.message });
      if (err instanceof SourceAccessError) return back({ install: 'failed', reason: 'GitHub could not confirm the installation' });
      if (isStoreError(err) && err.code !== 'bad_request') return back({ install: 'failed', reason: err.message });
      throw err;
    }
  });

  app.get('/api/sources/:id', (c) => {
    const { source } = sourceInOrg(c);
    if (!source) return errorResponse(c, 'not_found', 'Source not found');
    return c.json<GetSourceResponse>(publicSource(source));
  });

  app.patch('/api/sources/:id', async (c) => {
    const { session, orgId, source } = sourceInOrg(c);
    if (!source) return errorResponse(c, 'not_found', 'Source not found');
    const body = await parseBody(c, UpdateSourceBody);
    const out = updateSourceSettings(deps(c).store, orgId, source.id, { autoWatch: body.autoWatch }, session.user.id);
    return c.json<GetSourceResponse>(publicSource(out));
  });

  /** Disconnect: stop watching; projects and history stay. */
  app.delete('/api/sources/:id', (c) => {
    const { session, source } = sourceInOrg(c);
    if (!source) return errorResponse(c, 'not_found', 'Source not found');
    deps(c).sources.disconnect(source, session.user.id);
    return c.json<OkResponse>({ ok: true });
  });

  /** Re-check with the host now (restores a source whose access came back, or marks it lost). */
  app.post('/api/sources/:id/check', async (c) => {
    const { session, source } = sourceInOrg(c);
    if (!source) return errorResponse(c, 'not_found', 'Source not found');
    const out = await deps(c).sources.check(source.id, session.user.id);
    return c.json<GetSourceResponse>(publicSource(out));
  });

  app.get('/api/sources/:id/repos', (c) => {
    const { source } = sourceInOrg(c);
    if (!source) return errorResponse(c, 'not_found', 'Source not found');
    return c.json<ListSourceReposResponse>({ items: listSourceRepos(deps(c).store, source.id).map(publicRepo) });
  });

  app.patch('/api/sources/:id/repos/:repoId', async (c) => {
    const { session, orgId, source } = sourceInOrg(c);
    if (!source) return errorResponse(c, 'not_found', 'Source not found');
    const repo = getSourceRepo(deps(c).store, orgId, source.id, idParam(c, 'repoId'));
    if (!repo) return errorResponse(c, 'not_found', 'Repository not found');
    const body = await parseBody(c, UpdateRepoBody);
    if (body.watching && (repo.status === 'removed' || repo.status === 'access_lost')) {
      throw badRequest('The installation cannot read this repository: add it to the installation on GitHub first', ['watching']);
    }
    const out = setSourceRepoWatching(deps(c).store, repo, body.watching, session.user.id);
    if (body.watching && !repo.watching) deps(c).sources.watchTurnedOn(out, session.user.id);
    return c.json<UpdateSourceRepoResponse>(publicRepo(out));
  });

  // ---- Webhook -------------------------------------------------------------------
  app.post('/api/hooks/github', async (c) => {
    const { sources, log } = deps(c);
    const github = sources.github;
    if (!github) return errorResponse(c, 'not_found', 'No such API endpoint');
    const body = await readBodyBytes(c, MAX_WEBHOOK_BYTES);
    if (!github.verifyWebhook({ headers: c.req.raw.headers, body })) {
      sources.rejectedDeliveries++;
      log(`sources: dropped a GitHub delivery with a ${c.req.header('x-hub-signature-256') ? 'bad' : 'missing'} signature`);
      return errorResponse(c, 'unauthenticated', 'Invalid signature');
    }
    const deliveryId = c.req.header('x-github-delivery') ?? '';
    const event = c.req.header('x-github-event') ?? '';
    if (!/^[A-Za-z0-9-]{1,100}$/.test(deliveryId)) throw badRequest('Missing or invalid X-GitHub-Delivery');
    if (!/^[a-z_]{1,64}$/.test(event)) throw badRequest('Missing or invalid X-GitHub-Event');
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw badRequest('Malformed JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest('Malformed payload');
    const outcome = await sources.handleGitHubDelivery(deliveryId, event, payload as Record<string, unknown>);
    if (outcome === null) return c.json<WebhookAcceptedResponse>({ ok: true, duplicate: true, outcome: 'duplicate' }, 200);
    return c.json<WebhookAcceptedResponse>({ ok: true, duplicate: false, outcome }, 202);
  });
}
