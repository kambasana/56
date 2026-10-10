import { describe, expect, it } from 'vitest';
import {
  createSession,
  createUser,
  deleteExpiredSessions,
  deleteSession,
  getSession,
  getUserByEmail,
  hashPassword,
  hashPasswordSync,
  hashToken,
  setSessionUser,
  verifyLogin,
  verifyPassword,
} from './auth.js';
import { all, openStore, StoreError } from './db.js';

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(hashPasswordSync('x')).not.toBe(hashPasswordSync('x')); // salted
  });

  it('rejects malformed or hostile hashes without throwing', async () => {
    expect(await verifyPassword('x', 'plain')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$999999999$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });
});

describe('users', () => {
  it('creates users with normalised unique emails', () => {
    const s = openStore();
    const u = createUser(s, { email: ' Alice@Example.COM ', name: 'Alice', password: 'pw' });
    expect(u.email).toBe('alice@example.com');
    expect(getUserByEmail(s, 'ALICE@example.com')?.id).toBe(u.id);
    expect(() => createUser(s, { email: 'alice@example.com', name: 'Again' })).toThrow(StoreError);
    expect(() => createUser(s, { email: 'nope', name: 'x' })).toThrow(/Invalid email/);
  });

  it('verifies logins', async () => {
    const s = openStore();
    createUser(s, { email: 'a@x', name: 'A', password: 'secret-1' });
    createUser(s, { email: 'nopw@x', name: 'B' });
    expect((await verifyLogin(s, 'A@X', 'secret-1'))?.email).toBe('a@x');
    expect(await verifyLogin(s, 'a@x', 'secret-2')).toBeNull();
    expect(await verifyLogin(s, 'missing@x', 'secret-1')).toBeNull();
    expect(await verifyLogin(s, 'nopw@x', '')).toBeNull();
  });
});

describe('sessions', () => {
  it('stores only the token hash and expires sessions', () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const s = openStore({ now: () => new Date(now) });
    const u = createUser(s, { email: 'a@x', name: 'A' });
    const { token, expiresAt } = createSession(s, u.id, { ttlSeconds: 60 });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe('2026-01-01T00:01:00.000Z');
    const stored = all<{ id_hash: string }>(s, 'SELECT id_hash FROM session');
    expect(stored).toEqual([{ id_hash: hashToken(token) }]);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(getSession(s, token)?.user.id).toBe(u.id);
    expect(getSession(s, 'wrong')).toBeNull();
    now += 61_000;
    expect(getSession(s, token)).toBeNull();
    expect(all(s, 'SELECT * FROM session')).toHaveLength(0);
  });

  it('switches user, deletes and sweeps', () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const s = openStore({ now: () => new Date(now) });
    const a = createUser(s, { email: 'a@x', name: 'A' });
    const b = createUser(s, { email: 'b@x', name: 'B' });
    const { token } = createSession(s, a.id);
    setSessionUser(s, token, b.id);
    expect(getSession(s, token)?.user.id).toBe(b.id);
    deleteSession(s, token);
    expect(getSession(s, token)).toBeNull();
    createSession(s, a.id, { ttlSeconds: 1 });
    createSession(s, a.id, { ttlSeconds: 1000 });
    now += 5000;
    expect(deleteExpiredSessions(s)).toBe(1);
  });
});
