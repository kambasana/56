/**
 * Settings → Roles: permissions by role (pages × roles, actions × roles) as a shadcn Table of
 * Checkboxes. Editable only with manage_members; Org admin is locked to everything. Changes are
 * drafted locally and saved with PATCH /api/roles/:id; every save, reset, create and delete is
 * written to the audit log by the server, and the parent reloads the audit entries afterwards.
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { LockIcon, PlusIcon } from 'lucide-react';
import type { ListRolesResponse, Permission, Role } from '@server/api-types';
import { BUILTIN_ROLE_IDS, ORG_ADMIN_ROLE_ID, ROLE_TEMPLATES } from '@server/permissions';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { changes, draftFrom, rebase, toggle, type Draft } from './rbac';
import { ConfirmButton, ErrorAlert, LabeledSelect, SectionCard, errorText } from './ui';

export function RolesMatrix({ data, editable, onChanged }: { data: ListRolesResponse; editable: boolean; onChanged: () => void }) {
  const roles = data.items;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(roles));
  // A reload keeps edits that are still unsaved (e.g. after a partly failed save).
  const baseRef = useRef(roles);
  useEffect(() => {
    const prev = baseRef.current;
    baseRef.current = roles;
    if (prev !== roles) setDraft((d) => rebase(prev, roles, d));
  }, [roles]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useMemo(() => changes(roles, draft), [roles, draft]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  // Roles are saved one at a time. On a failure the drafts of the failed role and of every role
  // not yet saved are kept, so nothing is silently lost; the saved ones are applied on reload.
  const save = async () => {
    const todo = pending;
    setBusy(true);
    setError(null);
    const saved: string[] = [];
    let failed: { name: string; error: string } | null = null;
    for (const c of todo) {
      try {
        await api.updateRole(c.id, { permissions: c.permissions });
        saved.push(c.name);
      } catch (e) {
        failed = { name: c.name, error: errorText(e) };
        break;
      }
    }
    const plural = (n: number) => `${n} role${n === 1 ? '' : 's'}`;
    if (!failed) {
      toast.success(`Saved ${plural(saved.length)}. The change is in the audit log.`);
    } else {
      const unsaved = todo.slice(saved.length).map((c) => c.name);
      if (saved.length > 0) toast.success(`Saved ${saved.join(', ')}. The change is in the audit log.`);
      setError(
        `${saved.length > 0 ? `Saved ${saved.join(', ')}. ` : ''}Not saved: ${unsaved.join(', ')} (${failed.name}: ${failed.error}). Your unsaved edits are kept; save again to retry.`,
      );
    }
    setBusy(false);
    onChanged();
  };

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
    <SectionCard
      title="Permissions by role"
      description="Tick what each role can see and do. Pages a role can't see disappear from its navigation."
      action={editable ? <CreateRole roles={roles} busy={busy} onCreate={(body) => run(() => api.createRole(body), `Created role ${body.name}.`)} /> : undefined}
    >
      <div className="max-h-[70vh] overflow-auto [&>[data-slot=table-container]]:overflow-visible">
        <Table aria-label="Permissions by role" className="min-w-[640px] border-separate border-spacing-0 text-[13px]">
          <TableHeader className="[&_tr]:border-0">
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className="sticky top-0 left-0 z-20 min-w-[220px] border-b bg-muted px-4 text-xs text-muted-foreground">
                Permission
              </TableHead>
              {roles.map((r) => (
                <TableHead key={r.id} scope="col" className="sticky top-0 z-10 h-auto min-w-[128px] border-b bg-muted px-2 py-2 text-center align-bottom">
                  <div className="font-semibold">{r.name}</div>
                  <div className="text-xs font-normal text-muted-foreground">{kindOf(r)}</div>
                  {editable && r.id !== ORG_ADMIN_ROLE_ID && (
                    <div className="mt-1 flex justify-center">
                      {r.builtIn ? (
                        <ConfirmButton
                          ariaLabel={`Reset ${r.name} to template`}
                          disabled={busy}
                          destructive={false}
                          title={`Reset ${r.name} to its template?`}
                          description={`${r.name} gets the permissions of its built-in template again. Your edits to this role are lost. The reset is written to the audit log.`}
                          confirmLabel="Reset role"
                          onConfirm={() => {
                            // The reset replaces this role's permissions, drafted edits included.
                            setDraft((d) => ({ ...d, [r.id]: [...r.permissions] }));
                            void run(() => api.resetRole(r.id), `Reset ${r.name} to its template.`);
                          }}
                        >
                          Reset
                        </ConfirmButton>
                      ) : (
                        <ConfirmButton
                          ariaLabel={`Delete role ${r.name}`}
                          disabled={busy}
                          title={`Delete role ${r.name}?`}
                          description="Everyone bound to this role loses its permissions. This can't be undone; the deletion is written to the audit log."
                          confirmLabel="Delete role"
                          onConfirm={() => void run(() => api.deleteRole(r.id), `Deleted role ${r.name}.`)}
                        >
                          Delete
                        </ConfirmButton>
                      )}
                    </div>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <Fragment key={g.title}>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="rowgroup" colSpan={roles.length + 1} className="h-8 border-b bg-background px-4 pt-2 text-xs text-muted-foreground">
                    {g.title}
                  </TableHead>
                </TableRow>
                {g.perms.map((p) => {
                  const label = data.catalogue.labels[p] ?? p;
                  return (
                    <TableRow key={p} className="group">
                      <TableHead scope="row" className="sticky left-0 z-[1] h-auto border-b bg-background px-4 py-1.5 font-normal group-hover:bg-muted">
                        {label}
                      </TableHead>
                      {roles.map((r) => {
                        const locked = r.id === ORG_ADMIN_ROLE_ID;
                        const on = locked || (draft[r.id] ?? []).includes(p);
                        const dirty = !locked && on !== r.permissions.includes(p);
                        return (
                          <TableCell key={r.id} data-dirty={dirty || undefined} className="border-b py-1.5 text-center data-[dirty]:bg-accent">
                            <Checkbox
                              checked={on}
                              disabled={!editable || locked || busy}
                              aria-label={`${r.name}: ${label}`}
                              onCheckedChange={(v) => setDraft((d) => toggle(d, r.id, p, v === true))}
                            />
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <LockIcon className="size-3.5" aria-hidden="true" />
          Org admin always keeps every permission so the org can't lock itself out.
        </span>
        <span>Every change is written to the audit log.</span>
        <span className="grow" />
        {editable ? (
          <>
            {pending.length > 0 && <span className="text-foreground">{pending.length} unsaved</span>}
            <Button type="button" size="sm" variant="ghost" disabled={busy || pending.length === 0} onClick={() => setDraft(draftFrom(roles))}>
              Discard
            </Button>
            <Button type="button" size="sm" disabled={busy || pending.length === 0} onClick={save}>
              {busy ? 'Saving…' : 'Save roles'}
            </Button>
          </>
        ) : (
          <span>Read-only: editing roles needs "Manage members and roles".</span>
        )}
      </div>
      {error && (
        <div className="px-4 pb-3">
          <ErrorAlert onDismiss={() => setError(null)}>{error}</ErrorAlert>
        </div>
      )}
    </SectionCard>
  );
}

const TEMPLATE_OPTIONS = [...BUILTIN_ROLE_IDS.map((t) => ({ value: t, label: ROLE_TEMPLATES[t].name })), { value: 'blank', label: 'Blank' }];

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
      <Label htmlFor={id} className="text-[13px] font-normal text-muted-foreground">
        New role
      </Label>
      <Input
        id={id}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Leadership"
        maxLength={60}
        aria-invalid={taken || undefined}
        className={cn('h-8 w-36 text-[13px]')}
      />
      <LabeledSelect label="from template" value={template} onValueChange={setTemplate} options={TEMPLATE_OPTIONS} />
      <Button type="submit" size="sm" variant="outline" disabled={busy || !name.trim() || taken}>
        <PlusIcon />
        Create role
      </Button>
      {taken && <span className="text-xs text-destructive">Name in use</span>}
    </form>
  );
}
