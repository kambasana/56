/**
 * Settings sub-sections: role bindings (who has which role), members, audit log and the
 * project tier editor. All writes go through the API, which enforces permissions and audits.
 */
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AuditEntry,
  CreateBindingRequest,
  ListBindingsResponse,
  ListMembersResponse,
  ProjectRef,
  ProjectRow,
  Role,
  SizeTier,
  TierSettings,
} from '@server/api-types';
import { SIZE_TIERS, TIER_DEFAULTS } from '@server/api-types';
import { api, isApiError } from '@/api';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { ErrorState, LoadingState } from '@/components/EmptyState';
import { cn, fmtTime } from '@/lib/cn';
import { describeAudit } from './rbac';
import { Card, InlineAlert, Select, errorText, inputClass } from './ui';
import type { PagedState } from './usePaged';

type BindingItem = ListBindingsResponse['items'][number];

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export function BindingsCard({ bindings, roles, members, projects, editable, onChanged }: {
  bindings: BindingItem[];
  roles: Role[];
  members: ListMembersResponse['items'];
  projects: ProjectRef[];
  editable: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
    } catch (e) {
      setMsg({ tone: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const columns = useMemo<ColumnDef<BindingItem, any>[]>(
    () => [
      { id: 'who', accessorFn: (b) => b.subjectLabel, header: 'Who', cell: ({ getValue }) => <span className="font-mono">{getValue()}</span> },
      { id: 'role', accessorFn: (b) => b.roleName, header: 'Role', cell: ({ getValue }) => <Badge variant="secondary">{getValue()}</Badge> },
      { id: 'scope', accessorFn: (b) => (b.scope.kind === 'org' ? 'Organization' : `Project · ${b.scopeLabel}`), header: 'Scope' },
      { id: 'source', accessorFn: (b) => (b.subject.kind === 'user' ? 'Person' : 'SSO group'), header: 'Source' },
      { id: 'createdAt', accessorFn: (b) => b.createdAt, header: 'Since', cell: ({ getValue }) => <span className="font-mono text-xs">{fmtTime(getValue())}</span> },
      ...(editable
        ? [
            {
              id: 'actions',
              header: '',
              enableSorting: false,
              enableHiding: false,
              enableGlobalFilter: false,
              meta: { align: 'right' as const, label: 'Actions' },
              cell: ({ row }: { row: { original: BindingItem } }) =>
                confirm === row.original.id ? (
                  <span className="inline-flex gap-1 font-sans">
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        setConfirm(null);
                        void run(() => api.deleteBinding(row.original.id), `Removed ${row.original.roleName} from ${row.original.subjectLabel}.`);
                      }}
                    >
                      Confirm
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirm(row.original.id)} aria-label={`Remove ${row.original.roleName} from ${row.original.subjectLabel}`}>
                    Remove
                  </Button>
                ),
            } satisfies ColumnDef<BindingItem, any>,
          ]
        : []),
    ],
    [editable, confirm, busy],
  );

  return (
    <Card
      title="Who has which role"
      description="Assign people or SSO groups, at the whole org or a single project. A person with several roles gets the union of their permissions."
      bodyClassName="flex flex-col"
    >
      {editable && <AssignForm roles={roles} members={members} projects={projects} busy={busy} onAssign={(body, label) => run(() => api.createBinding(body), label)} />}
      {msg && (
        <div className="px-4 pt-2">
          <InlineAlert tone={msg.tone} onDismiss={() => setMsg(null)}>
            {msg.text}
          </InlineAlert>
        </div>
      )}
      <DataTable label="Role bindings" data={bindings} columns={columns} getRowId={(b) => b.id} filterPlaceholder="Filter bindings…" emptyTitle="No role bindings" />
    </Card>
  );
}

