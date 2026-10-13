/** Organisations. Creating one seeds its built-in roles and (optionally) binds the creator as Org admin. */
import type { CreateOrgRequest, Org } from '../api-types.js';
import { ORG_ADMIN_ROLE_ID } from '../permissions.js';
import { writeAudit } from './audit.js';
import { all, get, isConstraintError, newId, nowIso, run, StoreError, tx, type Store } from './db.js';
import { seedOrgRoles } from './rbac.js';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

const toOrg = (r: OrgRow): Org => ({ id: r.id, name: r.name, slug: r.slug, createdAt: r.created_at });

export const SLUG_RE = /^[a-z0-9-]{2,40}$/;

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : `org-${base || 'x'}`.slice(0, 40);
}

/**
 * Create an org with its built-in roles. When `creatorId` is a user id, that user gets an
 * org-scope Org admin binding. An explicit slug that is taken is a conflict; a derived slug
 * gets a numeric suffix instead.
 */
export function createOrg(s: Store, input: CreateOrgRequest, creatorId: string | null): Org {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new StoreError('bad_request', 'Name must be 1–120 characters', ['name']);
  return tx(s, () => {
    let slug: string;
    if (input.slug !== undefined) {
      slug = input.slug;
      if (!SLUG_RE.test(slug)) throw new StoreError('bad_request', 'Slug must match [a-z0-9-]{2,40}', ['slug']);
      if (getOrgBySlug(s, slug)) throw new StoreError('conflict', 'Slug already in use', ['slug']);
    } else {
      const base = slugify(name);
      slug = base;
      for (let i = 2; getOrgBySlug(s, slug); i++) slug = `${base.slice(0, 40 - String(i).length - 1)}-${i}`;
    }
    const org: Org = { id: newId('org'), name, slug, createdAt: nowIso(s) };
    try {
      run(s, 'INSERT INTO org (id, name, slug, created_at) VALUES (?, ?, ?, ?)', org.id, org.name, org.slug, org.createdAt);
    } catch (e) {
      if (isConstraintError(e, 'UNIQUE')) throw new StoreError('conflict', 'Slug already in use', ['slug']);
      throw e;
    }
    seedOrgRoles(s, org.id);
    if (creatorId) {
      run(
        s,
        `INSERT INTO role_binding (id, org_id, role_id, subject_kind, subject_ref, scope_kind, project_id, created_at, created_by)
         VALUES (?, ?, ?, 'user', ?, 'org', NULL, ?, ?)`,
        newId('bnd'),
        org.id,
        ORG_ADMIN_ROLE_ID,
        creatorId,
        org.createdAt,
        creatorId,
      );
    }
    writeAudit(s, { orgId: org.id, actor: creatorId ?? 'system', action: 'org.create', target: org.id, detail: { after: org } });
    return org;
  });
}

export function getOrg(s: Store, id: string): Org | null {
  const r = get<OrgRow>(s, 'SELECT * FROM org WHERE id = ?', id);
  return r ? toOrg(r) : null;
}

export function getOrgBySlug(s: Store, slug: string): Org | null {
  const r = get<OrgRow>(s, 'SELECT * FROM org WHERE slug = ?', slug);
  return r ? toOrg(r) : null;
}

export function listOrgs(s: Store): Org[] {
  return all<OrgRow>(s, 'SELECT * FROM org ORDER BY created_at, rowid').map(toOrg);
}

export function countOrgs(s: Store): number {
  return get<{ n: number }>(s, 'SELECT count(*) AS n FROM org')?.n ?? 0;
}

/** Orgs where the user (or one of their groups) has any binding. */
export function listOrgsForUser(s: Store, userId: string, groups: readonly string[] = []): Org[] {
  const groupClause = groups.length > 0 ? ` OR (b.subject_kind = 'group' AND b.subject_ref IN (${groups.map(() => '?').join(', ')}))` : '';
  return all<OrgRow>(
    s,
    `SELECT o.* FROM org o WHERE EXISTS (
       SELECT 1 FROM role_binding b WHERE b.org_id = o.id AND ((b.subject_kind = 'user' AND b.subject_ref = ?)${groupClause})
     ) ORDER BY o.created_at, o.rowid`,
    userId,
    ...groups,
  ).map(toOrg);
}
