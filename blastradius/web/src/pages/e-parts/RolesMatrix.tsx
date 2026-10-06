/**
 * Settings: permissions by role (pages × roles, actions × roles). Editable only with
 * manage_members; Org admin is locked to everything. Changes are drafted locally and saved with
 * PATCH /api/roles/:id; every save, reset, create and delete is written to the audit log by the
 * server, and the parent reloads the audit entries afterwards.
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { ListRolesResponse, Permission, Role } from '@server/api-types';
import { BUILTIN_ROLE_IDS, ORG_ADMIN_ROLE_ID, ROLE_TEMPLATES } from '@server/permissions';
import { api } from '@/api';
import { Button } from '@/components/Button';
import { cn } from '@/lib/cn';
import { changes, draftFrom, toggle, type Draft } from './rbac';
import { Card, InlineAlert, Select, errorText, inputClass } from './ui';

export function RolesMatrix({ data, editable, onChanged }: { data: ListRolesResponse; editable: boolean; onChanged: () => void }) {
  const roles = data.items;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(roles));
  useEffect(() => setDraft(draftFrom(roles)), [roles]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const pending = useMemo(() => changes(roles, draft), [roles, draft]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      for (const c of pending) await api.updateRole(c.id, { permissions: c.permissions });
    }, `Saved ${pending.length} role${pending.length === 1 ? '' : 's'}. The change is in the audit log.`);

  const kindOf = (r: Role) => {
    if (r.builtIn) return 'Built-in template';
    const t = r.template && (BUILTIN_ROLE_IDS as readonly string[]).includes(r.template) ? ROLE_TEMPLATES[r.template as keyof typeof ROLE_TEMPLATES].name : null;
    return t ? `Custom · from ${t}` : 'Custom';
  };

  const groups: { title: string; perms: readonly Permission[] }[] = [
    { title: 'Pages', perms: data.catalogue.pages },
    { title: 'Actions', perms: data.catalogue.actions },
  ];

  return (
    <Card
      title="Permissions by role"
      description="Tick what each role can see and do. Pages a role can't see disappear from its navigation."
      action={editable ? <CreateRole roles={roles} busy={busy} onCreate={(body) => run(() => api.createRole(body), `Created role ${body.name}.`)} /> : undefined}
    >
      <div className="overflow-auto">
        <table aria-label="Permissions by role" className="w-full min-w-[640px] border-separate border-spacing-0 text-[13px] leading-[18px]">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-20 min-w-[220px] border-b bg-muted px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                Permission
              </th>
              {roles.map((r) => (
                <th key={r.id} scope="col" className="sticky top-0 z-10 min-w-[120px] border-b bg-muted px-2 py-2 text-center align-bottom">
                  <div className="font-semibold">{r.name}</div>
                  <div className="text-xs font-normal text-muted-foreground">{kindOf(r)}</div>
                  {editable && r.id !== ORG_ADMIN_ROLE_ID && (
                    <div className="mt-1 flex justify-center gap-1">
                      {r.builtIn ? (
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => run(() => api.resetRole(r.id), `Reset ${r.name} to its template.`)} aria-label={`Reset ${r.name} to template`}>
                          Reset
                        </Button>
                      ) : confirmDelete === r.id ? (
                        <>
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => {
                              setConfirmDelete(null);
                              void run(() => api.deleteRole(r.id), `Deleted role ${r.name}.`);
                            }}
                          >
                            Confirm delete
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(r.id)} aria-label={`Delete role ${r.name}`}>
                          Delete
                        </Button>
                      )}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => [
              <tr key={`h-${g.title}`}>
                <th scope="rowgroup" colSpan={roles.length + 1} className="border-b bg-background px-4 pb-1 pt-3 text-left text-xs font-medium text-muted-foreground">
                  {g.title}
                </th>
              </tr>,
              ...g.perms.map((p) => {
                const label = data.catalogue.labels[p] ?? p;
                return (
                  <tr key={p} className="hover:bg-muted/40">
                    <th scope="row" className="sticky left-0 z-[1] border-b bg-background px-4 py-1.5 text-left font-normal">
                      {label}
                    </th>
                    {roles.map((r) => {
                      const locked = r.id === ORG_ADMIN_ROLE_ID;
                      const on = locked || (draft[r.id] ?? []).includes(p);
                      const dirty = !locked && on !== r.permissions.includes(p);
                      return (
                        <td key={r.id} className={cn('border-b px-2 py-1.5 text-center', dirty && 'bg-info/10')}>
                          <input
                            type="checkbox"
                            className="size-4 cursor-pointer accent-[var(--primary)] disabled:cursor-default"
                            checked={on}
                            disabled={!editable || locked || busy}
                            aria-label={`${r.name}: ${label}`}
                            onChange={(e) => setDraft((d) => toggle(d, r.id, p, e.target.checked))}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span>Org admin always keeps every permission so the org can't lock itself out.</span>
        <span>Every change is written to the audit log.</span>
        <span className="grow" />
        {editable ? (
          <>
            {pending.length > 0 && <span className="text-foreground">{pending.length} unsaved</span>}
            <Button size="xs" variant="ghost" disabled={busy || pending.length === 0} onClick={() => setDraft(draftFrom(roles))}>
              Discard
            </Button>
            <Button size="xs" disabled={busy || pending.length === 0} onClick={save}>
              {busy ? 'Saving…' : 'Save roles'}
            </Button>
          </>
        ) : (
          <span>Read-only: editing roles needs "Manage members and roles".</span>
        )}
      </div>
      {msg && (
        <div className="px-4 pb-3">
          <InlineAlert tone={msg.tone} onDismiss={() => setMsg(null)}>
            {msg.text}
          </InlineAlert>
        </div>
      )}
    </Card>
  );
}

function CreateRole({ roles, busy, onCreate }: { roles: readonly Role[]; busy: boolean; onCreate: (body: { name: string; template?: string; permissions?: Permission[] }) => void }) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<string>('developer');
  const id = useId();
  const taken = roles.some((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || taken) return;
    onCreate(template === 'blank' ? { name: n, permissions: [] } : { name: n, template });
    setName('');
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-1.5" aria-label="New role from template">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        New role
      </label>
      <input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Leadership" maxLength={60} className={cn(inputClass, 'w-36')} />
      <Select label="from template" value={template} onChange={(e) => setTemplate(e.target.value)}>
        {BUILTIN_ROLE_IDS.map((t) => (
          <option key={t} value={t}>
            {ROLE_TEMPLATES[t].name}
          </option>
        ))}
        <option value="blank">Blank</option>
      </Select>
      <Button type="submit" size="xs" variant="outline" disabled={busy || !name.trim() || taken}>
        Create role
      </Button>
      {taken && <span className="text-xs text-destructive">Name in use</span>}
    </form>
  );
}