function AssignForm({ roles, members, projects, busy, onAssign }: {
  roles: Role[];
  members: ListMembersResponse['items'];
  projects: ProjectRef[];
  busy: boolean;
  onAssign: (body: CreateBindingRequest, label: string) => void;
}) {
  const [subjectKind, setSubjectKind] = useState<'user' | 'group'>('user');
  const [userId, setUserId] = useState('');
  const [group, setGroup] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState('org');
  const groupId = useId();
  const user = members.find((m) => m.id === userId);
  const role = roles.find((r) => r.id === roleId);
  const ready = Boolean(role && (subjectKind === 'user' ? user : group.trim()));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !role) return;
    const body: CreateBindingRequest = {
      roleId: role.id,
      subject: subjectKind === 'user' ? { kind: 'user', userId } : { kind: 'group', group: group.trim() },
      scope: scope === 'org' ? { kind: 'org' } : { kind: 'project', projectId: scope },
    };
    const who = subjectKind === 'user' ? (user?.email ?? userId) : `group:${group.trim()}`;
    onAssign(body, `Assigned ${role.name} to ${who}.`);
  };
  return (
    <form onSubmit={submit} aria-label="Assign role" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      <Select label="Assign to" value={subjectKind} onChange={(e) => setSubjectKind(e.target.value === 'group' ? 'group' : 'user')}>
        <option value="user">Person</option>
        <option value="group">SSO group</option>
      </Select>
      {subjectKind === 'user' ? (
        <Select label="Person" hideLabel value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a member…</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.email}
            </option>
          ))}
        </Select>
      ) : (
        <>
          <label htmlFor={groupId} className="sr-only">
            SSO group
          </label>
          <input id={groupId} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="group name" maxLength={100} className={cn(inputClass, 'w-40 font-mono')} />
        </>
      )}
      <Select label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
        <option value="">Choose…</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </Select>
      <Select label="Scope" value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="org">Organization</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            Project · {p.name}
          </option>
        ))}
      </Select>
      <Button type="submit" size="xs" disabled={busy || !ready}>
        Assign role
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

type MemberRow = ListMembersResponse['items'][number];

