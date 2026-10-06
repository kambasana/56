/**
 * Settings sub-sections: members (with the invite dialog), role bindings (who has which role),
 * the audit log and the project tier editor. All writes go through the API, which enforces
 * permissions and audits. Built from shadcn/ui components only.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { KeyRoundIcon, MailPlusIcon, UserPlusIcon } from 'lucide-react';
import type {
  AuditEntry,
  CreateBindingRequest,
  InviteMemberRequest,
  InviteMemberResponse,
  ListBindingsResponse,
  ListMembersResponse,
  ProjectRef,
  ProjectRow,
  Role,
  SizeTier,
  TierSettings,
} from '@server/api-types';
import { SIZE_TIERS, TIER_DEFAULTS } from '@server/api-types';
import { api, isApiError, request } from '@/api';
import { Badge } from '@/components/Badge';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { SidePanel } from '@/components/SidePanel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { fmtTime } from '@/lib/cn';
import { cn } from '@/lib/utils';
import { describeAudit } from './rbac';
import { inviteLink } from '../AcceptInvite';
import { ConfirmButton, CopyButton, ErrorAlert, LabeledSelect, SectionCard, errorText, type Option } from './ui';
import type { PagedState } from './usePaged';

type BindingItem = ListBindingsResponse['items'][number];
type MemberRow = ListMembersResponse['items'][number];

/** Skeleton rows for a section that is still loading. */
export function SectionSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2 p-4">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-5', i === 0 ? 'w-1/3' : 'w-full')} />
      ))}
    </div>
  );
}

function scopeOptions(projects: ProjectRef[]): Option[] {
  return [{ value: 'org', label: 'Organization' }, ...projects.map((p) => ({ value: p.id, label: `Project · ${p.name}` }))];
}

function scopeOf(v: string): CreateBindingRequest['scope'] {
  return v === 'org' ? { kind: 'org' } : { kind: 'project', projectId: v };
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export function BindingsCard({ bindings, roles, members, projects, editable, onChanged }: {
  bindings: BindingItem[];
  roles: Role[];
  members: MemberRow[];
  projects: ProjectRef[];
  editable: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const columns = useMemo<ColumnDef<BindingItem, any>[]>(
    () => [
      { id: 'who', accessorFn: (b) => b.subjectLabel, header: 'Who', cell: ({ getValue }) => <span className="font-mono">{getValue()}</span> },
      { id: 'role', accessorFn: (b) => b.roleName, header: 'Role', meta: { facet: {} }, cell: ({ getValue }) => <Badge variant="secondary">{getValue()}</Badge> },
      { id: 'scope', accessorFn: (b) => (b.scope.kind === 'org' ? 'Organization' : `Project · ${b.scopeLabel}`), header: 'Scope' },
      { id: 'source', accessorFn: (b) => (b.subject.kind === 'user' ? 'Person' : 'SSO group'), header: 'Source', meta: { facet: {} } },
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
              cell: ({ row }: { row: { original: BindingItem } }) => (
                <ConfirmButton
                  ariaLabel={`Remove ${row.original.roleName} from ${row.original.subjectLabel}`}
                  disabled={busy}
                  title={`Remove ${row.original.roleName} from ${row.original.subjectLabel}?`}
                  description={`${row.original.subjectLabel} loses the permissions of this role ${row.original.scope.kind === 'org' ? 'across the organization' : `in ${row.original.scopeLabel}`}. The change is written to the audit log.`}
                  confirmLabel="Remove role"
                  onConfirm={() => void run(() => api.deleteBinding(row.original.id), `Removed ${row.original.roleName} from ${row.original.subjectLabel}.`)}
                >
                  Remove
                </ConfirmButton>
              ),
            } satisfies ColumnDef<BindingItem, any>,
          ]
        : []),
    ],
    [editable, busy],
  );

  return (
    <SectionCard
      title="Who has which role"
      description="Assign roles to members or SSO groups, at the whole org or a single project. A person with several roles gets the union of their permissions."
      contentClassName="flex flex-col"
    >
      {editable && <AssignForm roles={roles} members={members} projects={projects} busy={busy} onAssign={(body, label) => run(() => api.createBinding(body), label)} />}
      {error && (
        <div className="px-4 pt-3">
          <ErrorAlert onDismiss={() => setError(null)}>{error}</ErrorAlert>
        </div>
      )}
      <DataTable label="Role bindings" data={bindings} columns={columns} getRowId={(b) => b.id} filterPlaceholder="Filter bindings…" emptyTitle="No role bindings" />
    </SectionCard>
  );
}

/**
 * Assign a role. People are limited to existing members of the org (the server refuses anyone
 * else); new people join through "Invite member".
 */
