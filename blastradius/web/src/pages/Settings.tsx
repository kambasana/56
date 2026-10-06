/**
 * Settings (canvas: Settings.dc.html). Tabs:
 *   - Members and roles: permissions matrix (pages × roles, actions × roles), create a role from
 *     a template, role bindings, members, and the latest role changes from the audit log.
 *   - Project: name, owner, target and size tier of the current project.
 *   - Audit log: every audited change, paged.
 * Viewing needs the "settings" page; edits need manage_members (roles, bindings) or
 * manage_projects (project). Controls for missing permissions are hidden or read-only, and the
 * server enforces every permission anyway.
 */
import { useSearchParams } from 'react-router';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { EmptyState, ErrorState, LoadingState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { useProject } from '@/project';
import { RolesMatrix } from './e-parts/RolesMatrix';
import { AuditCard, BindingsCard, MembersCard, ProjectSettings } from './e-parts/SettingsParts';
import { TabPanel, Tabs } from './e-parts/ui';
import { usePaged } from './e-parts/usePaged';

type Tab = 'members' | 'project' | 'audit';

export default function Settings() {
  const { me, can } = useAuth();
  const { projectId, project, projects, reload: reloadProjects } = useProject();
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get('tab') === 'project' ? 'project' : sp.get('tab') === 'audit' ? 'audit' : 'members';
  const setTab = (t: Tab) => {
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
      <div className="border-b px-5">
        <Tabs
          idBase="settings"
          label="Settings sections"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'members', label: 'Members and roles' },
            { id: 'project', label: `Project${project ? ` · ${project.name}` : ''}`, disabled: !projectId },
            { id: 'audit', label: 'Audit log' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        {tab === 'members' && (
          <TabPanel idBase="settings" id="members" className="flex flex-col gap-4">
            <p className="m-0 max-w-3xl text-[13px] leading-[18px] text-muted-foreground">
              Access is role-based. A role is a set of permissions; you assign roles to people or SSO groups, at the whole org or at one project. Built-in roles are starting
              templates: edit them, reset them, or make new roles from them.
            </p>
            {roles.loading && !roles.data ? (
              <LoadingState label="Loading roles…" />
            ) : roles.error ? (
              <ErrorState error={roles.error} onRetry={roles.reload} />
            ) : roles.data ? (
              <RolesMatrix data={roles.data} editable={manageMembers} onChanged={afterRbacChange} />
            ) : null}
            <AuditCard audit={audit} members={members.data?.items ?? []} compact />
            {bindings.loading && !bindings.data ? (
              <LoadingState label="Loading role bindings…" />
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
            {members.loading && !members.data ? (
              <LoadingState label="Loading members…" />
            ) : members.error ? (
              <ErrorState error={members.error} onRetry={members.reload} />
            ) : (
              <MembersCard members={members.data?.items ?? []} roles={roles.data?.items ?? []} projects={projects} />
            )}
          </TabPanel>
        )}
        {tab === 'project' && (
          <TabPanel idBase="settings" id="project">
            {!projectId ? (
              <EmptyState title="No project" description="Create or open a project first." />
            ) : proj.loading && !proj.data ? (
              <LoadingState label="Loading project…" />
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
          </TabPanel>
        )}
        {tab === 'audit' && (
          <TabPanel idBase="settings" id="audit">
            <AuditCard audit={audit} members={members.data?.items ?? []} />
          </TabPanel>
        )}
      </div>
    </>
  );
}
