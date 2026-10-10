/**
 * Dev seed: org "acme" and four local users, each bound at org scope to the built-in role of
 * the same name. Only for `blastradius serve --dev`; the caller must pass `devMode: true`.
 * Idempotent: running it again reuses the org and users and only adds what is missing.
 */
import type { Org, User } from '../api-types.js';
import type { BuiltinRoleId } from '../permissions.js';
import { createUser, getUserByEmail, setPassword } from './auth.js';
import { get, newId, nowIso, run, StoreError, tx, type Store } from './db.js';
import { createOrg, getOrgBySlug } from './orgs.js';
import { seedOrgRoles } from './rbac.js';

export const DEV_ORG = { name: 'Acme', slug: 'acme' } as const;
export const DEFAULT_DEV_PASSWORD = 'blastradius-dev';

export const DEV_USERS: readonly { email: string; name: string; role: BuiltinRoleId }[] = [
  { email: 'admin@local', name: 'Dev Admin', role: 'org_admin' },
  { email: 'appsec@local', name: 'Dev AppSec', role: 'appsec' },
  { email: 'developer@local', name: 'Dev Developer', role: 'developer' },
  { email: 'auditor@local', name: 'Dev Auditor', role: 'auditor' },
];

export interface DevSeedResult {
  org: Org;
  users: (User & { role: BuiltinRoleId })[];
  /** The password every seeded user has (print once to the console; never log elsewhere). */
  password: string;
  /** Users created by this call (existing ones keep their password unless resetPasswords). */
  created: string[];
}

export interface DevSeedOptions {
  /** Must be true: guards against seeding known credentials outside dev mode. */
  devMode: boolean;
  /** Defaults to env BLASTRADIUS_DEV_PASSWORD, else "blastradius-dev". */
  password?: string;
  /** Also reset existing dev users' passwords to `password`. */
  resetPasswords?: boolean;
}

export function devPassword(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.BLASTRADIUS_DEV_PASSWORD;
  return p && p.length > 0 ? p : DEFAULT_DEV_PASSWORD;
}

export async function seedDev(s: Store, opts: DevSeedOptions): Promise<DevSeedResult> {
  if (opts.devMode !== true) throw new StoreError('bad_request', 'Dev seed is only available in dev mode');
  const password = opts.password ?? devPassword();
  const created: string[] = [];
  const result = tx(s, () => {
    const org = getOrgBySlug(s, DEV_ORG.slug) ?? createOrg(s, { name: DEV_ORG.name, slug: DEV_ORG.slug }, null);
    seedOrgRoles(s, org.id);
    const users = DEV_USERS.map((d) => {
      let u = getUserByEmail(s, d.email);
      if (!u) {
        u = createUser(s, { email: d.email, name: d.name, password, dev: true });
        created.push(u.id);
      } else {
        run(s, 'UPDATE app_user SET dev = 1 WHERE id = ?', u.id);
      }
      const exists = get<{ id: string }>(
        s,
        `SELECT id FROM role_binding WHERE org_id = ? AND role_id = ? AND subject_kind = 'user' AND subject_ref = ? AND scope_kind = 'org'`,
        org.id,
        d.role,
        u.id,
      );
      if (!exists) {
        run(
          s,
          `INSERT INTO role_binding (id, org_id, role_id, subject_kind, subject_ref, scope_kind, project_id, created_at, created_by)
           VALUES (?, ?, ?, 'user', ?, 'org', NULL, ?, 'system')`,
          newId('bnd'),
          org.id,
          d.role,
          u.id,
          nowIso(s),
        );
      }
      return { ...u, role: d.role };
    });
    return { org, users };
  });
  if (opts.resetPasswords) {
    for (const u of result.users) if (!created.includes(u.id)) await setPassword(s, u.id, password);
  }
  return { ...result, password, created };
}