export function MembersCard({ members, roles, projects }: { members: MemberRow[]; roles: Role[]; projects: ProjectRef[] }) {
  const roleName = useMemo(() => new Map(roles.map((r) => [r.id, r.name] as const)), [roles]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name] as const)), [projects]);
  const columns = useMemo<ColumnDef<MemberRow, any>[]>(
    () => [
      { id: 'name', accessorFn: (m) => m.name, header: 'Name', cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> },
      { id: 'email', accessorFn: (m) => m.email, header: 'Email', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> },
      {
        id: 'roles',
        accessorFn: (m) =>
          m.bindings.map((b) => `${roleName.get(b.roleId) ?? b.roleId}${b.scope.kind === 'project' ? ` (${projectName.get(b.scope.projectId) ?? b.scope.projectId})` : ''}`).join(', '),
        header: 'Roles',
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            {row.original.bindings.length === 0 && <span className="text-muted-foreground">No roles</span>}
            {row.original.bindings.map((b) => (
              <Badge key={b.id} variant={b.scope.kind === 'org' ? 'secondary' : 'outline'}>
                {roleName.get(b.roleId) ?? b.roleId}
                {b.scope.kind === 'project' && <span className="font-normal text-muted-foreground">· {projectName.get(b.scope.projectId) ?? b.scope.projectId}</span>}
              </Badge>
            ))}
          </span>
        ),
      },
    ],
    [roleName, projectName],
  );
  return (
    <Card title="Members" description="People in this organization and the roles bound to them." bodyClassName="flex">
      <DataTable label="Members" data={members} columns={columns} getRowId={(m) => m.id} filterPlaceholder="Filter members…" emptyTitle="No members" />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export function AuditCard({ audit, members, compact }: { audit: PagedState<AuditEntry>; members: MemberRow[]; compact?: boolean }) {
  const who = useMemo(() => new Map(members.map((m) => [m.id, m.email] as const)), [members]);
  const columns = useMemo<ColumnDef<AuditEntry, any>[]>(
    () => [
      { id: 'at', accessorFn: (a) => a.at, header: 'When', cell: ({ getValue }) => <span className="whitespace-nowrap font-mono text-xs">{fmtTime(getValue())}</span> },
      { id: 'actor', accessorFn: (a) => who.get(a.actor) ?? a.actor, header: 'Who', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> },
      { id: 'action', accessorFn: (a) => a.action, header: 'Action', cell: ({ getValue }) => <Badge variant="outline">{getValue()}</Badge> },
      { id: 'what', accessorFn: (a) => describeAudit(a.action, a.target, a.detail), header: 'What' },
      ...(compact
        ? []
        : [{ id: 'target', accessorFn: (a: AuditEntry) => a.target, header: 'Target', cell: ({ getValue }: { getValue: () => unknown }) => <span className="font-mono text-xs">{String(getValue())}</span> }]),
    ],
    [who, compact],
  );
  const items = compact ? audit.items.filter((a) => a.action.startsWith('role.') || a.action.startsWith('binding.')).slice(0, 8) : audit.items;
  return (
    <Card
      title={compact ? 'Recent role changes' : 'Audit log'}
      description={compact ? 'From the audit log. Every role and binding change is recorded.' : 'Every change to projects, scans, findings, roles and bindings, newest first.'}
      bodyClassName="flex flex-col"
    >
      {audit.loading && audit.items.length === 0 ? (
        <LoadingState label="Loading audit log…" />
      ) : audit.error && audit.items.length === 0 ? (
        <ErrorState error={audit.error} onRetry={audit.reload} />
      ) : (
        <DataTable
          label={compact ? 'Recent role changes' : 'Audit log'}
          data={items}
          columns={columns}
          getRowId={(a) => a.id}
          filterable={!compact}
          columnToggle={!compact}
          total={compact ? undefined : audit.total}
          filterPlaceholder="Filter entries…"
          emptyTitle="No entries yet"
          toolbar={
            !compact && audit.hasMore ? (
              <Button size="xs" variant="outline" onClick={audit.loadMore} disabled={audit.loading}>
                {audit.loading ? 'Loading…' : 'Load more'}
              </Button>
            ) : undefined
          }
          renderPanel={
            compact
              ? undefined
              : (a, close) => (
                  <AuditPanel entry={a} actor={who.get(a.actor) ?? a.actor} onClose={close} />
                )
          }
        />
      )}
    </Card>
  );
}

function AuditPanel({ entry, actor, onClose }: { entry: AuditEntry; actor: string; onClose: () => void }) {
  return (
    <aside aria-label="Audit entry" className="flex min-w-0 flex-[1_1_360px] flex-col border-l lg:max-w-[480px]">
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="flex grow flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            {fmtTime(entry.at)} · {actor}
          </span>
          <h2 className="m-0 font-mono text-[15px] font-semibold">{entry.action}</h2>
          <span className="text-[13px]">{describeAudit(entry.action, entry.target, entry.detail)}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close panel" className="size-7 cursor-pointer rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent">
          ×
        </button>
      </div>
      <pre className="m-0 min-h-0 grow overflow-auto px-4 py-3 font-mono text-xs leading-5">{JSON.stringify(entry.detail, null, 2)}</pre>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Project tier
// ---------------------------------------------------------------------------

const TIER_ROWS: { key: keyof TierSettings; label: string; fmt: (v: TierSettings[keyof TierSettings]) => string }[] = [
  { key: 'scanCadence', label: 'Scan cadence', fmt: (v) => String(v) },
  { key: 'dependencyDepth', label: 'Dependency depth', fmt: (v) => (v === null ? 'Full (all transitive)' : `Depth ${v}`) },
  { key: 'includeDevDependencies', label: 'Dev dependencies', fmt: (v) => (v ? 'Included' : 'Excluded') },
  { key: 'retentionDays', label: 'History retention', fmt: (v) => `${v} days` },
  { key: 'graphNodeCap', label: 'Graph node cap', fmt: (v) => `${v} nodes` },
  { key: 'entityHops', label: 'Entity hops', fmt: (v) => `${v}` },
];

export function ProjectSettings({ project, editable, onSaved }: { project: ProjectRow; editable: boolean; onSaved: () => void }) {
  const [name, setName] = useState(project.name);
  const [owner, setOwner] = useState(project.owner ?? '');
  const [target, setTarget] = useState(project.target);
  const [tier, setTier] = useState<SizeTier>(project.tier);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'success'; text: string; fields?: string[] } | null>(null);
  const ids = { name: useId(), owner: useId(), target: useId() };
  const dirty = name !== project.name || owner !== (project.owner ?? '') || target !== project.target || tier !== project.tier;
  const eff = { ...TIER_DEFAULTS[tier], ...project.tierOverrides };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editable || !dirty) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.updateProject(project.id, {
        ...(name !== project.name ? { name: name.trim() } : {}),
        ...(owner !== (project.owner ?? '') ? { owner: owner.trim() || null } : {}),
        ...(target !== project.target ? { target: target.trim() } : {}),
        ...(tier !== project.tier ? { tier } : {}),
      });
      setMsg({ tone: 'success', text: 'Project saved. The change is in the audit log.' });
      onSaved();
    } catch (err) {
      setMsg({ tone: 'error', text: errorText(err), fields: isApiError(err) ? err.fields : [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Project settings">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        <Field id={ids.name} label="Project name" invalid={msg?.fields?.includes('name')}>
          <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} maxLength={120} className={cn(inputClass, 'w-full')} />
        </Field>
        <Field id={ids.owner} label="Owner" invalid={msg?.fields?.includes('owner')}>
          <input id={ids.owner} value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!editable} maxLength={200} placeholder="Team · person" className={cn(inputClass, 'w-full')} />
        </Field>
        <Field id={ids.target} label="Scan target" hint="https git URL (GitHub, GitLab, Bitbucket) or an allowed local path" invalid={msg?.fields?.includes('target')}>
          <input id={ids.target} value={target} onChange={(e) => setTarget(e.target.value)} disabled={!editable} maxLength={2048} className={cn(inputClass, 'w-full font-mono')} />
        </Field>
      </div>
      <section aria-labelledby="tier-h" className="flex flex-col gap-2.5">
        <div>
          <h2 id="tier-h" className="m-0 text-sm font-semibold">
            Size tier
          </h2>
          <p className="m-0 text-[13px] text-muted-foreground">Sets how deep and how often Blastradius scans, how long history is kept, and how the graph renders. Change it any time.</p>
        </div>
        <div role="radiogroup" aria-label="Size tier" className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
          {SIZE_TIERS.map((t) => {
            const on = t === tier;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!editable}
                onClick={() => setTier(t)}
                onKeyDown={(e) => {
                  const i = SIZE_TIERS.indexOf(tier);
                  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
                  if (!d) return;
                  e.preventDefault();
                  const next = SIZE_TIERS[(i + d + SIZE_TIERS.length) % SIZE_TIERS.length]!;
                  setTier(next);
                  (e.currentTarget.parentElement?.querySelector(`[data-tier="${next}"]`) as HTMLElement | null)?.focus();
                }}
                tabIndex={on ? 0 : -1}
                data-tier={t}
                className={cn(
                  'flex cursor-pointer flex-col items-start gap-1 rounded-lg bg-card p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default',
                  on ? 'border-2 border-foreground' : 'border',
                )}
              >
                <span className="flex w-full items-baseline justify-between gap-2">
                  <span className="font-semibold">{t}</span>
                  <span className="font-mono text-xs text-muted-foreground">{TIER_DEFAULTS[t].repoRange}</span>
                </span>
                <span className="text-xs text-muted-foreground">{TIER_DEFAULTS[t].fit}</span>
              </button>
            );
          })}
        </div>
        <div className="overflow-auto rounded-lg border">
          <table aria-label={`${tier} tier settings`} className="w-full border-collapse text-[13px]">
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="border-b px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                  Setting
                </th>
                <th scope="col" className="border-b px-2 py-2 text-left text-xs font-medium text-muted-foreground">
                  {tier} tier
                </th>
                <th scope="col" className="border-b px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                  Effective
                </th>
              </tr>
            </thead>
            <tbody>
              {TIER_ROWS.map((r) => {
                const overridden = r.key in project.tierOverrides;
                return (
                  <tr key={r.key} className="border-b last:border-b-0">
                    <th scope="row" className="px-4 py-1.5 text-left font-normal">
                      {r.label}
                    </th>
                    <td className="px-2 py-1.5 font-mono text-xs">{r.fmt(TIER_DEFAULTS[tier][r.key])}</td>
                    <td className="px-4 py-1.5 font-mono text-xs">
                      {r.fmt(eff[r.key])}
                      {overridden && <span className="ml-1.5 font-sans text-muted-foreground">(override)</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {msg && (
        <InlineAlert tone={msg.tone} onDismiss={() => setMsg(null)}>
          {msg.text}
        </InlineAlert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <>
            <Button type="submit" size="sm" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save project'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !dirty}
              onClick={() => {
                setName(project.name);
                setOwner(project.owner ?? '');
                setTarget(project.target);
                setTier(project.tier);
              }}
            >
              Discard
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Read-only: changing projects needs "Manage projects, tiers and scans".</span>
        )}
      </div>
    </form>
  );
}

function Field({ id, label, hint, invalid, children }: { id: string; label: string; hint?: string; invalid?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={cn('text-[13px] font-medium', invalid && 'text-destructive')}>
        {label}
      </label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
