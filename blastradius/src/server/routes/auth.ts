/** /api/health, /api/auth/*, /api/dev/switch-user, /api/me */
import type { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { DevSwitchUserResponse, HealthResponse, LoginResponse, MeResponse, OkResponse } from '../api-types.js';
import { buildMe, deps, requireSession, resolveOrgId, type AppEnv, type Ctx } from '../context.js';
import { ApiHttpError, notFound } from '../errors.js';
import { parseBody } from '../request.js';
import { createSession, deleteSession, getUser, isDevUser, normalizeEmail, SESSION_TTL_SECONDS, setSessionOrg, setSessionUser, verifyLogin, writeAudit } from '../store/index.js';

export const SESSION_COOKIE = 'br_session';

const LoginBody = z.strictObject({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

const SwitchBody = z.strictObject({ userId: z.string().min(1).max(100) });

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/** Secure flag: https, or any non-loopback host (it is then expected to sit behind TLS). */
export function cookieSecure(c: Ctx): boolean {
  const mode = deps(c).config.secureCookies ?? 'auto';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const url = new URL(c.req.url);
  if (url.protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https') return true;
  return !isLoopbackHost(c.req.header('host') ?? url.host);
}

export function setSessionCookie(c: Ctx, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    secure: cookieSecure(c),
  });
}

/**
 * Socket peer address for per-client limits. X-Forwarded-For is not trusted (it is client
 * controlled); behind a proxy every client shares the proxy's address, which only makes the
 * limit stricter. app.request() in tests has no socket and falls back to "local".
 */
export function clientAddress(c: Ctx): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.get('/api/health', (c) => c.json<HealthResponse>({ ok: true, version: deps(c).config.version }));

  app.post('/api/auth/login', async (c) => {
    const { store, config, loginLimiter, loginIpLimiter, loginGate } = deps(c);
    const body = await parseBody(c, LoginBody);
    const key = normalizeEmail(body.email);
    const ip = clientAddress(c);
    // Count the attempt before the (slow) password check, so a burst of parallel requests
    // cannot all slip past the limit while scrypt runs.
    const emailOk = loginLimiter.hit(key);
    const ipOk = loginIpLimiter.hit(ip);
    if (!emailOk || !ipOk) throw new ApiHttpError('rate_limited', 'Too many sign-in attempts. Try again later.');
    const release = await loginGate.acquire();
    if (!release) throw new ApiHttpError('rate_limited', 'Too many sign-in attempts. Try again later.');
    let user: Awaited<ReturnType<typeof verifyLogin>>;
    try {
      user = await verifyLogin(store, body.email, body.password);
    } finally {
      release();
    }
    // Seeded dev users have a publicly known password: they only sign in while dev mode is on.
    if (user && !config.devMode && isDevUser(store, user.id)) user = null;
    if (!user) throw new ApiHttpError('unauthenticated', 'Wrong email or password');
    loginLimiter.reset(key);
    loginIpLimiter.release(ip);
    const orgId = resolveOrgId(store, user.id, null);
    const { token } = createSession(store, user.id, { orgId });
    writeAudit(store, { orgId, actor: user.id, action: 'session.login', target: user.id });
    setSessionCookie(c, token);
    return c.json<LoginResponse>(buildMe(c, { token, user, orgId }));
  });

  app.post('/api/auth/logout', (c) => {
    const session = requireSession(c);
    deleteSession(deps(c).store, session.token);
    writeAudit(deps(c).store, { orgId: session.orgId, actor: session.user.id, action: 'session.logout', target: session.user.id });
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: cookieSecure(c), httpOnly: true, sameSite: 'Strict' });
    return c.json<OkResponse>({ ok: true });
  });

  app.post('/api/dev/switch-user', async (c) => {
    const { store, config, log } = deps(c);
    if (!config.devMode) throw notFound();
    const session = requireSession(c);
    const body = await parseBody(c, SwitchBody);
    if (!isDevUser(store, body.userId)) throw notFound('Dev user not found');
    const user = getUser(store, body.userId);
    if (!user) throw notFound('Dev user not found');
    setSessionUser(store, session.token, user.id);
    const orgId = resolveOrgId(store, user.id, session.orgId);
    setSessionOrg(store, session.token, orgId);
    log(`dev: session switched from ${session.user.email} to ${user.email}`);
    writeAudit(store, {
      orgId,
      actor: session.user.id,
      action: 'session.switch_user',
      target: user.id,
      detail: { fromUserId: session.user.id, toUserId: user.id, fromOrgId: session.orgId, toOrgId: orgId },
    });
    return c.json<DevSwitchUserResponse>(buildMe(c, { token: session.token, user, orgId }));
  });

  app.get('/api/me', (c) => c.json<MeResponse>(buildMe(c, requireSession(c))));
}