function AssignForm({ roles, members, projects, busy, onAssign }: {
  roles: Role[];
  members: MemberRow[];
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
      scope: scopeOf(scope),
    };
    const who = subjectKind === 'user' ? (user?.email ?? userId) : `group:${group.trim()}`;
    onAssign(body, `Assigned ${role.name} to ${who}.`);
  };
  return (
    <form onSubmit={submit} aria-label="Assign role" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      <LabeledSelect
        label="Assign to"
        value={subjectKind}
        onValueChange={(v) => setSubjectKind(v === 'group' ? 'group' : 'user')}
        options={[
          { value: 'user', label: 'Member' },
          { value: 'group', label: 'SSO group' },
        ]}
      />
      {subjectKind === 'user' ? (
        <LabeledSelect
          label="Person"
          hideLabel
          value={userId}
          onValueChange={setUserId}
          placeholder={members.length ? 'Choose a member…' : 'No members yet'}
          disabled={members.length === 0}
          className="min-w-[220px]"
          options={members.map((m) => ({ value: m.id, label: `${m.name} · ${m.email}` }))}
        />
      ) : (
        <>
          <Label htmlFor={groupId} className="sr-only">
            SSO group
          </Label>
          <Input id={groupId} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="group name" maxLength={100} className="h-8 w-40 font-mono text-[13px]" />
        </>
      )}
      <LabeledSelect label="Role" value={roleId} onValueChange={setRoleId} placeholder="Choose…" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
      <LabeledSelect label="Scope" value={scope} onValueChange={setScope} options={scopeOptions(projects)} />
      <Button type="submit" size="sm" disabled={busy || !ready}>
        Assign role
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export function MembersCard({ members, roles, projects, canInvite, onInvited }: {
  members: MemberRow[];
  roles: Role[];
  projects: ProjectRef[];
  canInvite: boolean;
  onInvited: () => void;
}) {
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
        enableSorting: false,
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
    <SectionCard
      title="Members"
      description="People in this organization and the roles bound to them."
      action={canInvite ? <InviteDialog roles={roles} projects={projects} onInvited={onInvited} /> : undefined}
      contentClassName="flex"
    >
      <DataTable label="Members" data={members} columns={columns} getRowId={(m) => m.id} filterPlaceholder="Filter members…" emptyTitle="No members" />
    </SectionCard>
  );
}

/**
 * "Invite member": POST /api/members with one initial role binding. The response's one-time
 * password (dev mode) or invite token is shown once, with a copy button, and never stored.
 */
