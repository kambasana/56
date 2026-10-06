/**
 * Local users, scrypt password hashes and sessions.
 *
 * Session tokens are 32 random bytes (base64url) handed to the client as the cookie value; the
 * database stores only their SHA-256, so a leaked database does not leak live sessions.
 */
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { User } from '../api-types.js';
import { all, get, isConstraintError, newId, nowIso, run, StoreError, type Store } from './db.js';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function formatHash(salt: Buffer, key: Buffer): string {
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Format: scrypt$N$r$p$salt$key (base64url). */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  return formatHash(salt, scryptSync(password, salt, SCRYPT.keylen, SCRYPT));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return formatHash(salt, await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT));
}

function parseHash(stored: string): { N: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20 || r > 32 || p > 16) return null;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const key = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 8 || key.length < 16) return null;
  return { N, r, p, salt, key };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored);
  if (!h) return false;
  const got = await scryptAsync(password, h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(got, h.key);
}

/** Used to spend the same time on unknown emails as on wrong passwords. */
let dummyHash: string | null = null;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  dev: number;
  disabled: number;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name });

export interface CreateUserInput {
  email: string;
  name: string;
  /** Plain password; hashed before storage. Omit for SSO-only / passwordless users. */
  password?: string;
  /** Already-hashed password (from hashPassword); takes precedence over `password`. */
  passwordHash?: string;
  /** Seeded dev user (eligible for the dev role switcher). */
  dev?: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUser(s: Store, input: CreateUserInput): User {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)) throw new StoreError('bad_request', 'Invalid email', ['email']);
  const name = input.name.trim();
  if (!name || name.length > 200) throw new StoreError('bad_request', 'Invalid name', ['name']);
  const id = newId('usr');
  const hash = input.passwordHash ?? (input.password !== undefined ? hashPasswordSync(input.password) : null);
  try {
    run(
      s,
      'INSERT INTO app_user (id, email, name, password_hash, dev, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      email,
      name,
      hash,
      input.dev === true,
      nowIso(s),
    );
  } catch (e) {
    if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'A user with this email already exists', ['email']);
    throw e;
  }
  return { id, email, name };
}

export function getUser(s: Store, id: string): User | null {
  const r = get<UserRow>(s, 'SELECT * FROM app_user WHERE id = ? AND disabled = 0', id);
  return r ? toUser(r) : null;
}

export function getUserByEmail(s: Store, email: string): User | null {
  const r = get<UserRow>(s, 'SELECT * FROM app_user WHERE email = ? AND disabled = 0', normalizeEmail(email));
  return r ? toUser(r) : null;
}

export function getUsers(s: Store, ids: readonly string[]): Map<string, User> {
  const out = new Map<string, User>();
  for (const id of new Set(ids)) {
    const u = getUser(s, id);
    if (u) out.set(id, u);
  }
  return out;
}

export function isDevUser(s: Store, id: string): boolean {
  return get<{ dev: number }>(s, 'SELECT dev FROM app_user WHERE id = ? AND disabled = 0', id)?.dev === 1;
}

/** Seeded dev users, in creation order. */
export function listDevUsers(s: Store): User[] {
  return all<UserRow>(s, 'SELECT * FROM app_user WHERE dev = 1 AND disabled = 0 ORDER BY rowid').map(toUser);
}

export async function setPassword(s: Store, userId: string, password: string): Promise<void> {
  const h = await hashPassword(password);
  const { changes } = run(s, 'UPDATE app_user SET password_hash = ? WHERE id = ?', h, userId);
  if (changes === 0) throw new StoreError('not_found', 'User not found');
}

/** Check email + password. Returns the user, or null (same timing for unknown email and bad password). */
export async function verifyLogin(s: Store, email: string, password: string): Promise<User | null> {
  const r = get<UserRow>(s, 'SELECT * FROM app_user WHERE email = ? AND disabled = 0', normalizeEmail(email));
  if (!r || !r.password_hash) {
    dummyHash ??= hashPasswordSync('blastradius-timing-dummy');
    await verifyPassword(password, dummyHash);
    return null;
  }
  return (await verifyPassword(password, r.password_hash)) ? toUser(r) : null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_TTL_SECONDS = 43200;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionInfo {
  user: User;
  orgId: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Create a session. The returned token is the cookie value; only its hash is stored. */
export function createSession(
  s: Store,
  userId: string,
  opts: { orgId?: string | null; ttlSeconds?: number } = {},
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const now = s.now();
  const expiresAt = new Date(now.getTime() + (opts.ttlSeconds ?? SESSION_TTL_SECONDS) * 1000).toISOString();
  run(
    s,
    'INSERT INTO session (id_hash, user_id, org_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    hashToken(token),
    userId,
    opts.orgId ?? null,
    now.toISOString(),
    expiresAt,
    now.toISOString(),
  );
  return { token, expiresAt };
}

/** Look up a live session. Expired sessions are deleted and return null. */
export function getSession(s: Store, token: string | undefined | null): SessionInfo | null {
  if (!token || token.length > 200) return null;
  const h = hashToken(token);
  const r = get<{ user_id: string; org_id: string | null; created_at: string; expires_at: string }>(
    s,
    'SELECT user_id, org_id, created_at, expires_at FROM session WHERE id_hash = ?',
    h,
  );
  if (!r) return null;
  const now = nowIso(s);
  if (r.expires_at <= now) {
    run(s, 'DELETE FROM session WHERE id_hash = ?', h);
    return null;
  }
  const user = getUser(s, r.user_id);
  if (!user) return null;
  run(s, 'UPDATE session SET last_seen_at = ? WHERE id_hash = ?', now, h);
  return { user, orgId: r.org_id, createdAt: r.created_at, expiresAt: r.expires_at };
}

/** Dev role switcher: move a session to another user (the server checks dev mode). */
export function setSessionUser(s: Store, token: string, userId: string): void {
  const { changes } = run(s, 'UPDATE session SET user_id = ? WHERE id_hash = ?', userId, hashToken(token));
  if (changes === 0) throw new StoreError('not_found', 'Session not found');
}

export function setSessionOrg(s: Store, token: string, orgId: string | null): void {
  const { changes } = run(s, 'UPDATE session SET org_id = ? WHERE id_hash = ?', orgId, hashToken(token));
  if (changes === 0) throw new StoreError('not_found', 'Session not found');
}

export function deleteSession(s: Store, token: string): void {
  run(s, 'DELETE FROM session WHERE id_hash = ?', hashToken(token));
}

export function deleteUserSessions(s: Store, userId: string): number {
  return run(s, 'DELETE FROM session WHERE user_id = ?', userId).changes;
}

export function deleteExpiredSessions(s: Store): number {
  return run(s, 'DELETE FROM session WHERE expires_at <= ?', nowIso(s)).changes;
}
