/**
 * The Hono app: /api routes (docs/WEB-API.md) plus the built SPA. Create it with createApp();
 * tests drive it through app.request() without opening a port.
 */
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv, ServerDeps } from './context.js';
import { resolveOrgId } from './context.js';
import { errorResponse, toErrorResponse } from './errors.js';
import { registerAuthRoutes, SESSION_COOKIE } from './routes/auth.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerIncidentRoutes } from './routes/incidents.js';
import { registerFindingRoutes } from './routes/findings.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerTriageRoutes } from './routes/triage.js';
import { resolveStatic, SPA_CSP, staticBody } from './static.js';
import { getSession, setSessionOrg } from './store/index.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** CSRF rule: mutating /api requests need X-Requested-With, and a present Origin must be this host. */
export function csrfProblem(method: string, headers: { get(name: string): string | null }, requestUrl: string): string | null {
  if (!MUTATING.has(method.toUpperCase())) return null;
  const xrw = headers.get('x-requested-with');
  if (!xrw || xrw.trim() === '') return 'Missing X-Requested-With header';
  const origin = headers.get('origin');
  if (origin !== null) {
    let originHost: string;
    try {
      const u = new URL(origin);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Cross-origin request refused';
      originHost = u.host.toLowerCase();
    } catch {
      return 'Cross-origin request refused';
    }
    const host = (headers.get('host') ?? new URL(requestUrl).host).toLowerCase();
    if (originHost !== host) return 'Cross-origin request refused';
  }
  return null;
}

export function createApp(deps: ServerDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('session', null);
    c.set('access', new Map());
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
  });

  app.use('/api/*', async (c, next) => {
    // Host webhooks carry no cookie and no X-Requested-With; they are authenticated by signature
    // (routes/sources.ts) and never see a session.
    if (new URL(c.req.url).pathname.startsWith('/api/hooks/')) return next();
    const problem = csrfProblem(c.req.method, c.req.raw.headers, c.req.url);
    if (problem) return errorResponse(c, 'csrf', problem);
    const token = getCookie(c, SESSION_COOKIE);
    const info = token ? getSession(deps.store, token) : null;
    if (info && token) {
      const orgId = resolveOrgId(deps.store, info.user.id, info.orgId);
      if (orgId !== info.orgId) setSessionOrg(deps.store, token, orgId);
      c.set('session', { token, user: info.user, orgId });
    }
    await next();
    c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
  });

  registerAuthRoutes(app);
  registerProjectRoutes(app);
  // Before the finding routes: /api/findings/packages must not match /api/findings/:id.
  registerTriageRoutes(app);
  registerFindingRoutes(app);
  registerAlertRoutes(app);
  registerIncidentRoutes(app);
  registerAccountRoutes(app);
  registerReportRoutes(app);
  registerSettingsRoutes(app);
  registerSourceRoutes(app);

  app.all('/api/*', (c) => errorResponse(c, 'not_found', 'No such API endpoint'));
  app.all('/api', (c) => errorResponse(c, 'not_found', 'No such API endpoint'));

  app.on(['GET', 'HEAD'], '*', async (c) => {
    const webDir = deps.config.webDir;
    if (!webDir) return c.text('Not found', 404);
    const res = await resolveStatic(webDir, new URL(c.req.url).pathname);
    if (res.status !== 200) return c.text(res.status === 400 ? 'Bad request' : 'Not found', res.status);
    c.header('Content-Type', res.type);
    c.header('Content-Length', String(res.size));
    c.header('Cache-Control', res.cache);
    if (res.type.startsWith('text/html')) c.header('Content-Security-Policy', SPA_CSP);
    // HEAD: the same headers, without opening the file. GET streams it.
    if (c.req.method === 'HEAD') return c.body(null);
    return c.body(staticBody(res.file));
  });

  app.all('*', (c) => c.text('Method not allowed', 405));

  app.onError((err, c) => toErrorResponse(c, err, deps.log));

  return app;
}
