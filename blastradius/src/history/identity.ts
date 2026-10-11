/**
 * Identities for git history (docs/WHO-BEHIND-PLAN.md S2, §5).
 *
 * An author is identified by, in order:
 *   1. a GitHub login GitHub itself stated (GraphQL `Commit.author.user.login`, see graphql.ts);
 *   2. the login inside a GitHub no-reply address (`ID+login@users.noreply.github.com` or
 *      `login@users.noreply.github.com`, the formats GitHub documents for commit email privacy:
 *      https://docs.github.com/en/account-and-profile/reference/email-addresses-reference);
 *   3. otherwise `hash:` + HMAC-SHA256 of the normalised email under an installation secret salt.
 *
 * Emails exist only in memory while a repository is read; they are never returned, stored,
 * logged or exported. Git's own .mailmap (https://git-scm.com/docs/gitmailmap) is applied by git
 * before we see an email, so a project's declared aliases count as one person.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const NOREPLY_RE = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/i;

/** Bot accounts excluded from contributor counts (plan S2). */
const BOT_RE = /\[bot\]|^dependabot|^renovate|^github-actions|^greenkeeper|^snyk-bot|^allcontributors/i;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The login in a GitHub no-reply address, else undefined. */
export function noreplyLogin(email: string): string | undefined {
  const m = NOREPLY_RE.exec(normaliseEmail(email));
  return m ? m[1]!.toLowerCase() : undefined;
}

export function isBot(name: string, email: string): boolean {
  const local = normaliseEmail(email).split('@')[0] ?? '';
  return BOT_RE.test(name.trim()) || BOT_RE.test(local) || /\[bot\]@users\.noreply\.github\.com$/i.test(email);
}

/** Committers that are a platform rather than a person (GitHub's web-flow merges and edits). */
export function isPlatformCommitter(email: string): boolean {
  return /^(noreply|web-flow)@github\.com$/i.test(normaliseEmail(email)) || normaliseEmail(email) === 'noreply@gitlab.com';
}

/** `hash:` + the first 16 hex chars of HMAC-SHA256(salt, normalised email). */
export function hashEmail(email: string, salt: Buffer | string): string {
  return `hash:${createHmac('sha256', salt).update(normaliseEmail(email)).digest('hex').slice(0, 16)}`;
}

/** Id for an email before any API mapping: no-reply login, else the salted hash. */
export function localIdentity(email: string, salt: Buffer | string): string {
  return noreplyLogin(email) ?? hashEmail(email, salt);
}

export function isHashedId(id: string): boolean {
  return id.startsWith('hash:');
}

/**
 * The installation's salt: $BLASTRADIUS_HASH_SALT when set, else a random 32-byte secret kept in
 * `file` (created with mode 0600). Never logged.
 */
export function loadSalt(file: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.BLASTRADIUS_HASH_SALT;
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, 'utf8');
  try {
    const b = readFileSync(file);
    if (b.length >= 16) return b;
  } catch {
    // created below
  }
  const salt = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, salt, { mode: 0o600 });
  return salt;
}
