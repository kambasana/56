/** /api/health, /api/auth/*, /api/dev/switch-user, /api/me */
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AcceptInviteResponse, DevSwitchUserResponse, HealthResponse, LoginResponse, MeResponse, OkResponse } from '../api-types.js';
import { buildMe, deps, requireSession, resolveOrgId, type AppEnv, type Ctx } from '../context.js';
import { ApiHttpError, badRequest, notFound } from '../errors.js';
import { parseBody } from '../request.js';
import {
  acceptInvite,
  createSession,
  deleteSession,
  findPendingInvite,
  getUser,
  getUserByEmail,
  hashPassword,
  type InviteAccount,
  isDevUser,
  normalizeEmail,
  SESSION_TTL_SECONDS,
  setSessionOrg,
  setSessionUser,
  verifyLogin,
  writeAudit,
} from '../store/index.js';

export const SESSION_COOKIE = 'br_session';

const LoginBody = z.strictObject({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

const SwitchBody = z.strictObject({ userId: z.string().min(1).max(100) });

const AcceptInviteBody = z.strictObject({
  token: z.string().min(1).max(200),
  // The 12-character minimum applies to new accounts; an existing account confirms its current password.
  password: z.string().min(1).max(1024),
});

const NEW_PASSWORD_MIN = 12;
const INVALID_INVITE = 'This invite is invalid, expired or already used';
const INVITE_REJECTED =
  'This invite is invalid, expired or already used, or the password does not match the existing account for this email';

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/** Secure flag: https (directly, or X-Forwarded-Proto from a trusted proxy), or any non-loopback host (it is then expected to sit behind TLS). */
export function cookieSecure(c: Ctx): boolean {
  const mode = deps(c).config.secureCookies ?? 'auto';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const url = new URL(c.req.url);
  if (url.protocol === 'https:') return true;
  if (fromTrustedProxy(c) && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https') return true;
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

/** Lower-case, unbracketed, and IPv4-mapped IPv6 ("::ffff:1.2.3.4") reduced to plain IPv4. */
export function normalizeAddress(address: string): string {
  const a = address.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  return mapped ? mapped[1]! : a;
}

function socketAddress(c: Ctx): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const raw = env?.incoming?.socket?.remoteAddress;
  return raw ? normalizeAddress(raw) : null;
}

function trustedProxies(c: Ctx): Set<string> {
  return new Set((deps(c).config.trustProxy ?? []).map(normalizeAddress));
}

/** True when the socket peer is a configured trusted proxy (ServerConfig.trustProxy). */
function fromTrustedProxy(c: Ctx): boolean {
  const peer = socketAddress(c);
  return peer !== null && trustedProxies(c).has(peer);
}

/**
 * Client address for per-client limits. By default the socket peer: X-Forwarded-For is client
 * controlled and ignored. Only when the peer is a configured trusted proxy (--trust-proxy) is
 * X-Forwarded-For read, taking the right-most hop that is not itself a trusted proxy.
 * app.request() in tests has no socket and falls back to "local".
 */
export function clientAddress(c: Ctx): string {
  const peer = socketAddress(c);
  if (peer === null) return 'local';
  const trusted = trustedProxies(c);
  if (!trusted.has(peer)) return peer;
  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map(normalizeAddress)
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!trusted.has(hops[i]!)) return hops[i]!;
  return peer;
}

/** Per-account sign-in limiter key: sha256(client address NUL normalised email). */
export function accountLimitKey(ip: string, email: string): string {
  return createHash('sha256').update(`${ip}\u0000${normalizeEmail(email)}`).digest('hex');
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.get('/api/health', (c) => c.json<HealthResponse>({ ok: true, version: deps(c).config.version }));

  app.post('/api/auth/login', async (c) => {
    const { store, config, loginLimiter, loginIpLimiter, loginGate } = deps(c);
    const body = await parseBody(c, LoginBody);
    const ip = clientAddress(c);
    const key = accountLimitKey(ip, body.email);
    // Count the attempt before the (slow) password check, so a burst of parallel requests
    // cannot all slip past the limit while scrypt runs. A blocked address is refused before
    // the per-account counter is touched.
    if (!loginIpLimiter.hit(ip)) throw new ApiHttpError('rate_limited', 'Too many sign-in attempts. Try again later.');
    if (!loginLimiter.hit(key)) throw new ApiHttpError('rate_limited', 'Too many sign-in attempts. Try again later.');
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

  app.post('/api/auth/accept-invite', async (c) => {
    const { store, config, loginLimiter, loginIpLimiter, loginGate } = deps(c);
    const body = await parseBody(c, AcceptInviteBody);
    const ip = clientAddress(c);
    if (!loginIpLimiter.hit(ip)) throw new ApiHttpError('rate_limited', 'Too many attempts. Try again later.');
    // Cheap check first, so unknown tokens never cost a password hash.
    const pending = findPendingInvite(store, body.token);
    if (!pending) throw badRequest(INVALID_INVITE, ['token']);
    // An existing account proves consent with its password: count it like a sign-in attempt.
    const key = accountLimitKey(ip, pending.email);
    if (!loginLimiter.hit(key)) throw new ApiHttpError('rate_limited', 'Too many attempts. Try again later.');
    const release = await loginGate.acquire();
    if (!release) throw new ApiHttpError('rate_limited', 'Too many attempts. Try again later.');
    let account: InviteAccount | null = null;
    try {
      const existing = await verifyLogin(store, pending.email, body.password);
      if (existing) {
        // Seeded dev users have a publicly known password: never outside dev mode.
        if (config.devMode || !isDevUser(store, existing.id)) account = { kind: 'existing', userId: existing.id };
      } else if (!getUserByEmail(store, pending.email)) {
        if (body.password.length < NEW_PASSWORD_MIN) throw badRequest(`Password must be at least ${NEW_PASSWORD_MIN} characters`, ['password']);
        account = { kind: 'new', passwordHash: await hashPassword(body.password) };
      }
    } finally {
      release();
    }
    if (!account) throw badRequest(INVITE_REJECTED, ['password']);
    // Re-checked and consumed atomically: a token works once, even under parallel requests.
    const accepted = acceptInvite(store, body.token, account);
    if (!accepted) throw badRequest(INVALID_INVITE, ['token']);
    loginLimiter.reset(key);
    loginIpLimiter.release(ip);
    const user = accepted.user;
    const orgId = resolveOrgId(store, user.id, accepted.orgId);
    const { token } = createSession(store, user.id, { orgId });
    writeAudit(store, { orgId, actor: user.id, action: 'session.login', target: user.id, detail: { via: 'invite' } });
    setSessionCookie(c, token);
    return c.json<AcceptInviteResponse>(buildMe(c, { token, user, orgId }));
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
