/**
 * Settings (canvas: Settings.dc.html), as shadcn Tabs synced to ?tab=:
 *   - Members: everyone in the org with their roles, and "Invite member" (manage_members).
 *   - Roles: permissions matrix (pages × roles, actions × roles), create a role from a template,
 *     reset or delete roles, and the latest role changes from the audit log.
 *   - Bindings: who has which role, at the org or one project; assign and remove.
 *   - Project: name, owner, target and size tier of the current project.
 *   - Audit log: every audited change, paged.
 * Viewing needs the "settings" page; edits need manage_members (members, roles, bindings) or
 * manage_projects (project). Controls for missing permissions are hidden or read-only, and the
 * server enforces every permission anyway.
 */
import { useSearchParams } from 'react-router';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/useApi';
import { useProject } from '@/project';
import { RolesMatrix } from './e-parts/RolesMatrix';
import { AuditCard, BindingsCard, MembersCard, ProjectSettings, SectionSkeleton } from './e-parts/SettingsParts';
import { usePaged } from './e-parts/usePaged';

const TABS = ['members', 'roles', 'bindings', 'project', 'audit'] as const;
type Tab = (typeof TABS)[number];

export default function Settings() {
  const { me, can } = useAuth();
  const { projectId, project, projects, reload: reloadProjects } = useProject();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('tab') ?? '') ? (sp.get('tab') as Tab) : 'members';
  const setTab = (t: string) => {
    const n = new URLSearchParams(sp);
    if (t === 'members') n.delete('tab');
    else n.set('tab', t);
    setSp(n, { replace: true });
  };

  const roles = useApi((s) => api.roles(s), []);
  const bindings = useApi((s) => api.bindings(undefined, s), []);
  const members = useApi((s) => api.members(s), []);
  const audit = usePaged((cursor, s) => api.audit({ limit: 200, ...(cursor ? { cursor } : {}) }, s), []);
  const proj = useApi((s) => (projectId ? api.project(projectId, s) : Promise.resolve(null)), [projectId]);

  const manageMembers = can('manage_members');
  const crumbs = [{ label: me?.org?.name ?? 'Organization', to: '/' }, { label: 'Settings' }];

  const afterRbacChange = () => {
    roles.reload();
    bindings.reload();
    members.reload();
    audit.reload();
  };

  return (
    <>
      <PageHeader crumbs={crumbs} title="Settings" meta={me?.org?.name} />
      <Tabs value={tab} onValueChange={setTab} className="gap-0">
        <div className="overflow-x-auto border-b px-4 py-2">
          <TabsList aria-label="Settings sections">
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="bindings">Bindings</TabsTrigger>
            <TabsTrigger value="project" disabled={!projectId}>
              Project{project ? ` · ${project.name}` : ''}
            </TabsTrigger>
            <TabsTrigger value="audit">Audit log</TabsTrigger>
          </TabsList>
        </div>
        <div className="flex flex-col gap-4 px-4 py-4">
          <TabsContent value="members" className="flex flex-col gap-4">
            {members.loading && !members.data ? (
              <SectionSkeleton label="Loading members…" />
            ) : members.error ? (
              <ErrorState error={members.error} onRetry={members.reload} />
            ) : (
              <MembersCard
                members={members.data?.items ?? []}
                roles={roles.data?.items ?? []}
                projects={projects}
                canInvite={manageMembers}
                onInvited={afterRbacChange}
              />
            )}
          </TabsContent>
          <TabsContent value="roles" className="flex flex-col gap-4">
            <p className="max-w-3xl text-[13px] leading-[18px] text-muted-foreground">
              Access is role-based. A role is a set of permissions; you assign roles to people or SSO groups, at the whole org or at one project. Built-in roles are starting
              templates: edit them, reset them, or make new roles from them.
            </p>
            {roles.loading && !roles.data ? (
              <SectionSkeleton label="Loading roles…" rows={8} />
            ) : roles.error ? (
              <ErrorState error={roles.error} onRetry={roles.reload} />
            ) : roles.data ? (
              <RolesMatrix data={roles.data} editable={manageMembers} onChanged={afterRbacChange} />
            ) : null}
            <AuditCard audit={audit} members={members.data?.items ?? []} compact />
          </TabsContent>
          <TabsContent value="bindings" className="flex flex-col gap-4">
            {bindings.loading && !bindings.data ? (
              <SectionSkeleton label="Loading role bindings…" />
            ) : bindings.error ? (
              <ErrorState error={bindings.error} onRetry={bindings.reload} />
            ) : (
              <BindingsCard
                bindings={bindings.data?.items ?? []}
                roles={roles.data?.items ?? []}
                members={members.data?.items ?? []}
                projects={projects}
                editable={manageMembers}
                onChanged={afterRbacChange}
              />
            )}
          </TabsContent>
          <TabsContent value="project">
            {!projectId ? (
              <EmptyState title="No project" description="Create or open a project first." />
            ) : proj.loading && !proj.data ? (
              <SectionSkeleton label="Loading project…" />
            ) : proj.error ? (
              <ErrorState error={proj.error} onRetry={proj.reload} />
            ) : proj.data ? (
              <ProjectSettings
                key={`${proj.data.id}:${proj.data.updatedAt}`}
                project={proj.data}
                editable={can('manage_projects', proj.data.id)}
                onSaved={() => {
                  proj.reload();
                  audit.reload();
                  reloadProjects();
                }}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="audit">
            <AuditCard audit={audit} members={members.data?.items ?? []} />
          </TabsContent>
        </div>
      </Tabs>
    </>
  );
}
