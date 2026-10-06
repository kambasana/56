/** Pure helpers for the Settings roles matrix (draft edits before "Save roles"). */
import type { Permission, Role } from '@server/api-types';
import { ALL_PERMISSIONS, ORG_ADMIN_ROLE_ID } from '@server/permissions';

export type Draft = Record<string, Permission[]>;

export function draftFrom(roles: readonly Role[]): Draft {
  const d: Draft = {};
  for (const r of roles) d[r.id] = [...r.permissions];
  return d;
}

/** Toggle one permission for one role, keeping catalogue order. Org admin never changes. */
export function toggle(d: Draft, roleId: string, perm: Permission, on: boolean): Draft {
  if (roleId === ORG_ADMIN_ROLE_ID) return d;
  const set = new Set(d[roleId] ?? []);
  if (on) set.add(perm);
  else set.delete(perm);
  return { ...d, [roleId]: ALL_PERMISSIONS.filter((p) => set.has(p)) };
}

function same(a: readonly Permission[], b: readonly Permission[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((p) => s.has(p));
}

/** Roles whose draft differs from the saved permissions, with the new list. */
export function changes(roles: readonly Role[], d: Draft): { id: string; name: string; permissions: Permission[] }[] {
  const out: { id: string; name: string; permissions: Permission[] }[] = [];
  for (const r of roles) {
    if (r.id === ORG_ADMIN_ROLE_ID) continue;
    const next = d[r.id];
    if (next && !same(r.permissions, next)) out.push({ id: r.id, name: r.name, permissions: next });
  }
  return out;
}

function snapshot(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function perms(v: Record<string, unknown> | null): string[] {
  const p = v?.permissions;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

/** Short, plain-text description of an audit entry (detail is a {before, after} snapshot). */
export function describeAudit(action: string, target: string, detail: Record<string, unknown>): string {
  const before = snapshot(detail.before);
  const after = snapshot(detail.after);
  const nameOf = (v: Record<string, unknown> | null) => (typeof v?.name === 'string' ? v.name : null);
  const name = nameOf(after) ?? nameOf(before) ?? target;
  switch (action) {
    case 'role.create':
      return `Created role ${name}`;
    case 'role.update': {
      const b = new Set(perms(before));
      const a = new Set(perms(after));
      const added = [...a].filter((p) => !b.has(p));
      const removed = [...b].filter((p) => !a.has(p));
      const parts = [added.length ? `+${added.join(', +')}` : '', removed.length ? `−${removed.join(', −')}` : ''].filter(Boolean);
      const renamed = nameOf(before) && nameOf(after) && nameOf(before) !== nameOf(after) ? ` (renamed from ${nameOf(before)})` : '';
      return `Updated role ${name}${renamed}${parts.length ? `: ${parts.join(' ')}` : ''}`;
    }
    case 'role.reset':
      return `Reset role ${name} to its template`;
    case 'role.delete':
      return `Deleted role ${name}`;
    case 'binding.create':
      return `Assigned role ${String(after?.roleId ?? '')}`.trim();
    case 'binding.delete':
      return `Removed assignment of role ${String(before?.roleId ?? '')}`.trim();
    default:
      return `${action} ${target}`;
  }
}