export function InviteDialog({ roles, projects, onInvited }: { roles: Role[]; projects: ProjectRef[]; onInvited: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState('org');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; fields: string[] } | null>(null);
  const [result, setResult] = useState<InviteMemberResponse | null>(null);
  const ids = { email: useId(), name: useId() };

  const reset = () => {
    setEmail('');
    setName('');
    setRoleId('');
    setScope('org');
    setError(null);
    setResult(null);
  };

  const ready = Boolean(email.trim() && name.trim() && roleId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const body: InviteMemberRequest = { email: email.trim(), name: name.trim(), bindings: [{ roleId, scope: scopeOf(scope) }] };
    try {
      const res = await request<InviteMemberResponse>('POST', '/api/members', body);
      setResult(res);
      toast.success(res.member ? `Invited ${res.member.email}.` : `Invite created for ${res.invite?.email ?? body.email}.`);
      onInvited();
    } catch (err) {
      setError({ text: errorText(err), fields: isApiError(err) ? err.fields : [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlusIcon />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {result ? (
          <InviteResult result={result} />
        ) : (
          <form onSubmit={submit} aria-label="Invite member" className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invite member</DialogTitle>
              <DialogDescription>Add someone to this organization with a first role. You can only grant roles whose permissions you hold.</DialogDescription>
            </DialogHeader>
            <FieldGroup className="gap-4">
              <Field data-invalid={error?.fields.includes('email') || undefined}>
                <FieldLabel htmlFor={ids.email}>Email</FieldLabel>
                <Input id={ids.email} type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} placeholder="name@company.com" />
              </Field>
              <Field data-invalid={error?.fields.includes('name') || undefined}>
                <FieldLabel htmlFor={ids.name}>Name</FieldLabel>
                <Input id={ids.name} required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Full name" />
              </Field>
              <div className="flex flex-wrap gap-3">
                <LabeledSelect label="Role" value={roleId} onValueChange={setRoleId} placeholder="Choose…" size="default" options={roles.map((r) => ({ value: r.id, label: r.name }))} />
                <LabeledSelect label="Scope" value={scope} onValueChange={setScope} size="default" options={scopeOptions(projects)} />
              </div>
            </FieldGroup>
            {error && <ErrorAlert>{error.text}</ErrorAlert>}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy || !ready}>
                <MailPlusIcon />
                {busy ? 'Inviting…' : 'Send invite'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InviteResult({ result }: { result: InviteMemberResponse }) {
  const secretId = useId();
  const secret = result.oneTimePassword
    ? { label: 'One-time password', value: result.oneTimePassword, hint: 'Dev mode: hand this password to the person; they sign in with it.' }
    : result.invite
      ? {
          label: 'Invite link',
          value: inviteLink(window.location.origin, result.invite.token),
          hint: `Single use, expires ${fmtTime(result.invite.expiresAt)}. Inviting the same email again replaces this link.`,
        }
      : null;
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{result.member ? 'Member invited' : 'Invite created'}</DialogTitle>
        <DialogDescription>
          {result.member
            ? `${result.member.name} (${result.member.email}) now has an account in this organization.`
            : `Send this link to ${result.invite?.name ?? ''} (${result.invite?.email ?? ''}). They join, with the role you chose, when they open it and set a password, or confirm the password of the account they already have.`}
        </DialogDescription>
      </DialogHeader>
      {secret && (
        <Field>
          <FieldLabel htmlFor={secretId}>
            <KeyRoundIcon className="size-4" aria-hidden="true" />
            {secret.label}
          </FieldLabel>
          <div className="flex items-center gap-2">
            <Input id={secretId} readOnly value={secret.value} className="font-mono text-[13px]" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton value={secret.value} label={`Copy ${secret.label.toLowerCase()}`} />
          </div>
          <FieldDescription>{secret.hint} It is shown only once: copy it now.</FieldDescription>
        </Field>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button">Done</Button>
        </DialogClose>
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export function AuditCard({ audit, members, compact }: { audit: PagedState<AuditEntry>; members: MemberRow[]; compact?: boolean }) {
  const who = useMemo(() => new Map(members.map((m) => [m.id, m.email] as const)), [members]);
  const columns = useMemo<ColumnDef<AuditEntry, any>[]>(
    () => [
      { id: 'at', accessorFn: (a) => a.at, header: 'When', cell: ({ getValue }) => <span className="font-mono text-xs whitespace-nowrap">{fmtTime(getValue())}</span> },
      { id: 'actor', accessorFn: (a) => who.get(a.actor) ?? a.actor, header: 'Who', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> },
      { id: 'action', accessorFn: (a) => a.action, header: 'Action', meta: compact ? undefined : { facet: {} }, cell: ({ getValue }) => <Badge variant="outline">{getValue()}</Badge> },
      { id: 'what', accessorFn: (a) => describeAudit(a.action, a.target, a.detail), header: 'What' },
      ...(compact
        ? []
        : [{ id: 'target', accessorFn: (a: AuditEntry) => a.target, header: 'Target', cell: ({ getValue }: { getValue: () => unknown }) => <span className="font-mono text-xs">{String(getValue())}</span> }]),
    ],
    [who, compact],
  );
  const items = compact ? audit.items.filter((a) => a.action.startsWith('role.') || a.action.startsWith('binding.')).slice(0, 8) : audit.items;
  return (
    <SectionCard
      title={compact ? 'Recent role changes' : 'Audit log'}
      description={compact ? 'From the audit log. Every role and binding change is recorded.' : 'Every change to projects, scans, findings, members, roles and bindings, newest first.'}
      contentClassName="flex flex-col"
    >
      {audit.error && audit.items.length === 0 ? (
        <div className="p-4">
          <ErrorAlert title="Could not load the audit log">
            {audit.error.message}{' '}
            <Button variant="link" size="xs" className="h-auto p-0" onClick={audit.reload}>
              Retry
            </Button>
          </ErrorAlert>
        </div>
      ) : (
        <DataTable
          label={compact ? 'Recent role changes' : 'Audit log'}
          data={items}
          columns={columns}
          loading={audit.loading && audit.items.length === 0}
          getRowId={(a) => a.id}
          filterable={!compact}
          columnToggle={!compact}
          total={compact ? undefined : audit.total}
          filterPlaceholder="Filter entries…"
          emptyTitle="No entries yet"
          toolbar={
            !compact && audit.hasMore ? (
              <Button size="sm" variant="outline" onClick={audit.loadMore} disabled={audit.loading}>
                {audit.loading ? 'Loading…' : 'Load more'}
              </Button>
            ) : undefined
          }
          renderPanel={
            compact
              ? undefined
              : (a, close) => (
                  <SidePanel
                    label="Audit entry"
                    eyebrow={
                      <span>
                        {fmtTime(a.at)} · {who.get(a.actor) ?? a.actor}
                      </span>
                    }
                    title={a.action}
                    onClose={close}
                  >
                    <p className="mb-3">{describeAudit(a.action, a.target, a.detail)}</p>
                    <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">{JSON.stringify(a.detail, null, 2)}</pre>
                  </SidePanel>
                )
          }
        />
      )}
    </SectionCard>
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
  const [error, setError] = useState<{ text: string; fields: string[] } | null>(null);
  const ids = { name: useId(), owner: useId(), target: useId() };
  const dirty = name !== project.name || owner !== (project.owner ?? '') || target !== project.target || tier !== project.tier;
  const eff = { ...TIER_DEFAULTS[tier], ...project.tierOverrides };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editable || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateProject(project.id, {
        ...(name !== project.name ? { name: name.trim() } : {}),
        ...(owner !== (project.owner ?? '') ? { owner: owner.trim() || null } : {}),
        ...(target !== project.target ? { target: target.trim() } : {}),
        ...(tier !== project.tier ? { tier } : {}),
      });
      toast.success('Project saved. The change is in the audit log.');
      onSaved();
    } catch (err) {
      setError({ text: errorText(err), fields: isApiError(err) ? err.fields : [] });
    } finally {
      setBusy(false);
    }
  };

  const invalid = (f: string) => error?.fields.includes(f) || undefined;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Project settings">
      <SectionCard title="Project" description="Name, owner and what Blastradius scans." contentClassName="p-4">
        <FieldGroup className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          <Field data-invalid={invalid('name')}>
            <FieldLabel htmlFor={ids.name}>Project name</FieldLabel>
            <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} maxLength={120} aria-invalid={invalid('name')} />
          </Field>
          <Field data-invalid={invalid('owner')}>
            <FieldLabel htmlFor={ids.owner}>Owner</FieldLabel>
            <Input id={ids.owner} value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!editable} maxLength={200} placeholder="Team · person" aria-invalid={invalid('owner')} />
          </Field>
          <Field data-invalid={invalid('target')}>
            <FieldLabel htmlFor={ids.target}>Scan target</FieldLabel>
            <Input id={ids.target} value={target} onChange={(e) => setTarget(e.target.value)} disabled={!editable} maxLength={2048} className="font-mono" aria-invalid={invalid('target')} />
            <FieldDescription>https git URL (GitHub, GitLab, Bitbucket) or an allowed local path</FieldDescription>
          </Field>
        </FieldGroup>
      </SectionCard>
      <SectionCard
        title="Size tier"
        description="Sets how deep and how often Blastradius scans, how long history is kept, and how the graph renders. Change it any time."
        contentClassName="flex flex-col gap-3 p-4"
      >
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={2}
          aria-label="Size tier"
          value={tier}
          disabled={!editable}
          onValueChange={(v) => v && setTier(v as SizeTier)}
          className="grid w-full grid-cols-[repeat(auto-fill,minmax(200px,1fr))]"
        >
          {SIZE_TIERS.map((t) => (
            <ToggleGroupItem key={t} value={t} className="h-auto flex-col items-start gap-1 p-3 text-left whitespace-normal data-[state=on]:border-primary data-[state=on]:ring-1 data-[state=on]:ring-primary">
              <span className="flex w-full items-baseline justify-between gap-2">
                <span className="font-semibold">{t}</span>
                <span className="font-mono text-xs text-muted-foreground">{TIER_DEFAULTS[t].repoRange}</span>
              </span>
              <span className="text-xs font-normal text-muted-foreground">{TIER_DEFAULTS[t].fit}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="overflow-hidden rounded-md border">
          <Table aria-label={`${tier} tier settings`} className="text-[13px]">
            <TableHeader className="bg-muted">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="h-8 px-4 text-xs text-muted-foreground">
                  Setting
                </TableHead>
                <TableHead scope="col" className="h-8 text-xs text-muted-foreground">
                  {tier} tier
                </TableHead>
                <TableHead scope="col" className="h-8 px-4 text-xs text-muted-foreground">
                  Effective
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TIER_ROWS.map((r) => {
                const overridden = r.key in project.tierOverrides;
                return (
                  <TableRow key={r.key}>
                    <TableHead scope="row" className="h-auto px-4 py-1.5 font-normal">
                      {r.label}
                    </TableHead>
                    <TableCell className="py-1.5 font-mono text-xs">{r.fmt(TIER_DEFAULTS[tier][r.key])}</TableCell>
                    <TableCell className="px-4 py-1.5 font-mono text-xs">
                      {r.fmt(eff[r.key])}
                      {overridden && <span className="ml-1.5 font-sans text-muted-foreground">(override)</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      {error && <ErrorAlert onDismiss={() => setError(null)}>{error.text}</ErrorAlert>}
      <div className="flex flex-wrap items-center gap-2">
        {editable ? (
          <>
            <Button type="submit" size="sm" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save project'}
            </Button>
            <Button
              type="button"
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
