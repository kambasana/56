/**
 * Member invites (POST /api/members, POST /api/auth/accept-invite).
 *
 * Outside dev mode every invite is pending: the server stores the email, the name the inviter
 * typed and the bindings, and hands back a single-use token (7-day expiry; only its SHA-256 is
 * stored). Nothing is granted until the invitee accepts. The answer is the same whether or not
 * the email already has an account, so POST /api/members cannot be used to probe accounts in
 * other orgs, read their names, or attach them to an org without consent:
 *  - no account yet: accepting creates it with the chosen password and the invited name;
 *  - existing account: accepting needs that account's current password (the invitee's consent).
 * Inviting the same email again replaces its earlier unaccepted invites, which is also how an
 * expired invite is re-sent.
 *
 * Dev mode keeps the shortcut for brand-new emails: the user is created at once with a
 * generated one-time password and the bindings.
 *
 * Permission checks ("grant only what you hold") are the server's job before calling these.
 */
import { randomBytes } from 'node:crypto';
import type { BindingScope, Member, User } from '../api-types.js';
import { writeAudit } from './audit.js';
import { createUser, getUser, getUserByEmail, hashToken, normalizeEmail } from './auth.js';
import { all, get, newId, nowIso, run, StoreError, tx, type Store } from './db.js';
import { createBinding, getRole, isOrgMember, listMembers } from './rbac.js';

export const INVITE_TTL_SECONDS = 7 * 24 * 3600;

type InviteBinding = { roleId: string; scope: BindingScope };

export interface InviteMemberInput {
  email: string;
  name: string;
  bindings: readonly InviteBinding[];
  /** Dev mode: give a brand-new user a generated password instead of a pending invite. */
  devMode: boolean;
}

export interface InviteMemberResult {
  /** Dev mode, new account: the member as created. */
  member?: Member;
  oneTimePassword?: string;
  /** Pending invite (every other case). */
  invite?: { id: string; token: string; expiresAt: string; email: string; name: string };
}

/** 24 random bytes, base64url (32 characters). */
export function generateOneTimePassword(): string {
  return randomBytes(24).toString('base64url');
}

function memberOf(s: Store, orgId: string, userId: string): Member {
  const m = listMembers(s, orgId).items.find((x) => x.id === userId);
  if (!m) throw new StoreError('not_found', 'Member not found');
  return m;
}

function checkInput(s: Store, orgId: string, input: InviteMemberInput): { email: string; name: string } {
  if (input.bindings.length === 0) throw new StoreError('bad_request', 'At least one binding is required', ['bindings']);
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)) throw new StoreError('bad_request', 'Invalid email', ['email']);
  const name = input.name.trim();
  if (!name || name.length > 200) throw new StoreError('bad_request', 'Invalid name', ['name']);
  input.bindings.forEach((b, i) => {
    if (!getRole(s, orgId, b.roleId)) throw new StoreError('bad_request', 'Unknown role', [`bindings.${i}.roleId`]);
    if (b.scope.kind === 'project' && !get(s, 'SELECT id FROM project WHERE org_id = ? AND id = ?', orgId, b.scope.projectId)) {
      throw new StoreError('bad_request', 'Unknown project', [`bindings.${i}.scope.projectId`]);
    }
  });
  return { email, name };
}

/**
 * Invite `email` to the org with `bindings`. 409 only when the email is already a member of
 * this org (the caller can see its own members anyway). Audited (invite.create / member.invite);
 * secrets never reach the audit log.
 */
export function inviteMember(s: Store, orgId: string, input: InviteMemberInput, actor: string): InviteMemberResult {
  return tx(s, () => {
    const { email, name } = checkInput(s, orgId, input);
    const existing = getUserByEmail(s, email);
    if (existing && isOrgMember(s, orgId, existing.id)) {
      throw new StoreError('conflict', 'This user is already a member; edit their bindings instead', ['email']);
    }
    if (input.devMode && !existing) {
      const oneTimePassword = generateOneTimePassword();
      const user = createUser(s, { email, name, password: oneTimePassword });
      writeAudit(s, { orgId, actor, action: 'user.create', target: user.id, detail: { email: user.email, name: user.name, via: 'invite' } });
      const bindingIds = input.bindings.map((b) => createBinding(s, orgId, { roleId: b.roleId, subject: { kind: 'user', userId: user.id }, scope: b.scope }, actor).id);
      writeAudit(s, { orgId, actor, action: 'member.invite', target: user.id, detail: { email, bindings: bindingIds, credential: 'one_time_password' } });
      return { member: memberOf(s, orgId, user.id), oneTimePassword };
    }
    const invite = createInvite(s, orgId, { email, name, bindings: input.bindings }, actor);
    writeAudit(s, {
      orgId,
      actor,
      action: 'member.invite',
      target: invite.id,
      detail: { email, credential: 'invite', roles: input.bindings.map((b) => b.roleId), expiresAt: invite.expiresAt },
    });
    return { invite: { ...invite, email, name } };
  });
}

function createInvite(
  s: Store,
  orgId: string,
  input: { email: string; name: string; bindings: readonly InviteBinding[] },
  actor: string,
): { id: string; token: string; expiresAt: string } {
  const now = s.now();
  const nowStr = now.toISOString();
  // Re-inviting replaces earlier unaccepted invites for this email (resend after expiry).
  const superseded = all<{ id: string }>(
    s,
    'SELECT id FROM invite WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL',
    orgId,
    input.email,
  );
  for (const r of superseded) {
    run(s, 'UPDATE invite SET revoked_at = ? WHERE id = ?', nowStr, r.id);
    writeAudit(s, { orgId, actor, action: 'invite.revoke', target: r.id, detail: { reason: 'superseded' } });
  }
  const token = randomBytes(32).toString('base64url');
  const id = newId('inv');
  const expiresAt = new Date(now.getTime() + INVITE_TTL_SECONDS * 1000).toISOString();
  run(
    s,
    'INSERT INTO invite (id, org_id, email, name, bindings, token_hash, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    orgId,
    input.email,
    input.name,
    JSON.stringify(input.bindings.map((b) => ({ roleId: b.roleId, scope: b.scope }))),
    hashToken(token),
    nowStr,
    actor,
    expiresAt,
  );
  writeAudit(s, { orgId, actor, action: 'invite.create', target: id, detail: { email: input.email, expiresAt } });
  return { id, token, expiresAt };
}

interface InviteRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  bindings: string;
  created_by: string;
}

export interface PendingInvite {
  id: string;
  orgId: string;
  email: string;
  name: string;
  bindings: InviteBinding[];
  createdBy: string;
}

/**
 * A usable invite for `token`: not accepted, not replaced, not expired. Null otherwise (callers
 * answer one generic error for every case).
 */
export function findPendingInvite(s: Store, token: string): PendingInvite | null {
  if (!token || token.length > 200) return null;
  const r = get<InviteRow>(
    s,
    'SELECT id, org_id, email, name, bindings, created_by FROM invite WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
    hashToken(token),
    nowIso(s),
  );
  if (!r) return null;
  return { id: r.id, orgId: r.org_id, email: r.email, name: r.name, bindings: JSON.parse(r.bindings) as InviteBinding[], createdBy: r.created_by };
}

/** How the invitee proved who they are: an existing account's password, or a new password. */
export type InviteAccount = { kind: 'existing'; userId: string } | { kind: 'new'; passwordHash: string };

/**
 * Consume the invite and grant its bindings, atomically. A new account is created with the
 * invited name and `passwordHash`. Returns null when the invite was used, replaced or expired
 * meanwhile, or when the account situation changed under us (single use under races).
 * Bindings whose role or project no longer exists are skipped.
 */
export function acceptInvite(s: Store, token: string, account: InviteAccount): { orgId: string; user: User } | null {
  return tx(s, () => {
    const pending = findPendingInvite(s, token);
    if (!pending) return null;
    let user: User | null;
    if (account.kind === 'existing') {
      user = getUser(s, account.userId);
      if (!user || user.email !== pending.email) return null;
    } else {
      if (getUserByEmail(s, pending.email)) return null;
      user = createUser(s, { email: pending.email, name: pending.name, passwordHash: account.passwordHash });
      writeAudit(s, { orgId: pending.orgId, actor: user.id, action: 'user.create', target: user.id, detail: { email: user.email, name: user.name, via: 'invite' } });
    }
    const now = nowIso(s);
    const claimed = run(
      s,
      'UPDATE invite SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
      now,
      user.id,
      pending.id,
      now,
    ).changes;
    if (claimed !== 1) throw new StoreError('conflict', 'Invite already used');
    const granted: string[] = [];
    for (const b of pending.bindings) {
      try {
        granted.push(createBinding(s, pending.orgId, { roleId: b.roleId, subject: { kind: 'user', userId: user.id }, scope: b.scope }, pending.createdBy).id);
      } catch (e) {
        // Role or project removed since the invite, or the binding already exists: skip it.
        if (!(e instanceof StoreError)) throw e;
      }
    }
    writeAudit(s, {
      orgId: pending.orgId,
      actor: user.id,
      action: 'invite.accept',
      target: pending.id,
      detail: { userId: user.id, account: account.kind, bindings: granted },
    });
    return { orgId: pending.orgId, user };
  });
}
